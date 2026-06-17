'use strict';

const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const keys = require('./keys');

// [Review #3] Single, authoritative trip-access resolver shared by the REST handler and
// the WebSocket handler. Previously each maintained its own copy: the REST version had a
// link-share fallback, the WS version did not, and the two were drifting. Both now call
// this one function, so the access rules can never disagree.

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

async function getUserTripPointer(userId, tripId) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: keys.userPk(userId), SK: keys.tripSk(tripId) }
  }));
  return res.Item || null;
}

async function getTripAccessRecord(userId, tripId) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: keys.tripPk(tripId), SK: keys.accessSk(userId) }
  }));
  return res.Item || null;
}

// [Feature #28] Resolve a trip for a user: owner, invited collaborator, or — only when the
// owner has explicitly enabled sharing ([Review #7]) — a read-only link-share viewer.
// Returns { trip, access: { role, ownerId } } or null.
async function resolveTripForUser(userId, tripId) {
  // 1. Owner: their own copy is stored directly under USER#userId
  const pointer = await getUserTripPointer(userId, tripId);
  if (pointer && pointer.entityType === 'Trip') {
    if (pointer.deleted) return null;
    return { trip: pointer, access: { role: 'owner', ownerId: userId } };
  }

  // 2. Invited collaborator: an explicit ACCESS record exists
  const access = await getTripAccessRecord(userId, tripId);
  const ownerId = (access && access.ownerId) || (pointer && pointer.ownerId);
  if (ownerId) {
    const ownerTrip = await getUserTripPointer(ownerId, tripId);
    if (!ownerTrip || ownerTrip.deleted) return null;
    return { trip: ownerTrip, access: access || { role: 'viewer', ownerId } };
  }

  // 3. Link-share fallback: any authenticated user with the URL gets read-only viewer
  //    access — but ONLY if the owner turned sharing on. [Review #7] gates what used to
  //    be implicitly-always-on link sharing behind an explicit per-trip flag.
  const anyRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
    ExpressionAttributeValues: { ':pk': keys.tripPk(tripId), ':skp': keys.PREFIX.access },
    Limit: 1
  }));
  const anyAccess = anyRes.Items && anyRes.Items[0];
  if (!anyAccess) return null;

  const ownerTrip = await getUserTripPointer(anyAccess.ownerId, tripId);
  if (!ownerTrip || ownerTrip.deleted) return null;
  if (ownerTrip.shareEnabled !== true) return null;
  return { trip: ownerTrip, access: { role: 'viewer', ownerId: anyAccess.ownerId } };
}

module.exports = { resolveTripForUser, getUserTripPointer, getTripAccessRecord };
