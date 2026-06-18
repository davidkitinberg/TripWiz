/**
 * @fileoverview Weather validation Lambda: nightly checks, alerts, and fallback venue discovery.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

'use strict';

const AWS = require('aws-sdk');
const fetch = require('node-fetch');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();
const location = new AWS.Location();

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

// Wind speed (km/h)
const WIND_ALERT_KMH     = 50;  // general outdoor — uncomfortable/dangerous
const SKI_WIND_ALERT_KMH = 70;  // ski lifts typically close above this

// Fallback indoor suggestions (used when an alert fires for an outdoor slot)
const FALLBACK_SEARCH_TERMS = ['museum', 'gallery', 'shopping mall', 'cinema', 'aquarium'];

// ─── Activity keywords ────────────────────────────────────────────────────────

const SKI_KEYWORDS    = ['ski', 'skiing', 'snowboard', 'snowboarding', 'slopes', 'piste', 'gondola'];
const BEACH_KEYWORDS  = ['beach', 'coast', 'coastal', 'shore', 'snorkel', 'surf', 'sunbath', 'sunbathe', 'swim', 'swimming', 'waterpark', 'water park'];
const INDOOR_KEYWORDS = [
  'museum', 'gallery', 'mall', 'cinema', 'theater', 'theatre',
  'restaurant', 'cafe', 'bar', 'pub', 'hotel', 'airport',
  'train station', 'aquarium', 'shopping', 'spa', 'indoor',
];

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
    '&hourly=temperature_2m,apparent_temperature,weathercode,windspeed_10m,relativehumidity_2m,precipitation_probability',
    '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    '&timezone=auto&forecast_days=16',
  ].join('');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  return res.json();
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

  // Hourly — preferred path (full 16-day window)
  if (hourly?.time?.length > 0) {
    let bestIdx  = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < hourly.time.length; i++) {
      const diff = Math.abs(Math.floor(new Date(hourly.time[i]).getTime() / 1000) - timestampSec);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    const { condition, description } = wmoToCondition(hourly.weathercode[bestIdx]);
    return {
      tempC:      Math.round(hourly.temperature_2m[bestIdx]),
      feelsLikeC: Math.round(hourly.apparent_temperature[bestIdx]),
      tempMaxC:   tempMaxC ?? Math.round(hourly.temperature_2m[bestIdx]),
      tempMinC:   tempMinC ?? Math.round(hourly.temperature_2m[bestIdx]),
      condition,
      description,
      icon:       '',
      pop:        (hourly.precipitation_probability[bestIdx] || 0) / 100,
      humidity:   hourly.relativehumidity_2m[bestIdx] ?? null,
      windSpeed:  hourly.windspeed_10m[bestIdx] ?? null,
      source:     'hourly',
    };
  }

  // Daily fallback
  if (daily?.time?.length > 0) {
    let bestIdx  = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < daily.time.length; i++) {
      const diff = Math.abs(new Date(daily.time[i]) - new Date(slotDate));
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    const { condition, description } = wmoToCondition(daily.weathercode[bestIdx]);
    const hi = daily.temperature_2m_max[bestIdx];
    const lo = daily.temperature_2m_min[bestIdx];
    return {
      tempC:      Math.round((hi + lo) / 2),
      feelsLikeC: Math.round((hi + lo) / 2),
      tempMaxC:   hi != null ? Math.round(hi) : null,
      tempMinC:   lo != null ? Math.round(lo) : null,
      condition,
      description,
      icon:       '',
      pop:        (daily.precipitation_probability_max[bestIdx] || 0) / 100,
      humidity:   null,
      windSpeed:  null,
      source:     'daily',
    };
  }

  return null;
}

// ─── Activity categorisation ──────────────────────────────────────────────────
// Priority: explicit indoor flag → SKI → BEACH → keyword INDOOR → GENERAL_OUTDOOR

// [Feature #23] Categorize a stop's activity (SKI / BEACH / INDOOR / GENERAL_OUTDOOR)
function categorizeActivity(slot, item) {
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
  if (INDOOR_KEYWORDS.some((k) => text.includes(k))) return 'INDOOR';
  return 'GENERAL_OUTDOOR';
}

// ─── Context-aware weather assessment ────────────────────────────────────────
// Returns { isAlert: boolean, reason: string | null }

function toF(c) { return Math.round(c * 9 / 5 + 32); }

// [Feature #23] Context-aware weather assessment using category-specific thresholds
function assessWeather(fw, category) {
  if (category === 'INDOOR') return { isAlert: false, reason: null };

  const cond    = (fw.condition || '').toLowerCase();
  const isSnow  = cond.includes('snow');
  const isRain  = cond.includes('rain') || cond.includes('drizzle');
  const isStorm = cond.includes('storm') || cond.includes('thunder');
  const wind    = fw.windSpeed || 0;
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
    if (wind > SKI_WIND_ALERT_KMH) {
      return {
        isAlert: true,
        reason: `High winds (${Math.round(wind)} km/h) — ski lifts may be suspended`,
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
  if (wind > WIND_ALERT_KMH) {
    return {
      isAlert: true,
      reason: `High winds (${Math.round(wind)} km/h) — outdoor activity may be uncomfortable or unsafe`,
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
  const res = await dynamodb.get({
    TableName: TABLE_NAME,
    Key: { PK: `TRIP#${tripId}`, SK: `ITEM#${itemId}` }
  }).promise();
  return res.Item || null;
}

async function getOnDemandTrip(detail) {
  if (!detail || !detail.tripId || !detail.userId) return null;

  const userTrip = await dynamodb.get({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${detail.userId}`, SK: `TRIP#${detail.tripId}` }
  }).promise();
  if (userTrip.Item && userTrip.Item.entityType === 'Trip') return userTrip.Item;

  const access = await dynamodb.get({
    TableName: TABLE_NAME,
    Key: { PK: `TRIP#${detail.tripId}`, SK: `ACCESS#${detail.userId}` }
  }).promise();
  if (!access.Item) return null;

  const ownerTrip = await dynamodb.get({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${access.Item.ownerId}`, SK: `TRIP#${detail.tripId}` }
  }).promise();
  return ownerTrip.Item || null;
}

// [Feature #25] Scheduled validation — find trips starting soon (EventBridge-driven)
async function getScheduledTrips() {
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const res = await dynamodb.query({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :gpk AND tripStart BETWEEN :now AND :tomorrow',
    FilterExpression: 'attribute_not_exists(deleted) OR deleted = :notDeleted',
    ExpressionAttributeValues: {
      ':gpk':        'TRIP',
      ':now':        now.toISOString(),
      ':tomorrow':   tomorrow.toISOString(),
      ':notDeleted': false
    }
  }).promise();
  return res.Items || [];
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
      const res = await dynamodb.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
        ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': prefix },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey
      }).promise();
      (res.Items || []).forEach((it) => keys.push({ PK: it.PK, SK: it.SK }));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  }

  for (let i = 0; i < keys.length; i += 25) {
    await dynamodb.batchWrite({
      RequestItems: {
        [TABLE_NAME]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }))
      }
    }).promise();
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
      const res = await location.searchPlaceIndexForText({
        IndexName:    PLACE_INDEX_NAME,
        Text:         term,
        BiasPosition: [coords.lng, coords.lat],
        MaxResults:   3
      }).promise();
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
  await dynamodb.put({
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
      forecastSource: wd.forecastSource,
      isAlert:        wd.isAlert,
      reason:         wd.reason || null,
      createdAt:      now.toISOString(),
      ttl,
    }
  }).promise();
}

async function persistFallbacks(tripId, slotId, suggestions) {
  if (!suggestions || suggestions.length === 0) return;
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600;
  await dynamodb.put({
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
  }).promise();
}

async function persistAlert(wd, tripId) {
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600;
  await dynamodb.put({
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
      severity:           'warning',
      reason:             wd.reason,
      createdAt:          now.toISOString(),
      ttl
    }
  }).promise();
}

async function persistValidationMeta(tripId) {
  const now = new Date();
  await dynamodb.put({
    TableName: TABLE_NAME,
    Item: {
      PK:              `TRIP#${tripId}`,
      SK:              'META#VALIDATION',
      entityType:      'ValidationMeta',
      tripId,
      lastValidatedAt: now.toISOString()
    }
  }).promise();
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

      for (const slot of trip.itinerary || []) {
        try {
          const wd = await getWeatherForSlot(trip, slot);
          if (!wd) continue;

          await persistWeatherData(trip.tripId, wd.slotId, wd);
          weatherSaved++;

          if (wd.isAlert) {
            alertsPublished++;
            await persistAlert(wd, trip.tripId);
            // [Feature #41] Publish the alert to SNS (fans out to the SES emailer)
            await sns.publish({
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
            }).promise();
            try {
              const suggestions = await findFallbacks(wd.coords);
              if (suggestions.length > 0) {
                await persistFallbacks(trip.tripId, wd.slotId, suggestions);
              }
            } catch (err) {
              console.warn('Fallback search failed', { tripId: trip.tripId, slotId: wd.slotId, error: err.message });
            }
          }
        } catch (err) {
          console.warn('Slot weather check failed', { tripId: trip.tripId, slotId: slot.slotId, error: err.message });
        }
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
