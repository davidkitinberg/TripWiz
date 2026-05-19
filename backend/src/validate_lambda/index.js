const AWS = require('aws-sdk');
const fetch = require('node-fetch');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();
const secrets = new AWS.SecretsManager();
const location = new AWS.Location();

const TABLE_NAME = process.env.TABLE_NAME;
const OPENWEATHER_SECRET_ARN = process.env.OPENWEATHER_SECRET_ARN;
const ALERTS_TOPIC_ARN = process.env.ALERTS_TOPIC_ARN;
const PLACE_INDEX_NAME = process.env.PLACE_INDEX_NAME;

const RAIN_PROB_THRESHOLD = 0.5;
const FALLBACK_SEARCH_TERMS = ['museum', 'gallery', 'shopping mall', 'cinema', 'aquarium'];

async function getSecret(secretArn) {
  const data = await secrets.getSecretValue({ SecretId: secretArn }).promise();
  const raw = data.SecretString || Buffer.from(data.SecretBinary, 'base64').toString('utf8');
  return JSON.parse(raw);
}

async function fetchForecast(apiKey, lat, lon) {
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts&appid=${apiKey}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenWeather error ${res.status}`);
  return res.json();
}

function findHourlyForTimestamp(hourly, timestampSec) {
  if (!hourly || hourly.length === 0) return null;
  return hourly.reduce((best, point) => {
    const pointDiff = Math.abs(point.dt - timestampSec);
    const bestDiff = Math.abs(best.dt - timestampSec);
    return pointDiff < bestDiff ? point : best;
  }, hourly[0]);
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

async function getScheduledTrips() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const res = await dynamodb.query({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :gpk AND tripStart BETWEEN :now AND :tomorrow',
    FilterExpression: 'attribute_not_exists(deleted) OR deleted = :notDeleted',
    ExpressionAttributeValues: {
      ':gpk': 'TRIP',
      ':now': now.toISOString(),
      ':tomorrow': tomorrow.toISOString(),
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

function weatherIsBad(hourlyPoint) {
  const pop = hourlyPoint.pop || 0;
  const weather = ((hourlyPoint.weather && hourlyPoint.weather[0] && hourlyPoint.weather[0].main) || '').toLowerCase();
  return pop >= RAIN_PROB_THRESHOLD || weather.includes('rain') || weather.includes('storm') || weather.includes('thunder');
}

function getCoordinates(slot, item) {
  const coords = slot.coords || (item && item.coords);
  if (!coords || coords.lat === undefined || coords.lng === undefined) return null;
  return { lat: coords.lat, lon: coords.lng };
}

async function validateSlot(apiKey, trip, slot) {
  if (!slot || !slot.start) return null;

  const item = await getTripItem(trip.tripId, slot.itemId);
  const indoor = slot.indoor === true || (item && item.indoor === true);
  if (indoor) return null;

  const coords = getCoordinates(slot, item);
  if (!coords) return null;

  const slotTimestamp = Math.floor(new Date(slot.start).getTime() / 1000);
  if (!Number.isFinite(slotTimestamp)) return null;

  const forecast = await fetchForecast(apiKey, coords.lat, coords.lon);
  const hourlyPoint = findHourlyForTimestamp(forecast.hourly, slotTimestamp);
  if (!hourlyPoint || !weatherIsBad(hourlyPoint)) return null;

  const pop = hourlyPoint.pop || 0;
  const weather = (hourlyPoint.weather && hourlyPoint.weather[0] && hourlyPoint.weather[0].main) || 'bad weather';
  return {
    tripId: trip.tripId,
    userId: trip.ownerId || (trip.PK && trip.PK.replace('USER#', '')),
    slot,
    item: item ? { itemId: item.itemId, type: item.type, title: item.title, indoor: item.indoor } : undefined,
    weatherCondition: weather,
    precipitationProb: pop,
    coords: { lat: coords.lat, lng: coords.lon },
    reason: `Outdoor activity may be affected by ${weather} (${(pop * 100).toFixed(0)}% precipitation chance)`
  };
}

async function clearValidationData(tripId) {
  const keys = [];
  for (const prefix of ['ALERT#', 'FALLBACKS#']) {
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

async function findFallbacks(coords, max = 5) {
  if (!PLACE_INDEX_NAME || !coords || coords.lat == null || coords.lng == null) return [];
  const seen = new Set();
  const suggestions = [];

  for (const term of FALLBACK_SEARCH_TERMS) {
    if (suggestions.length >= max) break;
    try {
      const res = await location.searchPlaceIndexForText({
        IndexName: PLACE_INDEX_NAME,
        Text: term,
        BiasPosition: [coords.lng, coords.lat],
        MaxResults: 3
      }).promise();
      for (const r of res.Results || []) {
        const place = r.Place || {};
        const point = place.Geometry && place.Geometry.Point;
        if (!point || point.length < 2) continue;
        const [lng, lat] = point;
        const dedupeKey = `${place.Label}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        suggestions.push({
          name: place.Label ? place.Label.split(',')[0] : 'Indoor activity',
          fullAddress: place.Label || '',
          lat,
          lng,
          category: term,
          distance: r.Distance != null ? Math.round(r.Distance) : null
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

async function persistFallbacks(tripId, slotId, suggestions) {
  if (!suggestions || suggestions.length === 0) return;
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600;
  await dynamodb.put({
    TableName: TABLE_NAME,
    Item: {
      PK: `TRIP#${tripId}`,
      SK: `FALLBACKS#${slotId}`,
      entityType: 'Fallbacks',
      tripId,
      slotId,
      suggestions,
      createdAt: now.toISOString(),
      ttl
    }
  }).promise();
}

async function persistAlert(alert) {
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600; // 7 days
  const slotId = (alert.slot && alert.slot.slotId) || 'unknown';
  await dynamodb.put({
    TableName: TABLE_NAME,
    Item: {
      PK: `TRIP#${alert.tripId}`,
      SK: `ALERT#${now.toISOString()}#${slotId}`,
      entityType: 'Alert',
      tripId: alert.tripId,
      slotId,
      slotTitle: (alert.slot && alert.slot.title) || '',
      slotStart: (alert.slot && alert.slot.start) || '',
      coords: alert.coords || null,
      weatherCondition: alert.weatherCondition || '',
      precipitationProb: alert.precipitationProb || 0,
      severity: 'warning',
      reason: alert.reason,
      createdAt: now.toISOString(),
      ttl
    }
  }).promise();
}

async function persistValidationMeta(tripId) {
  const now = new Date();
  await dynamodb.put({
    TableName: TABLE_NAME,
    Item: {
      PK: `TRIP#${tripId}`,
      SK: 'META#VALIDATION',
      entityType: 'ValidationMeta',
      tripId,
      lastValidatedAt: now.toISOString()
    }
  }).promise();
}

exports.handler = async (event) => {
  console.log('Validation Lambda invoked', JSON.stringify(event));

  if (!TABLE_NAME || !OPENWEATHER_SECRET_ARN || !ALERTS_TOPIC_ARN) {
    return { statusCode: 500, body: JSON.stringify({ error: { code: 'CONFIGURATION_ERROR', message: 'Missing required environment variables' } }) };
  }

  try {
    const secret = await getSecret(OPENWEATHER_SECRET_ARN);
    const apiKey = secret.apiKey || secret.key || secret.OPENWEATHER_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: { code: 'SECRET_INVALID', message: 'OpenWeather API key not found in secret' } }) };
    }

    const trips = await getTrips(event);
    const alerts = [];

    for (const trip of trips) {
      try {
        await clearValidationData(trip.tripId);
      } catch (err) {
        console.warn('Failed to clear prior validation data', { tripId: trip.tripId, error: err.message });
      }
      for (const slot of trip.itinerary || []) {
        try {
          const alert = await validateSlot(apiKey, trip, slot);
          if (!alert) continue;
          alerts.push(alert);
          await persistAlert(alert);
          await sns.publish({
            TopicArn: ALERTS_TOPIC_ARN,
            Message: JSON.stringify(alert),
            Subject: `TripWiz alert for ${trip.title || trip.tripId}`
          }).promise();
          try {
            const suggestions = await findFallbacks(alert.coords);
            if (suggestions.length > 0) {
              await persistFallbacks(alert.tripId, slot.slotId || 'unknown', suggestions);
            }
          } catch (err) {
            console.warn('Fallback search failed', { tripId: trip.tripId, slotId: slot.slotId, error: err.message });
          }
        } catch (err) {
          console.warn('Slot validation failed', { tripId: trip.tripId, slotId: slot.slotId, error: err.message });
        }
      }
      try {
        await persistValidationMeta(trip.tripId);
      } catch (err) {
        console.warn('Failed to write validation meta', { tripId: trip.tripId, error: err.message });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ tripsChecked: trips.length, alertsPublished: alerts.length }) };
  } catch (err) {
    console.error('Validation error', err);
    return { statusCode: 500, body: JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'Validation failed' } }) };
  }
};
