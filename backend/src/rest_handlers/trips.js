/**
 * @fileoverview REST API Lambda handler for trips, admin, places, routes, attachments, and user prefs.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

const AWS = require('aws-sdk');
const fetch = require('node-fetch');

const ddb = new AWS.DynamoDB.DocumentClient();
const lambda = new AWS.Lambda();
const secrets = new AWS.SecretsManager();
const cognito = new AWS.CognitoIdentityServiceProvider();
const bedrock = new AWS.BedrockRuntime();
const location = new AWS.Location();
const s3 = new AWS.S3();
const ses = new AWS.SES();

const TABLE_NAME = process.env.TABLE_NAME;
const VALIDATE_FUNCTION_NAME = process.env.VALIDATE_FUNCTION_NAME;
const MAPPING_SECRET_ARN = process.env.MAPPING_SECRET_ARN;
const USER_POOL_ID = process.env.USER_POOL_ID;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const PLACE_INDEX_NAME = process.env.PLACE_INDEX_NAME || 'TripWizPlaceIndex';
const ROUTE_CALCULATOR_NAME = process.env.ROUTE_CALCULATOR_NAME || 'TripWizRouteCalculator';
const WS_ENDPOINT = process.env.WS_ENDPOINT;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET;
const SOURCE_EMAIL = process.env.SOURCE_EMAIL;
const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://tripwiz.app').replace(/\/$/, '');
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['application/pdf', ['pdf']],
  ['image/png', ['png']],
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/webp', ['webp']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx']]
]);
const ALLOWED_RELATED_ITEM_TYPES = new Set(['flight', 'accommodation', 'rentalCar', 'general']);

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

/* ─── Admin auth helpers ───────────────────────────────── */

const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const ADMIN_GROUP_NAME = 'Admins';

const DEFAULT_TRENDING = [
  { city: 'Tokyo',     country: 'Japan',  tag: 'Culture & Food',   emoji: '🗾' },
  { city: 'New York',  country: 'USA',    tag: 'City Break',       emoji: '🗽' },
  { city: 'Santorini', country: 'Greece', tag: 'Beach & Sun',      emoji: '🏖️' },
  { city: 'Kyoto',     country: 'Japan',  tag: 'History & Nature', emoji: '⛩️' },
];

function getUserClaims(event) {
  return (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims) || {};
}

function getUserEmail(event) {
  const email = getUserClaims(event).email;
  return email ? String(email).toLowerCase() : null;
}

function getUserGroups(event) {
  const raw = getUserClaims(event)['cognito:groups'];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // Cognito sometimes serialises groups as "[Admins, Other]" — strip brackets/quotes
  return String(raw).replace(/[\[\]"\s]/g, '').split(',').filter(Boolean);
}

// [Feature #42] Server-side admin check — Cognito "Admins" group OR email whitelist
function isAdminEvent(event) {
  if (getUserGroups(event).includes(ADMIN_GROUP_NAME)) return true;
  const email = getUserEmail(event);
  return !!(email && ADMIN_EMAILS.has(email));
}

function requireAdmin(event) {
  if (!isAdminEvent(event)) {
    const err = new Error('Admin access required');
    err.statusCode = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
}

async function usernameFromSub(sub) {
  if (!USER_POOL_ID || !sub) return null;
  const safe = String(sub).replace(/"/g, '\\"');
  const res = await cognito.listUsers({
    UserPoolId: USER_POOL_ID,
    Filter: `sub = "${safe}"`,
    Limit: 1
  }).promise();
  if (!res.Users || res.Users.length === 0) return null;
  return res.Users[0].Username;
}

async function listAllCognitoUsers(maxTotal = 1000) {
  const out = [];
  let paginationToken;
  do {
    const res = await cognito.listUsers({
      UserPoolId: USER_POOL_ID,
      Limit: 60,
      PaginationToken: paginationToken
    }).promise();
    out.push(...(res.Users || []));
    paginationToken = res.PaginationToken;
  } while (paginationToken && out.length < maxTotal);
  return out;
}

async function listAdminGroupSubs() {
  const subs = new Set();
  let nextToken;
  try {
    do {
      const res = await cognito.listUsersInGroup({
        UserPoolId: USER_POOL_ID,
        GroupName: ADMIN_GROUP_NAME,
        Limit: 60,
        NextToken: nextToken
      }).promise();
      for (const u of res.Users || []) {
        const sub = (u.Attributes.find((a) => a.Name === 'sub') || {}).Value;
        if (sub) subs.add(sub);
      }
      nextToken = res.NextToken;
    } while (nextToken);
  } catch (e) {
    console.warn('listUsersInGroup failed (group may not exist yet):', e.message);
  }
  return subs;
}

async function queryAllTripsInGsi() {
  const trips = [];
  let lastKey;
  do {
    const res = await ddb.query({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TRIP' },
      ExclusiveStartKey: lastKey
    }).promise();
    trips.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return trips;
}

async function findTripByIdAnyOwner(tripId) {
  const res = await ddb.query({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    FilterExpression: 'tripId = :tid',
    ExpressionAttributeValues: { ':pk': 'TRIP', ':tid': tripId }
  }).promise();
  return (res.Items && res.Items[0]) || null;
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

// [Feature #28] Resolve trip access: owner, invited collaborator, or link-share viewer
async function resolveTripForUser(userId, tripId) {
  // 1. Owner: their own copy is stored directly under USER#userId
  const pointer = await getUserTripPointer(userId, tripId);
  if (pointer && pointer.entityType === 'Trip') {
    return { trip: pointer, access: { role: 'owner', ownerId: userId } };
  }

  // 2. Invited collaborator: explicit ACCESS record exists
  const access = await getTripAccess(userId, tripId);
  const ownerId = (access && access.ownerId) || (pointer && pointer.ownerId);
  if (ownerId) {
    const ownerTrip = await getUserTripPointer(ownerId, tripId);
    if (!ownerTrip || ownerTrip.deleted) return null;
    return { trip: ownerTrip, access: access || { role: 'viewer', ownerId } };
  }

  // 3. Link-sharing fallback: any authenticated TripWiz user with the URL gets
  //    read-only viewer access. Find the trip owner via the TRIP partition's
  //    access records (the owner record is always there after trip creation).
  const anyRes = await ddb.query({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
    ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': 'ACCESS#' },
    Limit: 1
  }).promise();
  const anyAccess = anyRes.Items && anyRes.Items[0];
  if (!anyAccess) return null;

  const ownerTrip = await getUserTripPointer(anyAccess.ownerId, tripId);
  if (!ownerTrip || ownerTrip.deleted) return null;
  return { trip: ownerTrip, access: { role: 'viewer', ownerId: anyAccess.ownerId } };
}

function publicTrip(item) {
  const { PK, SK, GSI1PK, tripStart, ...rest } = item;
  return rest;
}

function safeFileName(name) {
  const raw = String(name || 'document').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 140)
    .trim();
  return cleaned || 'document';
}

function fileExtension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function inferAttachmentType(fileName, fileType) {
  const explicit = String(fileType || '').toLowerCase().trim();
  if (explicit) return explicit;
  const ext = fileExtension(fileName);
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return '';
}

function validateAttachmentInput(input) {
  const fileName = safeFileName(input.fileName);
  const fileType = inferAttachmentType(fileName, input.fileType);
  const fileSize = Number(input.fileSize);
  const relatedItemType = String(input.relatedItemType || 'general').trim();
  const relatedItemId = input.relatedItemId ? String(input.relatedItemId).trim() : null;
  const extension = fileExtension(fileName);

  if (!fileName) {
    const e = new Error('fileName is required');
    e.statusCode = 400;
    e.code = 'INVALID_FILE';
    throw e;
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_ATTACHMENT_SIZE_BYTES) {
    const e = new Error('File must be 10 MB or smaller');
    e.statusCode = 400;
    e.code = 'FILE_TOO_LARGE';
    throw e;
  }
  if (!ALLOWED_ATTACHMENT_TYPES.has(fileType) || !ALLOWED_ATTACHMENT_TYPES.get(fileType).includes(extension)) {
    const e = new Error('Unsupported file type. Use PDF, PNG, JPG, JPEG, WEBP, or DOCX.');
    e.statusCode = 400;
    e.code = 'UNSUPPORTED_FILE_TYPE';
    throw e;
  }
  if (!ALLOWED_RELATED_ITEM_TYPES.has(relatedItemType)) {
    const e = new Error('relatedItemType must be flight, accommodation, rentalCar, or general');
    e.statusCode = 400;
    e.code = 'INVALID_RELATED_ITEM';
    throw e;
  }
  if (relatedItemType !== 'general' && !relatedItemId) {
    const e = new Error('relatedItemId is required for item-specific attachments');
    e.statusCode = 400;
    e.code = 'RELATED_ITEM_REQUIRED';
    throw e;
  }

  return { fileName, fileType, fileSize, relatedItemType, relatedItemId };
}

function publicAttachment(item) {
  if (!item) return null;
  const { PK, SK, ownerId, ...rest } = item;
  return rest;
}

async function requireTripAccess(userId, tripId, edit = false) {
  const resolved = await resolveTripForUser(userId, tripId);
  if (!resolved) {
    const e = new Error('Trip not found');
    e.statusCode = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (edit && !['owner', 'editor'].includes(resolved.access.role)) {
    const e = new Error('You cannot edit this trip');
    e.statusCode = 403;
    e.code = 'FORBIDDEN';
    throw e;
  }
  return resolved;
}

async function getAttachmentForTrip(userId, tripId, fileId, edit = false) {
  await requireTripAccess(userId, tripId, edit);
  const res = await ddb.get({
    TableName: TABLE_NAME,
    Key: { PK: `TRIP#${tripId}`, SK: `ATTACHMENT#${fileId}` }
  }).promise();
  if (!res.Item || res.Item.status !== 'uploaded') {
    const e = new Error('Attachment not found');
    e.statusCode = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }
  return res.Item;
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
  const emailVerified = (attrs.find((a) => a.Name === 'email_verified') || {}).Value === 'true';
  const confirmed = user.UserStatus === 'CONFIRMED' || emailVerified;
  return sub ? { userId: sub, email: (userEmail || email).toLowerCase(), emailVerified: confirmed } : null;
}

function formatTripDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function buildCollaboratorInviteEmailHtml({ tripTitle, tripId, inviterEmail, role, startDate, endDate }) {
  const tripUrl = `${FRONTEND_URL}/trips/${tripId}`;
  const roleLabel = role === 'editor' ? 'Editor' : 'Viewer';
  const dateLine = startDate
    ? `<p style="color:#4b5563;margin:0 0 16px;">Dates: <strong>${formatTripDate(startDate)}</strong>${endDate ? ` – <strong>${formatTripDate(endDate)}</strong>` : ''}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:14px 14px 0 0;padding:36px 32px;text-align:center;">
      <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:0 0 6px;letter-spacing:1.5px;text-transform:uppercase;">TripWiz</p>
      <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700;">You've been invited to a trip</h1>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:32px;">
      <p style="color:#4b5563;margin:0 0 16px;line-height:1.6;">
        <strong>${inviterEmail}</strong> invited you to collaborate on
        <strong>${tripTitle}</strong> as an <strong>${roleLabel}</strong>.
      </p>
      ${dateLine}
      <p style="color:#4b5563;margin:0 0 24px;line-height:1.6;">
        Sign in to TripWiz to view the itinerary, edit stops together in real time, and help plan the trip.
      </p>
      <div style="text-align:center;">
        <a href="${tripUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
          Open Trip
        </a>
      </div>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px;">
      You received this because a TripWiz user shared a trip with your account.
    </p>
  </div>
</body>
</html>`;
}

async function sendCollaboratorInviteEmail({ toEmail, tripTitle, tripId, inviterEmail, role, startDate, endDate }) {
  if (!SOURCE_EMAIL) {
    console.warn('SOURCE_EMAIL not configured — skipping collaborator invite email');
    return;
  }

  const subject = `You're invited to plan "${tripTitle}" on TripWiz`;
  const html = buildCollaboratorInviteEmailHtml({
    tripTitle,
    tripId,
    inviterEmail,
    role,
    startDate,
    endDate
  });

  await ses.sendEmail({
    Source: SOURCE_EMAIL,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: html, Charset: 'UTF-8' } }
    }
  }).promise();
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

// [Feature #20] AI route optimization via Amazon Bedrock (Claude Haiku 4.5)
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
      durationHours: s.duration || s.notes || '2'
    };
  });

  const systemPrompt = `You are TripWiz, an expert travel planner with deep knowledge of geography, logistics, and creating memorable travel experiences. When given a list of trip stops you reorder them day-by-day into the most logical, efficient, and enjoyable itinerary possible. You reason carefully about geography, travel time, meal timing, attraction types, and practical constraints.

CRITICAL CONSTRAINT — AIRPORTS, FLIGHTS & TERMINALS (ABSOLUTELY NON-NEGOTIABLE):
Any stop with type "airport" or "transit", OR whose name contains words like "airport", "terminal", "flight", "departure", or "arrival", is a FIXED TIME ANCHOR. You MUST:
- Keep it on its EXACT dayIndex — never reassign it to a different day
- Output its scheduledTime UNCHANGED in your JSON — do not alter it by even one minute
- Never reorder it relative to other fixed stops on the same day
These are real-world flights with real consequences. There are ZERO exceptions to this rule.`;

  const userPrompt = `Analyze the following trip itinerary and produce a detailed optimized schedule.

Stops:
${JSON.stringify(stops, null, 2)}

Rules:
1. NEVER change dayIndex or scheduledTime for any stop where isFixed=true. Output their times exactly as given.
2. Hotels obey isFirstInDay / isLastInDay — a check-out hotel must remain first in its day; a check-in hotel must remain last.
3. Reorder attraction stops within each day to minimize travel distance (use lat/lng) and create a pleasant, logical flow: breakfast cafes early morning, museums and landmarks mid-morning, parks and outdoor sights in the afternoon, restaurants at meal times.
4. Assign startTime for every stop in "HH:MM" 24-hour format. First attraction no earlier than 09:00; last stop should finish by 22:00. Allow 15 min travel buffer between stops plus each stop's durationHours (use the lower bound of any range).
5. Never move a stop to a different day. Never add or remove any stop.
6. Use exactly the stopIds provided.

Respond with ONLY a valid JSON object — absolutely no markdown fences, no prose outside the JSON:
{
  "stops": [
    {"stopId": "<id>", "dayIndex": <int>, "startTime": "HH:MM"}
  ],
  "reasoning": "Write 3-5 detailed paragraphs explaining your overall strategy: the geographic logic you used, how you handled any fixed anchors, why certain stops are grouped together, and the general experience you are trying to create for the traveler.",
  "dailySummary": [
    {
      "dayIndex": <int>,
      "heading": "Day N — <evocative theme or neighborhood name>",
      "description": "Write 3-5 sentences describing this specific day in detail: what the traveler will experience in sequence, why this order makes geographic and experiential sense, any notable transitions between areas, how travel time was managed, and what makes this day's flow enjoyable."
    }
  ]
}`;

  const res = await bedrock.invokeModel({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
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

  const dailySummary = Array.isArray(parsed.dailySummary)
    ? parsed.dailySummary
        .filter((d) => d && Number.isInteger(d.dayIndex) && typeof d.description === 'string')
        .map((d) => ({
          dayIndex: d.dayIndex,
          heading: typeof d.heading === 'string' ? d.heading : `Day ${d.dayIndex + 1}`,
          description: d.description
        }))
    : [];

  return {
    stops: cleanedStops,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    dailySummary,
    model: BEDROCK_MODEL_ID
  };
}

async function searchPlaces(query, biasLng, biasLat) {
  if (!query || query.length < 2) {
    const e = new Error('Query must be at least 2 characters');
    e.statusCode = 400;
    e.code = 'INVALID_QUERY';
    throw e;
  }

  const params = {
    IndexName: PLACE_INDEX_NAME,
    Text: query,
    MaxResults: 6,
    Language: 'en',
  };
  if (biasLng != null && biasLat != null) {
    params.BiasPosition = [parseFloat(biasLng), parseFloat(biasLat)];
  }

  const result = await location.searchPlaceIndexForText(params).promise();

  return (result.Results || []).map((r) => {
    const p = r.Place;
    const [lng, lat] = p.Geometry.Point;
    const parts = [p.Label];
    const short = (p.Label || '').split(',').slice(0, 2).join(',').trim();
    return {
      label: p.Label || '',
      short,
      lat,
      lng,
      categories: p.Categories || [],
      placeId: r.PlaceId || null,
    };
  });
}

// [Feature #19] Compute real road-route geometry per day via Amazon Location Service
async function calculateRoute(body) {
  const { stops } = body;
  if (!Array.isArray(stops) || stops.length < 2) {
    const e = new Error('At least two stops are required');
    e.statusCode = 400;
    e.code = 'INVALID_STOPS';
    throw e;
  }

  // Group stops by dayIndex
  const byDay = {};
  for (const s of stops) {
    const d = s.dayIndex ?? 0;
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(s);
  }

  const days = [];
  for (const [dayStr, dayStops] of Object.entries(byDay)) {
    const dayIndex = parseInt(dayStr, 10);
    if (dayStops.length < 2) {
      // Single stop — return just that point, no route needed
      days.push({ dayIndex, positions: [[dayStops[0].lat, dayStops[0].lng]] });
      continue;
    }

    const departure = [dayStops[0].lng, dayStops[0].lat];
    const destination = [dayStops[dayStops.length - 1].lng, dayStops[dayStops.length - 1].lat];
    const waypoints = dayStops.slice(1, -1).map((s) => ({ Position: [s.lng, s.lat] }));

    const params = {
      CalculatorName: ROUTE_CALCULATOR_NAME,
      DeparturePosition: departure,
      DestinationPosition: destination,
      TravelMode: 'Car',
      IncludeLegGeometry: true,
    };
    if (waypoints.length > 0) params.WaypointPositions = waypoints.map((w) => w.Position);

    const result = await location.calculateRoute(params).promise();

    // Flatten all leg geometries into a single ordered position list [lat, lng]
    const positions = [];
    for (const leg of result.Legs || []) {
      const pts = (leg.Geometry && leg.Geometry.LineString) || [];
      for (const [lng, lat] of pts) {
        positions.push([lat, lng]);
      }
    }

    days.push({ dayIndex, positions });
  }

  return { days };
}

// [Feature #29] After a REST save, broadcast the new trip to all connected collaborators
async function broadcastTripUpdate(tripId, trip, editorUserId) {
  if (!WS_ENDPOINT) return;
  const connections = await ddb.query({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `CONN#TRIP#${tripId}` }
  }).promise();
  if (!connections.Items || connections.Items.length === 0) return;

  const apigw = new AWS.ApiGatewayManagementApi({ endpoint: WS_ENDPOINT });
  const message = JSON.stringify({
    action: 'edit',
    tripId,
    userId: editorUserId,
    payload: { accepted: true, trip, version: trip.version }
  });

  await Promise.all(connections.Items.map(async (conn) => {
    try {
      await apigw.postToConnection({ ConnectionId: conn.connectionId, Data: message }).promise();
    } catch (err) {
      if (err.statusCode === 410) {
        await ddb.delete({
          TableName: TABLE_NAME,
          Key: { PK: `CONN#TRIP#${tripId}`, SK: `CONN#${conn.connectionId}` }
        }).promise();
      }
    }
  }));
}

exports.handler = async (event) => {
  console.log('REST event:', JSON.stringify({ resource: event.resource, method: event.httpMethod, path: event.path }));

  if (event.httpMethod === 'OPTIONS') return ok(200, {});

  const method = event.httpMethod;
  const path = event.resource;
  const userId = getUserId(event);

  if (!userId) return fail(401, 'UNAUTHORIZED', 'A valid Cognito JWT is required');

  try {
    // [Feature #10] List the signed-in user's (non-deleted) trips
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

    // [Feature #9] Create a trip + its owner access record
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

    // [Feature #28] Fetch a single trip + the caller's access role (owner/editor/viewer)
    if (method === 'GET' && path === '/trips/{tripId}') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');
      return ok(200, { trip: publicTrip(resolved.trip), access: resolved.access.role });
    }

    // [Feature #35] List a trip's uploaded documents
    if (method === 'GET' && path === '/trips/{tripId}/attachments') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      await requireTripAccess(userId, tripId, false);
      const res = await ddb.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
        FilterExpression: '#status = :uploaded',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':pk': `TRIP#${tripId}`,
          ':skp': 'ATTACHMENT#',
          ':uploaded': 'uploaded'
        }
      }).promise();
      const items = (res.Items || [])
        .map(publicAttachment)
        .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
      return ok(200, { items });
    }

    // [Feature #35] Issue a presigned S3 PUT URL for a trip document upload
    if (method === 'POST' && path === '/trips/{tripId}/attachments/upload-url') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      if (!DOCUMENTS_BUCKET) return fail(500, 'CONFIGURATION_ERROR', 'DOCUMENTS_BUCKET is not configured');
      const resolved = await requireTripAccess(userId, tripId, true);
      const input = validateAttachmentInput(parseBody(event));
      const fileId = `f-${uuid()}`;
      const s3Key = `trip-documents/${resolved.trip.ownerId}/${tripId}/${fileId}/${input.fileName}`;
      const uploadUrl = await s3.getSignedUrlPromise('putObject', {
        Bucket: DOCUMENTS_BUCKET,
        Key: s3Key,
        ContentType: input.fileType,
        Expires: 300,
      });
      return ok(200, { fileId, s3Key, uploadUrl, expiresIn: 300 });
    }

    // [Feature #35] Finalize an upload: verify the S3 object then record its metadata
    if (method === 'POST' && path === '/trips/{tripId}/attachments/{fileId}/complete') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      const fileId = event.pathParameters && event.pathParameters.fileId;
      if (!tripId || !fileId) return fail(400, 'BAD_REQUEST', 'tripId and fileId are required');
      if (!DOCUMENTS_BUCKET) return fail(500, 'CONFIGURATION_ERROR', 'DOCUMENTS_BUCKET is not configured');
      const resolved = await requireTripAccess(userId, tripId, true);
      const body = parseBody(event);
      const input = validateAttachmentInput(body);
      const s3Key = String(body.s3Key || '');
      const expectedPrefix = `trip-documents/${resolved.trip.ownerId}/${tripId}/${fileId}/`;
      if (!s3Key.startsWith(expectedPrefix)) return fail(400, 'INVALID_S3_KEY', 'Invalid attachment key');

      let head;
      try {
        head = await s3.headObject({ Bucket: DOCUMENTS_BUCKET, Key: s3Key }).promise();
      } catch (err) {
        return fail(400, 'UPLOAD_NOT_FOUND', 'Uploaded file was not found in storage');
      }
      if (Number(head.ContentLength || 0) !== input.fileSize) {
        return fail(400, 'UPLOAD_SIZE_MISMATCH', 'Uploaded file size does not match the requested file');
      }

      const now = new Date().toISOString();
      const item = {
        PK: `TRIP#${tripId}`,
        SK: `ATTACHMENT#${fileId}`,
        entityType: 'TripAttachment',
        fileId,
        tripId,
        ownerId: resolved.trip.ownerId,
        fileName: input.fileName,
        fileType: input.fileType,
        fileSize: input.fileSize,
        uploadedAt: now,
        uploadedBy: userId,
        s3Key,
        relatedItemType: input.relatedItemType,
        relatedItemId: input.relatedItemId,
        status: 'uploaded'
      };
      await ddb.put({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
      }).promise();
      return ok(201, { attachment: publicAttachment(item) });
    }

    // [Feature #35] Issue a presigned S3 GET URL to open a trip document
    if (method === 'GET' && path === '/trips/{tripId}/attachments/{fileId}/download-url') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      const fileId = event.pathParameters && event.pathParameters.fileId;
      if (!tripId || !fileId) return fail(400, 'BAD_REQUEST', 'tripId and fileId are required');
      if (!DOCUMENTS_BUCKET) return fail(500, 'CONFIGURATION_ERROR', 'DOCUMENTS_BUCKET is not configured');
      const attachment = await getAttachmentForTrip(userId, tripId, fileId, false);
      const downloadUrl = await s3.getSignedUrlPromise('getObject', {
        Bucket: DOCUMENTS_BUCKET,
        Key: attachment.s3Key,
        Expires: 300,
        ResponseContentDisposition: `inline; filename="${safeFileName(attachment.fileName)}"`
      });
      return ok(200, { downloadUrl, expiresIn: 300 });
    }

    // [Feature #35] Delete a trip document (S3 object + metadata)
    if (method === 'DELETE' && path === '/trips/{tripId}/attachments/{fileId}') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      const fileId = event.pathParameters && event.pathParameters.fileId;
      if (!tripId || !fileId) return fail(400, 'BAD_REQUEST', 'tripId and fileId are required');
      if (!DOCUMENTS_BUCKET) return fail(500, 'CONFIGURATION_ERROR', 'DOCUMENTS_BUCKET is not configured');
      const attachment = await getAttachmentForTrip(userId, tripId, fileId, true);
      try {
        await s3.deleteObject({ Bucket: DOCUMENTS_BUCKET, Key: attachment.s3Key }).promise();
      } catch (err) {
        if (err.code !== 'NoSuchKey' && err.code !== 'NotFound') throw err;
      }
      await ddb.delete({
        TableName: TABLE_NAME,
        Key: { PK: `TRIP#${tripId}`, SK: `ATTACHMENT#${fileId}` }
      }).promise();
      return noContent();
    }

    // [Feature #11][Feature #18][Feature #36] Update a trip with optimistic version control,
    // sync collaborator access, and broadcast the change to live editors
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

        // Broadcast to all other connected collaborators so they see the change live
        broadcastTripUpdate(tripId, publicTrip(updateRes.Attributes), userId).catch((e) =>
          console.warn('WS broadcast failed (non-fatal):', e.message)
        );

        return ok(200, { trip: publicTrip(updateRes.Attributes) });
      } catch (err) {
        if (err.code === 'ConditionalCheckFailedException') {
          return fail(409, 'VERSION_CONFLICT', 'Trip was updated by someone else');
        }
        throw err;
      }
    }

    // [Feature #13] Soft-delete a trip (owner only)
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

    // [Feature #23] Return stored weather alerts + last-validated timestamp
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

    // [Feature #24] Return stored indoor fallback suggestions per stop
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

    // [Feature #23] Return stored per-stop weather forecast data
    if (method === 'GET' && path === '/trips/{tripId}/weather') {
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const resolved = await resolveTripForUser(userId, tripId);
      if (!resolved) return fail(404, 'NOT_FOUND', 'Trip not found');

      const res = await ddb.query({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
        ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': 'WEATHER#' }
      }).promise();

      const weather = (res.Items || []).map((item) => {
        const { PK, SK, ttl, entityType, ...rest } = item;
        return rest;
      });

      const meta = await ddb.get({
        TableName: TABLE_NAME,
        Key: { PK: `TRIP#${tripId}`, SK: 'META#VALIDATION' }
      }).promise();

      return ok(200, {
        weather,
        count: weather.length,
        lastValidatedAt: meta.Item ? meta.Item.lastValidatedAt : null
      });
    }

    // [Feature #22] Trigger the weather validation Lambda asynchronously
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

    // [Feature #26] Invite a collaborator by email (owner only); grants editor access
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
      if (!invited.emailVerified) {
        return fail(400, 'EMAIL_NOT_VERIFIED', 'This user has not verified their email yet. Ask them to confirm their TripWiz account first.');
      }
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

      try {
        await sendCollaboratorInviteEmail({
          toEmail: invited.email,
          tripTitle: trip.title || 'Untitled Trip',
          tripId,
          inviterEmail: getUserEmail(event) || 'A TripWiz user',
          role: 'editor',
          startDate: trip.startDate,
          endDate: trip.endDate
        });
      } catch (err) {
        console.warn(`Collaborator invite email failed for trip=${tripId} to=${invited.email}:`, err.message);
      }

      return ok(200, {
        collaborator: { userId: invited.userId, email: invited.email, role: 'editor', addedAt: now }
      });
    }

    // [Feature #27] List a trip's collaborators
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

    // [Feature #27] Remove a collaborator (owner only)
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

    // [Feature #20] Run AI route optimization for this trip
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

    // [Feature #19] Calculate real road routes for the map
    if (method === 'POST' && path === '/routes/calculate') {
      const body = parseBody(event);
      const route = await calculateRoute(body);
      return ok(200, route);
    }

    // [Feature #15] Place search proxy (Amazon Location) for stop autocomplete
    if (method === 'GET' && path === '/places/search') {
      const q = (event.queryStringParameters || {}).q || '';
      const biasLng = (event.queryStringParameters || {}).lng;
      const biasLat = (event.queryStringParameters || {}).lat;
      const results = await searchPlaces(q, biasLng, biasLat);
      return ok(200, { results });
    }

    /* ─── Trending destinations (read = any signed-in user; write = admin) ─── */

    // [Feature #14] Read trending destinations for the user dashboard (built-in fallback)
    if (method === 'GET' && path === '/trending') {
      const res = await ddb.get({
        TableName: TABLE_NAME,
        Key: { PK: 'SETTINGS', SK: 'TRENDING' }
      }).promise();
      const destinations = (res.Item && Array.isArray(res.Item.destinations) && res.Item.destinations.length > 0)
        ? res.Item.destinations
        : DEFAULT_TRENDING;
      return ok(200, { destinations, updatedAt: res.Item && res.Item.updatedAt });
    }

    // [Feature #50] Admin: replace the trending destinations list
    if (method === 'PUT' && path === '/admin/trending') {
      requireAdmin(event);
      const body = parseBody(event);
      const destinations = Array.isArray(body.destinations) ? body.destinations.slice(0, 8) : [];
      const clean = destinations.map((d) => ({
        city:    String(d.city || '').slice(0, 80),
        country: String(d.country || '').slice(0, 80),
        tag:     String(d.tag || '').slice(0, 80),
        emoji:   String(d.emoji || '').slice(0, 8),
      }));
      await ddb.put({
        TableName: TABLE_NAME,
        Item: {
          PK: 'SETTINGS',
          SK: 'TRENDING',
          entityType: 'PlatformSettings',
          destinations: clean,
          updatedAt: new Date().toISOString(),
          updatedBy: getUserId(event) || 'unknown'
        }
      }).promise();
      return ok(200, { destinations: clean });
    }

    /* ─── Admin: metrics ─── */

    // [Feature #43] Admin: platform metrics (totals, active trips, recent activity feed)
    if (method === 'GET' && path === '/admin/metrics') {
      requireAdmin(event);

      const users = await listAllCognitoUsers();
      const trips = (await queryAllTripsInGsi()).filter((t) => !t.deleted);

      const nowIso = new Date().toISOString();
      const today = nowIso.slice(0, 10);
      const activeTrips = trips.filter((t) => {
        if (!t.startDate) return false;
        const start = t.startDate.slice(0, 10);
        const end   = (t.endDate || t.startDate).slice(0, 10);
        return start <= today && today <= end;
      }).length;

      const emailBySub = new Map();
      for (const u of users) {
        const sub   = (u.Attributes.find((a) => a.Name === 'sub')   || {}).Value;
        const email = (u.Attributes.find((a) => a.Name === 'email') || {}).Value;
        if (sub) emailBySub.set(sub, email || u.Username);
      }

      const userEvents = users.map((u) => ({
        type: 'user',
        when: u.UserCreateDate,
        message: `New user ${(u.Attributes.find((a) => a.Name === 'email') || {}).Value || u.Username} registered`,
      }));
      const tripEvents = trips.map((t) => ({
        type: 'trip',
        when: t.createdAt,
        message: `New trip "${t.title || 'Untitled'}" created`,
        ownerEmail: emailBySub.get(t.ownerId) || null,
      }));
      const recentActivity = [...userEvents, ...tripEvents]
        .filter((e) => e.when)
        .sort((a, b) => new Date(b.when) - new Date(a.when))
        .slice(0, 10);

      return ok(200, {
        totalUsers: users.length,
        totalTrips: trips.length,
        activeTrips,
        recentActivity,
      });
    }

    /* ─── Admin: users ─── */

    // [Feature #43] Admin: list all users with trip counts and admin flags
    if (method === 'GET' && path === '/admin/users') {
      requireAdmin(event);

      const [users, trips, adminSubs] = await Promise.all([
        listAllCognitoUsers(),
        queryAllTripsInGsi(),
        listAdminGroupSubs(),
      ]);

      const tripCountByOwner = new Map();
      for (const t of trips) {
        if (t.deleted || !t.ownerId) continue;
        tripCountByOwner.set(t.ownerId, (tripCountByOwner.get(t.ownerId) || 0) + 1);
      }

      const items = users.map((u) => {
        const sub   = (u.Attributes.find((a) => a.Name === 'sub')   || {}).Value;
        const email = (u.Attributes.find((a) => a.Name === 'email') || {}).Value;
        return {
          userId: sub,
          username: u.Username,
          email: email || u.Username,
          status: u.UserStatus,
          enabled: u.Enabled !== false,
          createdAt: u.UserCreateDate,
          tripsCount: tripCountByOwner.get(sub) || 0,
          isAdmin: (sub && adminSubs.has(sub)) || (email && ADMIN_EMAILS.has(email.toLowerCase())) || false,
        };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return ok(200, { items, count: items.length });
    }

    // [Feature #44] Admin: suspend (disable) a user's Cognito account
    if (method === 'POST' && path === '/admin/users/{userId}/suspend') {
      requireAdmin(event);
      const targetSub = event.pathParameters && event.pathParameters.userId;
      const username = await usernameFromSub(targetSub);
      if (!username) return fail(404, 'NOT_FOUND', 'User not found');
      await cognito.adminDisableUser({ UserPoolId: USER_POOL_ID, Username: username }).promise();
      return ok(200, { userId: targetSub, enabled: false });
    }

    // [Feature #44] Admin: unsuspend (re-enable) a user's Cognito account
    if (method === 'POST' && path === '/admin/users/{userId}/unsuspend') {
      requireAdmin(event);
      const targetSub = event.pathParameters && event.pathParameters.userId;
      const username = await usernameFromSub(targetSub);
      if (!username) return fail(404, 'NOT_FOUND', 'User not found');
      await cognito.adminEnableUser({ UserPoolId: USER_POOL_ID, Username: username }).promise();
      return ok(200, { userId: targetSub, enabled: true });
    }

    // [Feature #45] Admin: promote a user into the Cognito "Admins" group
    if (method === 'POST' && path === '/admin/users/{userId}/promote') {
      requireAdmin(event);
      const targetSub = event.pathParameters && event.pathParameters.userId;
      const username = await usernameFromSub(targetSub);
      if (!username) return fail(404, 'NOT_FOUND', 'User not found');
      await cognito.adminAddUserToGroup({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: ADMIN_GROUP_NAME
      }).promise();
      return ok(200, { userId: targetSub, isAdmin: true });
    }

    // [Feature #45] Admin: demote a user (guards against removing the last admin)
    if (method === 'POST' && path === '/admin/users/{userId}/demote') {
      requireAdmin(event);
      const targetSub = event.pathParameters && event.pathParameters.userId;
      const adminSubs = await listAdminGroupSubs();
      if (adminSubs.size <= 1 && adminSubs.has(targetSub)) {
        return fail(400, 'CANNOT_DEMOTE_LAST_ADMIN', 'Cannot demote the last remaining admin');
      }
      const username = await usernameFromSub(targetSub);
      if (!username) return fail(404, 'NOT_FOUND', 'User not found');
      await cognito.adminRemoveUserFromGroup({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: ADMIN_GROUP_NAME
      }).promise();
      return ok(200, { userId: targetSub, isAdmin: false });
    }

    // [Feature #46] Admin: delete a user — purge their DynamoDB partition + Cognito user
    if (method === 'DELETE' && path === '/admin/users/{userId}') {
      requireAdmin(event);
      const targetSub = event.pathParameters && event.pathParameters.userId;
      const username = await usernameFromSub(targetSub);

      // Purge their entire USER#sub partition in DynamoDB
      let lastKey;
      const keys = [];
      do {
        const res = await ddb.query({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `USER#${targetSub}` },
          ProjectionExpression: 'PK, SK',
          ExclusiveStartKey: lastKey
        }).promise();
        (res.Items || []).forEach((it) => keys.push({ PK: it.PK, SK: it.SK }));
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
      if (keys.length > 0) await deleteAll(keys);

      if (username) {
        try {
          await cognito.adminDeleteUser({ UserPoolId: USER_POOL_ID, Username: username }).promise();
        } catch (e) {
          console.warn('adminDeleteUser failed', e.message);
        }
      }
      return noContent();
    }

    /* ─── Admin: trip moderation ─── */

    // [Feature #47] Admin: list/search all trips with owner emails
    if (method === 'GET' && path === '/admin/trips') {
      requireAdmin(event);
      const q = ((event.queryStringParameters || {}).q || '').toLowerCase().trim();

      const [tripsRaw, users] = await Promise.all([
        queryAllTripsInGsi(),
        listAllCognitoUsers(),
      ]);

      const emailBySub = new Map();
      for (const u of users) {
        const sub   = (u.Attributes.find((a) => a.Name === 'sub')   || {}).Value;
        const email = (u.Attributes.find((a) => a.Name === 'email') || {}).Value;
        if (sub) emailBySub.set(sub, email || u.Username);
      }

      let trips = tripsRaw.filter((t) => !t.deleted);
      if (q) {
        trips = trips.filter((t) => {
          const inTitle = (t.title || '').toLowerCase().includes(q);
          const ownerEmail = emailBySub.get(t.ownerId) || '';
          const inOwner = ownerEmail.toLowerCase().includes(q);
          return inTitle || inOwner;
        });
      }

      const items = trips.map((t) => ({
        tripId: t.tripId,
        title: t.title || 'Untitled Trip',
        ownerId: t.ownerId,
        ownerEmail: emailBySub.get(t.ownerId) || null,
        startDate: t.startDate || null,
        endDate: t.endDate || null,
        hidden: !!t.hidden,
        itineraryLength: Array.isArray(t.itinerary) ? t.itinerary.length : 0,
        itinerary: Array.isArray(t.itinerary) ? t.itinerary : [],
        createdAt: t.createdAt,
      })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return ok(200, { items, count: items.length });
    }

    // [Feature #49] Admin: soft-delete any trip
    if (method === 'DELETE' && path === '/admin/trips/{tripId}') {
      requireAdmin(event);
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const trip = await findTripByIdAnyOwner(tripId);
      if (!trip) return fail(404, 'NOT_FOUND', 'Trip not found');
      await ddb.update({
        TableName: TABLE_NAME,
        Key: { PK: trip.PK, SK: trip.SK },
        UpdateExpression: 'SET deleted = :d, updatedAt = :u',
        ExpressionAttributeValues: { ':d': true, ':u': new Date().toISOString() }
      }).promise();
      return noContent();
    }

    // [Feature #48] Admin: hide / unhide a trip
    if (method === 'POST' && path === '/admin/trips/{tripId}/hide') {
      requireAdmin(event);
      const tripId = event.pathParameters && event.pathParameters.tripId;
      if (!tripId) return fail(400, 'BAD_REQUEST', 'tripId is required');
      const body = parseBody(event);
      const hidden = body.hidden !== false;
      const trip = await findTripByIdAnyOwner(tripId);
      if (!trip) return fail(404, 'NOT_FOUND', 'Trip not found');
      await ddb.update({
        TableName: TABLE_NAME,
        Key: { PK: trip.PK, SK: trip.SK },
        UpdateExpression: 'SET hidden = :h, updatedAt = :u',
        ExpressionAttributeValues: { ':h': hidden, ':u': new Date().toISOString() }
      }).promise();
      return ok(200, { tripId, hidden });
    }

    // [Feature #6][Feature #7] Read the user's saved preferences
    if (method === 'GET' && path === '/user/prefs') {
      const res = await ddb.get({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: 'PREFS' },
      }).promise();
      return ok(200, res.Item || {});
    }

    // [Feature #5][Feature #6][Feature #7] Save profile, regional prefs & notification toggles
    if (method === 'PUT' && path === '/user/prefs') {
      const body  = parseBody(event);
      const email = getUserEmail(event);
      const now   = new Date().toISOString();
      const item  = {
        PK:              `USER#${userId}`,
        SK:              'PREFS',
        entityType:      'UserPrefs',
        email,
        firstName:       typeof body.firstName === 'string' ? body.firstName.trim() : '',
        lastName:        typeof body.lastName  === 'string' ? body.lastName.trim()  : '',
        currency:        body.currency  || 'USD',
        timezone:        body.timezone  || 'America/New_York',
        language:        body.language  || 'en',
        notifyTrips:     body.notifyTrips     !== false,
        notifyMarketing: body.notifyMarketing === true,
        updatedAt:       now,
      };
      await ddb.put({ TableName: TABLE_NAME, Item: item }).promise();
      return ok(200, item);
    }

    return fail(404, 'NOT_FOUND', 'Route not found');
  } catch (err) {
    console.error('Handler error', err);
    return fail(err.statusCode || 500, err.code || 'INTERNAL_ERROR', err.message || 'Internal error');
  }
};
