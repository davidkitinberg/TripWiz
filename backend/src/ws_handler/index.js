/**
 * @fileoverview WebSocket Lambda handler for real-time trip join, edit, cursor, and presence.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

// [Review #3] Shared trip-access resolver — same rules as the REST handler (was a
// separate, drifting copy here that lacked the link-share fallback).
const { resolveTripForUser } = require('../lib/access');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME;
const CONNECTION_TTL_SECONDS = 24 * 60 * 60;

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body || {}) });

function getIdentity(event) {
  const auth = event.requestContext && event.requestContext.authorizer;
  return auth && (auth.principalId || auth.sub || (auth.claims && auth.claims.sub));
}

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return {};
  }
}

function connectionTtl() {
  return Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS;
}

async function getConnection(connectionId) {
  const res = await dynamodb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CONN#${connectionId}`, SK: 'META' }
  }));
  return res.Item || null;
}

async function broadcast(domain, stage, tripId, payload, skipConnectionId) {
  const connections = await dynamodb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `CONN#TRIP#${tripId}` }
  }));

  const api = new ApiGatewayManagementApiClient({ endpoint: `https://${domain}/${stage}` });
  await Promise.all((connections.Items || []).map(async (connection) => {
    if (connection.connectionId === skipConnectionId) return;
    try {
      await api.send(new PostToConnectionCommand({
        ConnectionId: connection.connectionId,
        Data: JSON.stringify(payload)
      }));
    } catch (err) {
      if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
        await dynamodb.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { PK: `CONN#TRIP#${tripId}`, SK: `CONN#${connection.connectionId}` }
        }));
      } else {
        throw err;
      }
    }
  }));
}

function buildEditUpdate(payload) {
  const expectedVersion = Number(payload && payload.expectedVersion);
  if (!expectedVersion) {
    const err = new Error('expectedVersion is required');
    err.statusCode = 400;
    throw err;
  }

  const patch = payload.tripPatch || (payload.field ? { [payload.field]: payload.newValue } : {});
  const allowed = ['title', 'startDate', 'endDate', 'itinerary', 'metadata'];
  const names = { '#version': 'version', '#updatedAt': 'updatedAt' };
  const values = {
    ':expectedVersion': expectedVersion,
    ':newVersion': expectedVersion + 1,
    ':updatedAt': new Date().toISOString()
  };
  const sets = ['#version = :newVersion', '#updatedAt = :updatedAt'];
  let index = 0;

  for (const field of allowed) {
    if (patch[field] !== undefined) {
      index += 1;
      names[`#f${index}`] = field;
      values[`:v${index}`] = patch[field];
      sets.push(`#f${index} = :v${index}`);
    }
  }

  if (patch.startDate !== undefined) {
    names['#tripStart'] = 'tripStart';
    values[':tripStart'] = patch.startDate;
    sets.push('#tripStart = :tripStart');
  }

  if (sets.length === 2) {
    const err = new Error('No supported edit fields provided');
    err.statusCode = 400;
    throw err;
  }

  return {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(SK) AND #version = :expectedVersion',
    ReturnValues: 'ALL_NEW'
  };
}

// [Feature #29] Real-time collaboration router: $connect/$disconnect, join/leave/edit,
//               broadcasting accepted edits to every other client in the trip room.
// [Feature #30] The "ping" action powers the client's presence/heartbeat indicator.
exports.handler = async (event) => {
  console.log('WebSocket event:', JSON.stringify({ routeKey: event.requestContext && event.requestContext.routeKey }));

  const routeKey = event.requestContext.routeKey;
  const connectionId = event.requestContext.connectionId;
  const domain = event.requestContext.domainName;
  const stage = event.requestContext.stage;
  let userId = getIdentity(event);

  if (routeKey === '$connect') {
    if (!userId) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Cognito identity is required' } });
    await dynamodb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `CONN#${connectionId}`,
        SK: 'META',
        entityType: 'Connection',
        connectionId,
        userId,
        joinedTrips: [],
        ttl: connectionTtl(),
        connectedAt: new Date().toISOString()
      }
    }));
    return json(200, { connected: true });
  }

  const connection = await getConnection(connectionId);
  userId = userId || (connection && connection.userId);
  if (!userId) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Cognito identity is required' } });

  if (routeKey === '$disconnect') {
    const joinedTrips = (connection && connection.joinedTrips) || [];
    await Promise.all(joinedTrips.map((tripId) => dynamodb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CONN#TRIP#${tripId}`, SK: `CONN#${connectionId}` }
    }))));
    await dynamodb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CONN#${connectionId}`, SK: 'META' }
    }));
    return json(200, { disconnected: true });
  }

  const body = parseBody(event);
  const action = body.action;

  if (action === 'ping') return json(200, { action: 'pong', ts: new Date().toISOString() });

  if (!body.tripId) return json(400, { error: { code: 'BAD_REQUEST', message: 'tripId is required' } });

  const resolved = await resolveTripForUser(userId, body.tripId);
  if (!resolved) return json(403, { error: { code: 'FORBIDDEN', message: 'You do not have access to this trip' } });
  const access = resolved.access;

  if (action === 'join') {
    await dynamodb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `CONN#TRIP#${body.tripId}`,
        SK: `CONN#${connectionId}`,
        entityType: 'TripConnection',
        tripId: body.tripId,
        connectionId,
        userId,
        ttl: connectionTtl(),
        joinedAt: new Date().toISOString()
      }
    }));

    await dynamodb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CONN#${connectionId}`, SK: 'META' },
      UpdateExpression: 'SET joinedTrips = list_append(if_not_exists(joinedTrips, :empty), :tripList), ttl = :ttl ADD joinedTripSet :tripSet',
      ExpressionAttributeValues: {
        ':tripSet': new Set([body.tripId]),
        ':tripList': [body.tripId],
        ':empty': [],
        ':ttl': connectionTtl()
      }
    }));

    return json(200, { joined: true, tripId: body.tripId });
  }

  if (action === 'leave') {
    await dynamodb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CONN#TRIP#${body.tripId}`, SK: `CONN#${connectionId}` }
    }));
    return json(200, { left: true, tripId: body.tripId });
  }

  if (action === 'cursor') {
    await broadcast(domain, stage, body.tripId, {
      action: 'cursor',
      tripId: body.tripId,
      userId,
      payload: body.payload || {}
    }, connectionId);
    return json(200, { broadcasted: true });
  }

  // [Feature #29] Apply a live edit (version-checked) and broadcast it to collaborators
  if (action === 'edit') {
    if (!['owner', 'editor'].includes(access.role)) {
      return json(403, { error: { code: 'FORBIDDEN', message: 'You cannot edit this trip' } });
    }

    try {
      const update = buildEditUpdate(body.payload || {});
      const result = await dynamodb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${access.ownerId}`, SK: `TRIP#${body.tripId}` },
        ...update
      }));

      const message = {
        action: 'edit',
        tripId: body.tripId,
        userId,
        payload: {
          accepted: true,
          trip: result.Attributes,
          version: result.Attributes.version
        }
      };
      await broadcast(domain, stage, body.tripId, message, connectionId);
      return json(200, message);
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        return json(409, { error: { code: 'VERSION_CONFLICT', message: 'Trip version conflict' } });
      }
      return json(err.statusCode || 500, { error: { code: 'EDIT_FAILED', message: err.message } });
    }
  }

  return json(400, { error: { code: 'INVALID_ACTION', message: 'Unsupported WebSocket action' } });
};
