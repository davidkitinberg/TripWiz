const AWS = require('aws-sdk');
const fetch = require('node-fetch');

const ddb = new AWS.DynamoDB.DocumentClient();
const lambda = new AWS.Lambda();
const secrets = new AWS.SecretsManager();
const cognito = new AWS.CognitoIdentityServiceProvider();
const bedrock = new AWS.BedrockRuntime();

const TABLE_NAME = process.env.TABLE_NAME;
const VALIDATE_FUNCTION_NAME = process.env.VALIDATE_FUNCTION_NAME;
const MAPPING_SECRET_ARN = process.env.MAPPING_SECRET_ARN;
const USER_POOL_ID = process.env.USER_POOL_ID;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const uuid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const ok = (statusCode, body) => ({ statusCode, headers: corsHeaders(), body: body === undefined ? '' : JSON.stringify(body) });
const noContent = () => ({ statusCode: 204, headers: corsHeaders(), body: '' });
const fail = (statusCode, code, message, details) => ok(statusCode, { error: { code, message, ...(details ? { details } : {}) } });
const corsHeaders = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE'
});

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (err) {
    const e = new Error('Request body must be valid JSON');
    e.statusCode = 400;
    e.code = 'INVALID_JSON';
    throw e;
  }
}

function getUserId(event) {
  const claims = event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims;
  return claims && claims.sub;
}

function normalizeCollaborators(collaborators) {
  if (!Array.isArray(collaborators)) return [];
  return [...new Set(collaborators.filter((id) => typeof id === 'string' && id.trim()))];
}

async function putAll(items) {
  for (let i = 0; i < items.length; i += 25) {
    await ddb.batchWrite({
      RequestItems: {
        [TABLE_NAME]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }))
      }
    }).promise();
  }
}

async function deleteAll(keys) {
  for (let i = 0; i < keys.length; i += 25) {
    await ddb.batchWrite({
      RequestItems: {
        [TABLE_NAME]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }))
      }
    }).promise();
  }
}

async function getUserTripPointer(userId, tripId) {
  const res = await ddb.get({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: `TRIP#${tripId}` }
  }).promise();
  return res.Item || null;
}

async function getTripAccess(userId, tripId) {
  const res = await ddb.get({
    TableName: TABLE_NAME,
    Key: { PK: `TRIP#${tripId}`, SK: `ACCESS#${userId}` }
  }).promise();
  return res.Item || null;
}

async function resolveTripForUser(userId, tripId) {
  const pointer = await getUserTripPointer(userId, tripId);

  if (pointer && pointer.entityType === 'Trip') {
    return { trip: pointer, access: { role: 'owner', ownerId: userId } };
  }

  const access = await getTripAccess(userId, tripId);
  const ownerId = (access && access.ownerId) || (pointer && pointer.ownerId);
  if (!ownerId) return null;

  const ownerTrip = await getUserTripPointer(ownerId, tripId);
  if (!ownerTrip || ownerTrip.deleted) return null;
  return { trip: ownerTrip, access: access || { role: 'viewer', ownerId } };
}

function publicTrip(item) {
  const { PK, SK, GSI1PK, tripStart, ...rest } = item;
  return rest;
}

async function writeAccessRecords(trip, collaborators) {
  const now = new Date().toISOString();
  const items = [
    {
      PK: `TRIP#${trip.tripId}`,
      SK: `ACCESS#${trip.ownerId}`,
      entityType: 'TripAccess',
      tripId: trip.tripId,
      userId: trip.ownerId,
      ownerId: trip.ownerId,
      role: 'owner',
      updatedAt: now
    }
  ];

  for (const collaboratorId of collaborators) {
    items.push({
      PK: `TRIP#${trip.tripId}`,
      SK: `ACCESS#${collaboratorId}`,
      entityType: 'TripAccess',
      tripId: trip.tripId,
      userId: collaboratorId,
      ownerId: trip.ownerId,
      role: 'editor',
      updatedAt: now
    });
    items.push({
      PK: `USER#${collaboratorId}`,
      SK: `TRIP#${trip.tripId}`,
      entityType: 'TripPointer',
      tripId: trip.tripId,
      ownerId: trip.ownerId,
      title: trip.title,
      startDate: trip.startDate,
      endDate: trip.endDate,
      role: 'editor',
      updatedAt: now
    });
  }

  await putAll(items);
}

async function syncAccessRecords(previousTrip, nextTrip) {
  const previousCollaborators = normalizeCollaborators(previousTrip.collaborators);
  const nextCollaborators = normalizeCollaborators(nextTrip.collaborators);
  const removedCollaborators = previousCollaborators.filter((id) => !nextCollaborators.includes(id));

  if (removedCollaborators.length > 0) {
    await deleteAll(removedCollaborators.flatMap((userId) => ([
      { PK: `TRIP#${nextTrip.tripId}`, SK: `ACCESS#${userId}` },
      { PK: `USER#${userId}`, SK: `TRIP#${nextTrip.tripId}` }
    ])));
  }

  await writeAccessRecords(nextTrip, nextCollaborators);
}

async function lookupUserByEmail(email) {
  if (!USER_POOL_ID) {
    const e = new Error('USER_POOL_ID is not configured');
    e.statusCode = 500;
    e.code = 'CONFIGURATION_ERROR';
    throw e;
  }
  const safe = String(email).replace(/"/g, '\\"');
  const res = await cognito.listUsers({
    UserPoolId: USER_POOL_ID,
    Filter: `email = "${safe}"`,
    Limit: 1
  }).promise();
  if (!res.Users || res.Users.length === 0) return null;
  const user = res.Users[0];
  const attrs = user.Attributes || [];
  const sub = (attrs.find((a) => a.Name === 'sub') || {}).Value;
  const userEmail = (attrs.find((a) => a.Name === 'email') || {}).Value;
  return sub ? { userId: sub, email: (userEmail || email).toLowerCase() } : null;
}

async function getSecretJson(secretArn) {
  const data = await secrets.getSecretValue({ SecretId: secretArn }).promise();
  const raw = data.SecretString || Buffer.from(data.SecretBinary, 'base64').toString('utf8');
  return JSON.parse(raw);
}

function classifyStop(name) {
  const n = (name || '').toLowerCase();
  if (/airport|terminal|departure|arrival|airline|airways|fly|flight/.test(n)) return 'airport';
  if (/train station|bus station|bus terminal|railway|central station|ferry terminal|port terminal|metro station/.test(n)) return 'transit';
  if (/hotel|hostel|inn|lodge|resort|motel|airbnb|accommodation|check.?in|check.?out|ritz|hilton|marriott|sheraton|hyatt/.test(n)) return 'hotel';
  return 'attraction';
}

async function optimizeWithBedrock(itinerary) {
  const raw = (itinerary || []).filter((s) => s && s.coords && s.coords.lat != null && s.coords.lng != null);

  if (raw.length < 2) {
    return { stops: [], reasoning: 'Need at least 2 stops with coordinates to optimize a route.' };
  }

  // Group by day to determine each stop's position within its day
  const byDay = {};
  for (const s of raw) {
    const d = s.dayIndex || 0;
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(s);
  }
  for (const day of Object.values(byDay)) {
    day.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    day.forEach((s, i) => { s._dayPos = i; s._dayLen = day.length; });
  }

  const stops = raw.map((s) => {
    const type = classifyStop(s.title);
    const scheduledTime = s.start ? s.start.substring(11, 16) : null;
    const isFixed = type === 'airport' || type === 'transit';
    const isFirstInDay = s._dayPos === 0;
    const isLastInDay = s._dayPos === s._dayLen - 1;
    return {
      stopId: s.slotId,
      name: s.title || 'Unnamed stop',
      type,
      isFixed,
      ...(scheduledTime ? { scheduledTime } : {}),
      ...(type === 'hotel' ? { isFirstInDay, isLastInDay } : {}),
      dayIndex: s.dayIndex || 0,
      lat: s.coords.lat,
      lng: s.coords.lng,
      durationHours: s.notes || '2'
    };
  });

  const prompt = `You are a travel-planning assistant for TripWiz. Reorder the user's trip stops within each day into a smart, efficient itinerary and assign sensible visit times.

Stop types:
- "airport" / "transit": Time-critical anchors (flights, trains). NEVER move or retime these. Keep scheduledTime exactly.
- "hotel": Accommodation anchors. A hotel that isFirstInDay=true is a check-out and must stay first in its day. A hotel that isLastInDay=true is a check-in and must stay last. Do not reorder hotels relative to fixed stops.
- "attraction": Freely reorderable within the day.

Stops:
${JSON.stringify(stops, null, 2)}

Rules:
1. Keep each stop on its current dayIndex — never move stops between days.
2. For isFixed=true stops: preserve their exact position (first or last as given) and keep scheduledTime unchanged in your output.
3. For hotel stops: obey isFirstInDay / isLastInDay — a check-out hotel must be before all other stops; a check-in hotel must be after all other stops.
4. For attraction stops: reorder within the day to minimize travel (use lat/lng) and create a logical flow (cafes/breakfast early, museums/sights in morning, parks/viewpoints afternoon, restaurants at meal times).
5. Assign startTime in 24-hour "HH:MM" format. First attraction no earlier than 09:00; last stop finishes by 22:00. Allow 15 minutes travel buffer between stops plus each stop's durationHours (use lower bound if a range).
6. Use exactly the stopIds provided. Do not add or drop any.

Respond with ONLY a single JSON object — no prose, no markdown fences:
{
  "stops": [
    {"stopId": "<id>", "dayIndex": <int>, "startTime": "HH:MM"}
  ],
  "reasoning": "1-2 sentence explanation of the chosen flow"
}`;

  const res = await bedrock.invokeModel({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
  }).promise();

  const body = JSON.parse(res.body.toString('utf8'));
  const text = (body.content && body.content[0] && body.content[0].text) || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    const e = new Error('Bedrock did not return parseable JSON');
    e.statusCode = 502;
    e.code = 'BEDROCK_PARSE_ERROR';
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    const e = new Error('Bedrock returned invalid JSON');
    e.statusCode = 502;
    e.code = 'BEDROCK_PARSE_ERROR';
    throw e;
  }

  const validIds = new Set(stops.map((s) => s.stopId));
  const cleanedStops = (parsed.stops || [])
    .filter((p) => p && validIds.has(p.stopId))
    .map((p) => ({
      stopId: p.stopId,
      dayIndex: Number.isInteger(p.dayIndex) ? p.dayIndex : 0,
      startTime: typeof p.startTime === 'string' && /^\d{2}:\d{2}$/.test(p.startTime) ? p.startTime : ''
    }));

  return {
    stops: cleanedStops,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    model: BEDROCK_MODEL_ID
  };
}

async function calculateRoute(body) {
  if (!MAPPING_SECRET_ARN) {
    const e = new Error('Mapping secret is not configured');
    e.statusCode = 500;
    e.code = 'CONFIGURATION_ERROR';
    throw e;
  }

  if (!Array.isArray(body.waypoints) || body.waypoints.length < 2) {
    const e = new Error('At least two waypoints are required');
    e.statusCode = 400;
    e.code = 'INVALID_WAYPOINTS';
    throw e;
  }

  const secret = await getSecretJson(MAPPING_SECRET_ARN);
  const routeUrl = secret.routeUrl || secret.url;
  const apiKey = secret.apiKey || secret.key || secret.MAPPING_API_KEY;
  if (!routeUrl || !apiKey) {
    const e = new Error('Mapping secret must include routeUrl and apiKey');
    e.statusCode = 500;
    e.code = 'MAPPING_SECRET_INVALID';
    throw e;
  }

  const res = await fetch(routeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      waypoints: body.waypoints,
      profile: body.profile || 'driving'
    })
  });

  if (!res.ok) {
    const e = new Error(`Mapping provider returned ${res.status}`);
    e.statusCode = 502;
    e.code = 'MAPPING_PROVIDER_ERROR';
    throw e;
  }

  return res.json();
}

exports.handler = async (event) => {
  console.log('REST event:', JSON.stringify({ resource: event.resource, method: event.httpMethod, path: event.path }));

  if (event.httpMethod === 'OPTIONS') return ok(200, {});

  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserId(event);

  if (!userId) return fail(401, 'UNAUTHORIZED', 'A valid Cognito JWT is required');

  try {
    if (method === 'GET' && path === '/trips') {
      const res = await ddb.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skprefix)',
        FilterExpression: 'attribute_not_exists(deleted) OR deleted = :notDeleted',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}`,
          ':skprefix': 'TRIP#',
          ':notDeleted': false
        }
      }).promise();
      return ok(200, { items: (res.Items || []).map(publicTrip), lastKey: res.LastEvaluatedKey });
    }

    if (method === 'POST' && path === '/trips') {
      const body = parseBody(event);
      const tripId = `t-${uuid()}`;
      const now = new Date().toISOString();
      const collaborators = normalizeCollaborators(body.collaborators).filter((id) => id !== userId);
      const trip = {
        PK: `USER#${userId}`,
        SK: `TRIP#${tripId}`,
        entityType: 'Trip',
        tripId,
        ownerId: userId,
        title: body.title || 'Untitled Trip',
        startDate: body.startDate || null,
        endDate: body.endDate || null,
        collaborators,
        itinerary: Array.isArray(body.itinerary) ? body.itinerary : [],
        metadata: body.metadata || {},
        version: 1,
        GSI1PK: 'TRIP',
        tripStart: body.startDate || now,
        createdAt: now,
        updatedAt: now
      };

      await ddb.put({
        TableName: TABLE_NAME,
        Item: trip,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      }).promise();
      await writeAccessRecords(trip, collaborators);
      return ok(201, { tripId, trip: publicTrip(trip) });
    }

    if (method === 'GET' && path === '/trips/{tripId}') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      return ok(200, { trip: publicTrip(resolved.trip), access: resolved.access.role });
    }

    if (method === 'PUT' && path === '/trips/{tripId}') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const body = parseBody(event);
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      if (!['owner', 'editor'].includes(resolved.access.role)) return fail(403, 'FORBIDDEN', 'You cannot edit this trip');

      const expectedVersion = Number(body.version);
      if (!expectedVersion) return fail(400, 'VERSION_REQUIRED', 'version is required for updates');

      const allowed = ['title', 'startDate', 'endDate', 'collaborators', 'itinerary', 'metadata'];
      const names = { '#version': 'version', '#updatedAt': 'updatedAt' };
      const values = { ':expectedVersion': expectedVersion, ':newVersion': expectedVersion + 1, ':updatedAt': new Date().toISOString() };
      const sets = ['#version = :newVersion', '#updatedAt = :updatedAt'];
      let index = 0;

      for (const field of allowed) {
        if (body[field] !== undefined) {
          index += 1;
          names[`#f${index}`] = field;
          values[`:v${index}`] = field === 'collaborators' ? normalizeCollaborators(body[field]).filter((id) => id !== resolved.trip.ownerId) : body[field];
          sets.push(`#f${index} = :v${index}`);
        }
      }

      if (body.startDate !== undefined) {
        names['#tripStart'] = 'tripStart';
        values[':tripStart'] = body.startDate;
        sets.push('#tripStart = :tripStart');
      }

      if (sets.length === 2) return fail(400, 'BAD_REQUEST', 'No supported fields provided');

      try {
        const updateRes = await ddb.update({
          TableName: TABLE_NAME,
          Key: { PK: `USER#${resolved.trip.ownerId}`, SK: `TRIP#${tripId}` },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(SK) AND #version = :expectedVersion',
          ReturnValues: 'ALL_NEW'
        }).promise();

        if (['title', 'startDate', 'endDate', 'collaborators'].some((field) => body[field] !== undefined)) {
          await syncAccessRecords(resolved.trip, updateRes.Attributes);
        }

        return ok(200, { trip: publicTrip(updateRes.Attributes) });
      } catch (err) {
        if (err.code === 'ConditionalCheckFailedException') {
          return fail(409, 'VERSION_CONFLICT', 'Trip was updated by someone else');
        }
        throw err;
      }
    }

    if (method === 'DELETE' && path === '/trips/{tripId}') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      if (resolved.trip.ownerId !== userId) return fail(403, 'FORBIDDEN', 'Only the owner can delete this trip');

      await ddb.update({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: `TRIP#${tripId}` },
        UpdateExpression: 'SET deleted = :deleted, updatedAt = :updatedAt',
        ExpressionAttributeValues: { ':deleted': true, ':updatedAt': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(SK)'
      }).promise();
      return noContent();
    }

    if (method === 'GET' && path === '/trips/{tripId}/alerts') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');

      const [alertsRes, metaRes] = await Promise.all([
        ddb.query({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
          ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': 'ALERT#' }
        }).promise(),
        ddb.get({
          TableName: TABLE_NAME,
          Key: { PK: `TRIP#${tripId}`, SK: 'META#VALIDATION' }
        }).promise()
      ]);

      const alerts = (alertsRes.Items || []).map((item) => {
        const { PK, SK, ttl, entityType, ...rest } = item;
        return { alertId: SK, ...rest };
      });

      return ok(200, {
        alerts,
        count: alerts.length,
        lastValidatedAt: metaRes.Item ? metaRes.Item.lastValidatedAt : null
      });
    }

    if (method === 'GET' && path === '/trips/{tripId}/fallbacks') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');

      const res = await ddb.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
        ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': 'FALLBACKS#' }
      }).promise();

      const fallbacks = (res.Items || []).map((item) => ({
        slotId: item.slotId,
        suggestions: item.suggestions || [],
        createdAt: item.createdAt
      }));

      return ok(200, { fallbacks, count: fallbacks.length });
    }

    if (method === 'POST' && path === '/trips/{tripId}/validate') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      if (!VALIDATE_FUNCTION_NAME) return fail(500, 'CONFIGURATION_ERROR', 'Validation Lambda is not configured');

      const itinerary = resolved.trip.itinerary || [];
      const slotsToCheck = itinerary.filter((s) => s.start && s.coords && s.coords.lat != null).length;

      await lambda.invoke({
        FunctionName: VALIDATE_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: JSON.stringify({ source: 'tripwiz.rest', detail: { tripId, userId } })
      }).promise();
      return ok(202, { jobId: `validate-${tripId}-${Date.now()}`, slotsToCheck, totalSlots: itinerary.length });
    }

    if (method === 'POST' && path === '/trips/{tripId}/invite') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const body = parseBody(event);
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return fail(400, 'BAD_REQUEST', 'A valid email is required');
      }

      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      if (resolved.access.role !== 'owner') {
        return fail(403, 'FORBIDDEN', 'Only the trip owner can invite collaborators');
      }

      const invited = await lookupUserByEmail(email);
      if (!invited) return fail(404, 'USER_NOT_FOUND', 'No TripWiz account exists for that email');
      if (invited.userId === userId) {
        return fail(400, 'CANNOT_INVITE_SELF', 'You are already the owner of this trip');
      }

      const trip = resolved.trip;
      const collaborators = normalizeCollaborators(trip.collaborators);
      if (collaborators.includes(invited.userId)) {
        return fail(409, 'ALREADY_COLLABORATOR', 'This user is already a collaborator');
      }

      const now = new Date().toISOString();
      const expectedVersion = trip.version || 1;
      const newVersion = expectedVersion + 1;
      const nextCollaborators = [...collaborators, invited.userId];

      try {
        await ddb.update({
          TableName: TABLE_NAME,
          Key: { PK: `USER#${trip.ownerId}`, SK: `TRIP#${tripId}` },
          UpdateExpression: 'SET collaborators = :c, #v = :nv, updatedAt = :u',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: {
            ':c': nextCollaborators,
            ':nv': newVersion,
            ':u': now,
            ':ev': expectedVersion
          },
          ConditionExpression: '#v = :ev'
        }).promise();
      } catch (err) {
        if (err.code === 'ConditionalCheckFailedException') {
          return fail(409, 'VERSION_CONFLICT', 'Trip was updated concurrently — please retry');
        }
        throw err;
      }

      await putAll([
        {
          PK: `TRIP#${tripId}`,
          SK: `ACCESS#${invited.userId}`,
          entityType: 'TripAccess',
          tripId,
          userId: invited.userId,
          ownerId: trip.ownerId,
          role: 'editor',
          updatedAt: now
        },
        {
          PK: `USER#${invited.userId}`,
          SK: `TRIP#${tripId}`,
          entityType: 'TripPointer',
          tripId,
          ownerId: trip.ownerId,
          title: trip.title,
          startDate: trip.startDate,
          endDate: trip.endDate,
          role: 'editor',
          updatedAt: now
        },
        {
          PK: `TRIP#${tripId}`,
          SK: `COLLAB#${invited.userId}`,
          entityType: 'CollaboratorInfo',
          tripId,
          userId: invited.userId,
          email: invited.email,
          role: 'editor',
          addedAt: now
        }
      ]);

      return ok(200, {
        collaborator: { userId: invited.userId, email: invited.email, role: 'editor', addedAt: now }
      });
    }

    if (method === 'GET' && path === '/trips/{tripId}/collaborators') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');

      const res = await ddb.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
        ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': 'COLLAB#' }
      }).promise();

      const collaborators = (res.Items || []).map((item) => ({
        userId: item.userId,
        email: item.email,
        role: item.role || 'editor',
        addedAt: item.addedAt
      }));

      return ok(200, {
        ownerId: resolved.trip.ownerId,
        callerIsOwner: resolved.access.role === 'owner',
        collaborators
      });
    }

    if (method === 'DELETE' && path === '/trips/{tripId}/invite/{userId}') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      const target = event.pathParameters && event.pathParameters.userId;
      if (!tripId || !target) return fail(400, 'BAD_REQUEST', 'tripId and userId are required');

      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      if (resolved.access.role !== 'owner') {
        return fail(403, 'FORBIDDEN', 'Only the trip owner can remove collaborators');
      }
      if (target === resolved.trip.ownerId) {
        return fail(400, 'CANNOT_REMOVE_OWNER', 'Cannot remove the trip owner');
      }

      const trip = resolved.trip;
      const collaborators = normalizeCollaborators(trip.collaborators);
      if (!collaborators.includes(target)) {
        return fail(404, 'NOT_A_COLLABORATOR', 'User is not a collaborator of this trip');
      }

      const expectedVersion = trip.version || 1;
      const newVersion = expectedVersion + 1;
      const nextCollaborators = collaborators.filter((c) => c !== target);
      const now = new Date().toISOString();

      try {
        await ddb.update({
          TableName: TABLE_NAME,
          Key: { PK: `USER#${trip.ownerId}`, SK: `TRIP#${tripId}` },
          UpdateExpression: 'SET collaborators = :c, #v = :nv, updatedAt = :u',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: {
            ':c': nextCollaborators,
            ':nv': newVersion,
            ':u': now,
            ':ev': expectedVersion
          },
          ConditionExpression: '#v = :ev'
        }).promise();
      } catch (err) {
        if (err.code === 'ConditionalCheckFailedException') {
          return fail(409, 'VERSION_CONFLICT', 'Trip was updated concurrently — please retry');
        }
        throw err;
      }

      await deleteAll([
        { PK: `TRIP#${tripId}`, SK: `ACCESS#${target}` },
        { PK: `USER#${target}`, SK: `TRIP#${tripId}` },
        { PK: `TRIP#${tripId}`, SK: `COLLAB#${target}` }
      ]);

      return noContent();
    }

    if (method === 'POST' && path === '/trips/{tripId}/optimize') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      if (!['owner', 'editor'].includes(resolved.access.role)) {
        return fail(403, 'FORBIDDEN', 'You cannot edit this trip');
      }
      try {
        const result = await optimizeWithBedrock(resolved.trip.itinerary || []);
        return ok(200, result);
      } catch (err) {
        console.error('Bedrock optimization failed:', err);
        return fail(err.statusCode || 502, err.code || 'OPTIMIZATION_FAILED', err.message || 'Failed to optimize route');
      }
    }

    if (method === 'POST' && path === '/routes/calculate') {
      const body = parseBody(event);
      const route = await calculateRoute(body);
      return ok(200, route);
    }

    return fail(404, 'NOT_FOUND', 'Route not found');
  } catch (err) {
    console.error('Handler error', err);
    return fail(err.statusCode || 500, err.code || 'INTERNAL_ERROR', err.message || 'Internal error');
  }
};
