/**
 * @fileoverview Weather validation Lambda: nightly checks, alerts, and fallback venue discovery.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

'use strict';

const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { LocationClient, SearchPlaceIndexForTextCommand } = require('@aws-sdk/client-location');
const fetch = require('node-fetch');

// [Review #1] Scatter-gather over the sharded trip GSI partitions
const { queryTripsByStartRange } = require('../lib/trips-index');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});
const location = new LocationClient({});

const TABLE_NAME      = process.env.TABLE_NAME;
const ALERTS_TOPIC_ARN = process.env.ALERTS_TOPIC_ARN;
const PLACE_INDEX_NAME = process.env.PLACE_INDEX_NAME;

// ─── Thresholds — tweak these without touching any logic ─────────────────────

// Precipitation probability (0–1)
const RAIN_PROB_OUTDOOR = 0.50;  // general outdoor activities (≥50% → alert)
const RAIN_PROB_BEACH   = 0.30;  // beach trips are stricter (≥30% → alert)

// Temperature (°C)
const HEAT_ALERT_C    = 35;  // dangerous heat for ANY outdoor activity
const BEACH_MIN_C     = 24;  // below this = too cold for beach
const SKI_WARM_MAX_C  = 5;   // above this without snow forecast = poor ski conditions

// Wind speed
const KMH_PER_KNOT          = 1.852;
const WIND_ALERT_KNOTS      = 10;  // general outdoor — uncomfortable/dangerous
const WIND_GUST_ALERT_KNOTS = 15;  // general outdoor — uncomfortable/dangerous
const SKI_WIND_ALERT_KNOTS  = 20;  // ski lifts may be suspended
const SKI_WIND_GUST_ALERT_KNOTS = 25;  // ski lifts may be suspended
const SCENIC_CLOUD_ALERT_OKTAS = 6;  // scenic visibility alert threshold

// Fallback indoor suggestions (used when an alert fires for an outdoor slot)
const FALLBACK_SEARCH_TERMS = ['museum', 'gallery', 'shopping mall', 'cinema', 'aquarium'];

// ─── Activity keywords ────────────────────────────────────────────────────────

const SKI_KEYWORDS    = ['ski', 'skiing', 'snowboard', 'snowboarding', 'slopes', 'piste'];
const BEACH_KEYWORDS  = ['beach', 'coast', 'coastal', 'shore', 'snorkel', 'surf', 'sunbath', 'sunbathe', 'swim', 'swimming', 'waterpark', 'water park'];
const SCENIC_VIEW_KEYWORDS = [
  'viewpoint', 'lookout', 'observation deck', 'observatory',
  'panorama', 'panoramic', 'scenic', 'summit', 'mountain view',
  'tower', 'cable car', 'gondola', 'ropeway', 'funicular',
];
const INDOOR_KEYWORDS = [
  'museum', 'gallery', 'mall', 'cinema', 'theater', 'theatre',
  'restaurant', 'cafe', 'bar', 'pub', 'hotel', 'airport',
  'train station', 'aquarium', 'shopping', 'spa', 'indoor',
];
const MANUAL_ACTIVITY_TYPES = new Set(['GENERAL_OUTDOOR', 'INDOOR', 'BEACH', 'SKI', 'SCENIC_VIEW']);

// ─── WMO weather interpretation codes ────────────────────────────────────────

function wmoToCondition(code) {
  if (code === 0)  return { condition: 'Clear',        description: 'clear sky' };
  if (code === 1)  return { condition: 'Clouds',       description: 'mainly clear' };
  if (code === 2)  return { condition: 'Clouds',       description: 'partly cloudy' };
  if (code === 3)  return { condition: 'Clouds',       description: 'overcast' };
  if (code <= 48)  return { condition: 'Mist',         description: 'fog' };
  if (code <= 55)  return { condition: 'Drizzle',      description: 'drizzle' };
  if (code <= 67)  return { condition: 'Rain',         description: code <= 65 ? 'rain' : 'freezing rain' };
  if (code <= 77)  return { condition: 'Snow',         description: 'snow' };
  if (code <= 82)  return { condition: 'Rain',         description: 'rain showers' };
  if (code <= 86)  return { condition: 'Snow',         description: 'snow showers' };
  if (code <= 99)  return { condition: 'Thunderstorm', description: 'thunderstorm' };
  return { condition: 'Unknown', description: '' };
}

// ─── Open-Meteo fetch ─────────────────────────────────────────────────────────

async function fetchForecast(lat, lon) {
  const url = [
    'https://api.open-meteo.com/v1/forecast',
    `?latitude=${lat}&longitude=${lon}`,
    '&hourly=temperature_2m,apparent_temperature,weathercode,windspeed_10m,wind_gusts_10m,relativehumidity_2m,precipitation_probability,cloud_cover',
    '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    '&wind_speed_unit=kn',
    '&timezone=auto&forecast_days=16',
  ].join('');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  return res.json();
}

function windToKnots(value, unit) {
  if (value == null) return null;
  const normalizedUnit = String(unit || '').toLowerCase();
  if (normalizedUnit.includes('km/h')) return value / KMH_PER_KNOT;
  return value;
}

function normalizeCloudCover(value) {
  if (value == null) return { cloudCoverPercent: null, cloudCoverOktas: null };
  const cloudCoverPercent = Math.round(value);
  return {
    cloudCoverPercent,
    cloudCoverOktas: Math.round(cloudCoverPercent / 12.5),
  };
}

// ─── Forecast lookup ──────────────────────────────────────────────────────────
// Returns the best hourly or daily reading for a given Unix timestamp,
// plus the day's tempMaxC/tempMinC cross-referenced from the daily data.

function findForecastForTimestamp(forecast, timestampSec) {
  const hourly   = forecast.hourly;
  const daily    = forecast.daily;
  const slotDate = new Date(timestampSec * 1000).toISOString().slice(0, 10);

  // Pull the day's max/min from daily data regardless of which source we use below.
  // These are critical for beach-coldness and heat-danger rules.
  let tempMaxC = null;
  let tempMinC = null;
  if (daily?.time) {
    const dayIdx = daily.time.findIndex((t) => t === slotDate);
    if (dayIdx >= 0) {
      tempMaxC = daily.temperature_2m_max[dayIdx] != null ? Math.round(daily.temperature_2m_max[dayIdx]) : null;
      tempMinC = daily.temperature_2m_min[dayIdx] != null ? Math.round(daily.temperature_2m_min[dayIdx]) : null;
    }
  }

  // Hourly — preferred path (full 16-day window).
  // Skip null-temperature entries (the last few hours of the forecast window can be null
  // for some US models, e.g. GFS/NAM), so bestIdx always lands on a valid data point.
  if (hourly?.time?.length > 0) {
    let bestIdx  = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < hourly.time.length; i++) {
      if (hourly.temperature_2m[i] == null) continue;
      const diff = Math.abs(Math.floor(new Date(hourly.time[i]).getTime() / 1000) - timestampSec);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    if (bestIdx === -1) return null; // no valid temperature in the hourly window
    const { condition, description } = wmoToCondition(hourly.weathercode[bestIdx]);
    const windSpeedKnots = windToKnots(hourly.windspeed_10m?.[bestIdx], forecast.hourly_units?.windspeed_10m);
    const windGustsKnots = windToKnots(hourly.wind_gusts_10m?.[bestIdx], forecast.hourly_units?.wind_gusts_10m);
    const { cloudCoverPercent, cloudCoverOktas } = normalizeCloudCover(hourly.cloud_cover?.[bestIdx]);
    const rawTemp = hourly.temperature_2m[bestIdx];
    const rawFeels = hourly.apparent_temperature?.[bestIdx];
    return {
      tempC:      Math.round(rawTemp),
      feelsLikeC: rawFeels != null ? Math.round(rawFeels) : Math.round(rawTemp),
      tempMaxC:   tempMaxC ?? Math.round(rawTemp),
      tempMinC:   tempMinC ?? Math.round(rawTemp),
      condition,
      description,
      icon:       '',
      pop:        (hourly.precipitation_probability?.[bestIdx] || 0) / 100,
      humidity:   hourly.relativehumidity_2m?.[bestIdx] ?? null,
      windSpeed:  windSpeedKnots,
      windSpeedKnots,
      windGustsKnots,
      cloudCoverPercent,
      cloudCoverOktas,
      source:     'hourly',
    };
  }

  // Daily fallback
  if (daily?.time?.length > 0) {
    let bestIdx  = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < daily.time.length; i++) {
      if (daily.temperature_2m_max[i] == null && daily.temperature_2m_min[i] == null) continue;
      const diff = Math.abs(new Date(daily.time[i]) - new Date(slotDate));
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    if (bestIdx === -1) return null;
    const { condition, description } = wmoToCondition(daily.weathercode[bestIdx]);
    const hi = daily.temperature_2m_max[bestIdx];
    const lo = daily.temperature_2m_min[bestIdx];
    const avg = hi != null && lo != null ? (hi + lo) / 2 : (hi ?? lo);
    return {
      tempC:      Math.round(avg),
      feelsLikeC: Math.round(avg),
      tempMaxC:   hi != null ? Math.round(hi) : null,
      tempMinC:   lo != null ? Math.round(lo) : null,
      condition,
      description,
      icon:       '',
      pop:        (daily.precipitation_probability_max?.[bestIdx] || 0) / 100,
      humidity:   null,
      windSpeed:  null,
      windSpeedKnots: null,
      windGustsKnots: null,
      cloudCoverPercent: null,
      cloudCoverOktas: null,
      source:     'daily',
    };
  }

  return null;
}

// ─── Activity categorisation ──────────────────────────────────────────────────
// Priority: explicit indoor flag → SKI → BEACH → keyword INDOOR → GENERAL_OUTDOOR

// [Feature #23] Categorize a stop's activity (SKI / BEACH / INDOOR / GENERAL_OUTDOOR)
function categorizeActivity(slot, item) {
  const manualActivityType = String(slot.activityType || '').toUpperCase();
  if (manualActivityType && manualActivityType !== 'AUTO' && MANUAL_ACTIVITY_TYPES.has(manualActivityType)) {
    return manualActivityType;
  }

  if (slot.indoor === true || (item && item.indoor === true)) return 'INDOOR';

  const text = [
    slot.title    || '',
    slot.notes    || '',
    item?.category || '',
    item?.type     || '',
    item?.name     || '',
  ].join(' ').toLowerCase();

  if (SKI_KEYWORDS.some((k) => text.includes(k)))    return 'SKI';
  if (BEACH_KEYWORDS.some((k) => text.includes(k)))  return 'BEACH';
  if (SCENIC_VIEW_KEYWORDS.some((k) => text.includes(k))) return 'SCENIC_VIEW';
  if (INDOOR_KEYWORDS.some((k) => text.includes(k))) return 'INDOOR';
  return 'GENERAL_OUTDOOR';
}

// ─── Context-aware weather assessment ────────────────────────────────────────
// Returns { isAlert: boolean, reason: string | null }

function toF(c) { return Math.round(c * 9 / 5 + 32); }

function assessGeneralOutdoorWeather(fw, isRain, isStorm, windSpeedKnots, windGustsKnots) {
  if (isStorm) {
    return {
      isAlert: true,
      reason: `Thunderstorm forecast (${Math.round(fw.pop * 100)}% precipitation chance) - outdoor activity not recommended`,
    };
  }
  if (isRain && fw.pop >= RAIN_PROB_OUTDOOR) {
    return {
      isAlert: true,
      reason: `${Math.round(fw.pop * 100)}% chance of ${fw.description || 'rain'} - outdoor activity may be disrupted`,
    };
  }
  if (windSpeedKnots >= WIND_ALERT_KNOTS) {
    return {
      isAlert: true,
      reason: `Wind speed is ${WIND_ALERT_KNOTS} knots or higher (${Math.round(windSpeedKnots)} knots) - outdoor activity may be uncomfortable or unsafe`,
    };
  }
  if (windGustsKnots >= WIND_GUST_ALERT_KNOTS) {
    return {
      isAlert: true,
      reason: `Wind gusts are ${WIND_GUST_ALERT_KNOTS} knots or higher (${Math.round(windGustsKnots)} knots) - outdoor activity may be uncomfortable or unsafe`,
    };
  }
  return { isAlert: false, reason: null };
}

// [Feature #23] Context-aware weather assessment using category-specific thresholds
function assessWeather(fw, category) {
  if (category === 'INDOOR') return { isAlert: false, reason: null };

  const cond    = (fw.condition || '').toLowerCase();
  const isSnow  = cond.includes('snow');
  const isRain  = cond.includes('rain') || cond.includes('drizzle');
  const isStorm = cond.includes('storm') || cond.includes('thunder');
  const windSpeedKnots = fw.windSpeedKnots || 0;
  const windGustsKnots = fw.windGustsKnots || 0;
  const tempMax = fw.tempMaxC != null ? fw.tempMaxC : fw.tempC;

  // ── Global: extreme heat overrides all category rules ───────────────────────
  if (tempMax > HEAT_ALERT_C) {
    return {
      isAlert: true,
      reason: `Dangerous heat (${tempMax}°C / ${toF(tempMax)}°F) — consider rescheduling any outdoor activity`,
    };
  }

  // ── SKI ─────────────────────────────────────────────────────────────────────
  if (category === 'SKI') {
    if (tempMax > SKI_WARM_MAX_C && !isSnow) {
      return {
        isAlert: true,
        reason: `Too warm for skiing (${tempMax}°C / ${toF(tempMax)}°F) with no snow forecast — expect poor snow conditions`,
      };
    }
    if (windSpeedKnots >= SKI_WIND_ALERT_KNOTS) {
      return {
        isAlert: true,
        reason: `Ski wind speed is ${SKI_WIND_ALERT_KNOTS} knots or higher (${Math.round(windSpeedKnots)} knots) — ski lifts may be suspended`,
      };
    }
    if (windGustsKnots >= SKI_WIND_GUST_ALERT_KNOTS) {
      return {
        isAlert: true,
        reason: `Ski wind gusts are ${SKI_WIND_GUST_ALERT_KNOTS} knots or higher (${Math.round(windGustsKnots)} knots) — ski lifts may be suspended`,
      };
    }
    if (isStorm) {
      return {
        isAlert: true,
        reason: `Thunderstorm forecast — ski lifts likely closed for safety`,
      };
    }
    return { isAlert: false, reason: null };
  }

  // ── BEACH ────────────────────────────────────────────────────────────────────
  if (category === 'BEACH') {
    if (tempMax < BEACH_MIN_C) {
      return {
        isAlert: true,
        reason: `Too cold for the beach (${tempMax}°C / ${toF(tempMax)}°F — comfort threshold is ${BEACH_MIN_C}°C)`,
      };
    }
    if (isStorm) {
      return {
        isAlert: true,
        reason: `Thunderstorm forecast — beach conditions unsafe`,
      };
    }
    if (fw.pop >= RAIN_PROB_BEACH) {
      return {
        isAlert: true,
        reason: `${Math.round(fw.pop * 100)}% chance of ${fw.description || 'rain'} — beach plans may be disrupted`,
      };
    }
    return { isAlert: false, reason: null };
  }

  // ── GENERAL_OUTDOOR ──────────────────────────────────────────────────────────
  if (category === 'SCENIC_VIEW') {
    const outdoorAlert = assessGeneralOutdoorWeather(fw, isRain, isStorm, windSpeedKnots, windGustsKnots);
    if (outdoorAlert.isAlert) return outdoorAlert;
    if (cond.includes('mist')) {
      return {
        isAlert: true,
        reason: 'Low visibility expected due to fog or mist - the view may be limited.',
      };
    }
    if (fw.cloudCoverOktas != null && fw.cloudCoverOktas >= SCENIC_CLOUD_ALERT_OKTAS) {
      return {
        isAlert: true,
        reason: `Cloud cover is ${SCENIC_CLOUD_ALERT_OKTAS}/8 or higher - visibility at this scenic location may be limited.`,
      };
    }
    return { isAlert: false, reason: null };
  }
  if (isStorm) {
    return {
      isAlert: true,
      reason: `Thunderstorm forecast (${Math.round(fw.pop * 100)}% precipitation chance) — outdoor activity not recommended`,
    };
  }
  if (isRain && fw.pop >= RAIN_PROB_OUTDOOR) {
    return {
      isAlert: true,
      reason: `${Math.round(fw.pop * 100)}% chance of ${fw.description || 'rain'} — outdoor activity may be disrupted`,
    };
  }
  if (windSpeedKnots >= WIND_ALERT_KNOTS) {
    return {
      isAlert: true,
      reason: `Wind speed is ${WIND_ALERT_KNOTS} knots or higher (${Math.round(windSpeedKnots)} knots) — outdoor activity may be uncomfortable or unsafe`,
    };
  }
  if (windGustsKnots >= WIND_GUST_ALERT_KNOTS) {
    return {
      isAlert: true,
      reason: `Wind gusts are ${WIND_GUST_ALERT_KNOTS} knots or higher (${Math.round(windGustsKnots)} knots) — outdoor activity may be uncomfortable or unsafe`,
    };
  }
  return { isAlert: false, reason: null };
}

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────

function getCoordinates(slot, item) {
  const coords = slot.coords || (item && item.coords);
  if (!coords || coords.lat === undefined || coords.lng === undefined) return null;
  return { lat: coords.lat, lon: coords.lng };
}

async function getTripItem(tripId, itemId) {
  if (!itemId) return null;
  const res = await dynamodb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TRIP#${tripId}`, SK: `ITEM#${itemId}` }
  }));
  return res.Item || null;
}

async function getOnDemandTrip(detail) {
  if (!detail || !detail.tripId || !detail.userId) return null;

  const userTrip = await dynamodb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${detail.userId}`, SK: `TRIP#${detail.tripId}` }
  }));
  if (userTrip.Item && userTrip.Item.entityType === 'Trip') return userTrip.Item;

  const access = await dynamodb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TRIP#${detail.tripId}`, SK: `ACCESS#${detail.userId}` }
  }));
  if (!access.Item) return null;

  const ownerTrip = await dynamodb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${access.Item.ownerId}`, SK: `TRIP#${detail.tripId}` }
  }));
  return ownerTrip.Item || null;
}

// [Feature #25] Scheduled validation — find trips starting soon (EventBridge-driven)
async function getScheduledTrips() {
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  return queryTripsByStartRange(dynamodb, TABLE_NAME, now.toISOString(), tomorrow.toISOString());
}

async function getTrips(event) {
  const onDemandTrip = await getOnDemandTrip(event && event.detail);
  if (onDemandTrip) return [onDemandTrip];
  return getScheduledTrips();
}

// ─── Per-slot weather assessment ──────────────────────────────────────────────

// [Feature #23] Fetch + assess the forecast for a single scheduled stop
async function getWeatherForSlot(trip, slot) {
  if (!slot || !slot.start) return null;

  const item   = await getTripItem(trip.tripId, slot.itemId);
  const coords = getCoordinates(slot, item);
  if (!coords) return null;

  const slotTimestamp = Math.floor(new Date(slot.start).getTime() / 1000);
  if (!Number.isFinite(slotTimestamp)) return null;

  const forecast = await fetchForecast(coords.lat, coords.lon);
  const fw = findForecastForTimestamp(forecast, slotTimestamp);
  if (!fw) return null;

  const category = categorizeActivity(slot, item);
  const { isAlert, reason } = assessWeather(fw, category);

  return {
    slotId:         slot.slotId || 'unknown',
    slotTitle:      slot.title  || '',
    slotStart:      slot.start  || '',
    category,
    coords:         { lat: coords.lat, lng: coords.lon },
    tempC:          fw.tempC,
    feelsLikeC:     fw.feelsLikeC,
    tempMaxC:       fw.tempMaxC,
    tempMinC:       fw.tempMinC,
    condition:      fw.condition,
    description:    fw.description,
    icon:           fw.icon,
    pop:            fw.pop,
    humidity:       fw.humidity,
    windSpeed:      fw.windSpeed,
    windSpeedKnots: fw.windSpeedKnots,
    windGustsKnots: fw.windGustsKnots,
    cloudCoverPercent: fw.cloudCoverPercent,
    cloudCoverOktas: fw.cloudCoverOktas,
    forecastSource: fw.source,
    isAlert,
    reason,
  };
}

// ─── DynamoDB write helpers ───────────────────────────────────────────────────

async function clearValidationData(tripId) {
  const keys = [];
  for (const prefix of ['ALERT#', 'FALLBACKS#', 'WEATHER#']) {
    let lastKey;
    do {
      const res = await dynamodb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
        ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': prefix },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey
      }));
      (res.Items || []).forEach((it) => keys.push({ PK: it.PK, SK: it.SK }));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  }

  for (let i = 0; i < keys.length; i += 25) {
    await dynamodb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }))
      }
    }));
  }
}

// [Feature #24] Find nearby indoor fallback venues via Amazon Location Service
async function findFallbacks(coords, max = 5) {
  if (!PLACE_INDEX_NAME || !coords || coords.lat == null || coords.lng == null) return [];
  const seen        = new Set();
  const suggestions = [];

  for (const term of FALLBACK_SEARCH_TERMS) {
    if (suggestions.length >= max) break;
    try {
      const res = await location.send(new SearchPlaceIndexForTextCommand({
        IndexName:    PLACE_INDEX_NAME,
        Text:         term,
        BiasPosition: [coords.lng, coords.lat],
        MaxResults:   3
      }));
      for (const r of res.Results || []) {
        const place = r.Place || {};
        const point = place.Geometry && place.Geometry.Point;
        if (!point || point.length < 2) continue;
        const [lng, lat] = point;
        const dedupeKey  = `${place.Label}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        suggestions.push({
          name:        place.Label ? place.Label.split(',')[0] : 'Indoor activity',
          fullAddress: place.Label || '',
          lat,
          lng,
          category:   term,
          distance:   r.Distance != null ? Math.round(r.Distance) : null
        });
        if (suggestions.length >= max) break;
      }
    } catch (err) {
      console.warn('findFallbacks term failed', term, err.message);
    }
  }

  suggestions.sort((a, b) => {
    if (a.distance == null) return 1;
    if (b.distance == null) return -1;
    return a.distance - b.distance;
  });
  return suggestions.slice(0, max);
}

async function persistWeatherData(tripId, slotId, wd) {
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600;
  await dynamodb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:             `TRIP#${tripId}`,
      SK:             `WEATHER#${slotId}`,
      entityType:     'WeatherData',
      tripId,
      slotId:         wd.slotId,
      slotTitle:      wd.slotTitle,
      slotStart:      wd.slotStart,
      category:       wd.category,
      coords:         wd.coords,
      tempC:          wd.tempC,
      feelsLikeC:     wd.feelsLikeC,
      tempMaxC:       wd.tempMaxC,
      tempMinC:       wd.tempMinC,
      condition:      wd.condition,
      description:    wd.description,
      icon:           wd.icon,
      pop:            wd.pop,
      humidity:       wd.humidity,
      windSpeed:      wd.windSpeed,
      windSpeedKnots: wd.windSpeedKnots,
      windGustsKnots: wd.windGustsKnots,
      cloudCoverPercent: wd.cloudCoverPercent,
      cloudCoverOktas: wd.cloudCoverOktas,
      forecastSource: wd.forecastSource,
      isAlert:        wd.isAlert,
      reason:         wd.reason || null,
      createdAt:      now.toISOString(),
      ttl,
    }
  }));
}

async function persistFallbacks(tripId, slotId, suggestions) {
  if (!suggestions || suggestions.length === 0) return;
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600;
  await dynamodb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:         `TRIP#${tripId}`,
      SK:         `FALLBACKS#${slotId}`,
      entityType: 'Fallbacks',
      tripId,
      slotId,
      suggestions,
      createdAt:  now.toISOString(),
      ttl
    }
  }));
}

async function persistAlert(wd, tripId) {
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600;
  await dynamodb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:                 `TRIP#${tripId}`,
      SK:                 `ALERT#${now.toISOString()}#${wd.slotId}`,
      entityType:         'Alert',
      tripId,
      slotId:             wd.slotId,
      slotTitle:          wd.slotTitle,
      slotStart:          wd.slotStart,
      category:           wd.category,
      coords:             wd.coords,
      weatherCondition:   wd.condition,
      precipitationProb:  wd.pop,
      cloudCoverPercent:  wd.cloudCoverPercent,
      cloudCoverOktas:    wd.cloudCoverOktas,
      severity:           'warning',
      reason:             wd.reason,
      createdAt:          now.toISOString(),
      ttl
    }
  }));
}

async function persistValidationMeta(tripId) {
  const now = new Date();
  await dynamodb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:              `TRIP#${tripId}`,
      SK:              'META#VALIDATION',
      entityType:      'ValidationMeta',
      tripId,
      lastValidatedAt: now.toISOString()
    }
  }));
}

// ─── Handler ──────────────────────────────────────────────────────────────────

// [Feature #22] On-demand (REST-triggered) and [Feature #25] scheduled weather validation.
// For each stop: assess weather (#23), persist alerts/fallbacks (#24), email via SNS (#41).
exports.handler = async (event) => {
  console.log('Validation Lambda invoked', JSON.stringify(event));

  if (!TABLE_NAME || !ALERTS_TOPIC_ARN) {
    return { statusCode: 500, body: JSON.stringify({ error: { code: 'CONFIGURATION_ERROR', message: 'Missing required environment variables' } }) };
  }

  try {
    const trips = await getTrips(event);
    let alertsPublished = 0;
    let weatherSaved    = 0;

    for (const trip of trips) {
      try {
        await clearValidationData(trip.tripId);
      } catch (err) {
        console.warn('Failed to clear prior validation data', { tripId: trip.tripId, error: err.message });
      }

      // [Review #6] Process each stop's external lookups (Open-Meteo forecast +
      // Amazon Location fallbacks) concurrently rather than sequentially, so a long
      // itinerary stays well under the function timeout. Each slot is independent.
      const slotResults = await Promise.all(
        (trip.itinerary || []).map(async (slot) => {
          try {
            const wd = await getWeatherForSlot(trip, slot);
            if (!wd) return null;

            await persistWeatherData(trip.tripId, wd.slotId, wd);

            if (wd.isAlert) {
              await persistAlert(wd, trip.tripId);
              // [Feature #41] Publish the alert to SNS (fans out to the SES emailer)
              await sns.send(new PublishCommand({
                TopicArn: ALERTS_TOPIC_ARN,
                Message: JSON.stringify({
                  tripId: trip.tripId,
                  userId: trip.ownerId,
                  tripTitle: trip.title || 'Untitled trip',
                  reason: wd.reason,
                  slot: {
                    slotId: wd.slotId,
                    title: wd.slotTitle,
                    start: wd.slotStart,
                    coords: wd.coords,
                    category: wd.category,
                  },
                  weather: {
                    condition: wd.condition,
                    description: wd.description,
                    tempC: wd.tempC,
                    feelsLikeC: wd.feelsLikeC,
                    pop: wd.pop,
                    windSpeedKnots: wd.windSpeedKnots,
                    windGustsKnots: wd.windGustsKnots,
                    cloudCoverOktas: wd.cloudCoverOktas,
                  },
                }),
                Subject: `TripWiz weather alert: ${trip.title || trip.tripId}`,
              }));
              try {
                const suggestions = await findFallbacks(wd.coords);
                if (suggestions.length > 0) {
                  await persistFallbacks(trip.tripId, wd.slotId, suggestions);
                }
              } catch (err) {
                console.warn('Fallback search failed', { tripId: trip.tripId, slotId: wd.slotId, error: err.message });
              }
            }
            return { isAlert: wd.isAlert };
          } catch (err) {
            console.warn('Slot weather check failed', { tripId: trip.tripId, slotId: slot.slotId, error: err.message });
            return null;
          }
        })
      );

      for (const r of slotResults) {
        if (!r) continue;
        weatherSaved++;
        if (r.isAlert) alertsPublished++;
      }

      try {
        await persistValidationMeta(trip.tripId);
      } catch (err) {
        console.warn('Failed to write validation meta', { tripId: trip.tripId, error: err.message });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ tripsChecked: trips.length, weatherSaved, alertsPublished }) };
  } catch (err) {
    console.error('Validation error', err);
    return { statusCode: 500, body: JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'Validation failed' } }) };
  }
};
