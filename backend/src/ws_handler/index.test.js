/**
 * @fileoverview Unit tests for the WebSocket collaboration handler.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

function makeCommands() {
  return {
    GetCommand:    class GetCommand    { constructor(i) { this.input = i; } },
    PutCommand:    class PutCommand    { constructor(i) { this.input = i; } },
    UpdateCommand: class UpdateCommand { constructor(i) { this.input = i; } },
    DeleteCommand: class DeleteCommand { constructor(i) { this.input = i; } },
    QueryCommand:  class QueryCommand  { constructor(i) { this.input = i; } },
  };
}

function loadHandler({ ddb = {}, api } = {}) {
  jest.resetModules();

  const ops = {
    get:    ddb.get    || jest.fn().mockResolvedValue({}),
    put:    ddb.put    || jest.fn().mockResolvedValue({}),
    update: ddb.update || jest.fn().mockResolvedValue({}),
    query:  ddb.query  || jest.fn().mockResolvedValue({ Items: [] }),
    delete: ddb.delete || jest.fn().mockResolvedValue({}),
  };

  const mockDdb = {
    ...ops,
    send: jest.fn((cmd) => {
      const t = cmd.constructor.name;
      if (t === 'GetCommand')    return ops.get(cmd.input);
      if (t === 'PutCommand')    return ops.put(cmd.input);
      if (t === 'UpdateCommand') return ops.update(cmd.input);
      if (t === 'DeleteCommand') return ops.delete(cmd.input);
      if (t === 'QueryCommand')  return ops.query(cmd.input);
    }),
  };

  const mockApi = api || { postToConnection: jest.fn().mockResolvedValue({}) };

  jest.doMock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn(() => ({})),
  }));

  jest.doMock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => mockDdb) },
    ...makeCommands(),
  }));

  jest.doMock('@aws-sdk/client-apigatewaymanagementapi', () => ({
    ApiGatewayManagementApiClient: jest.fn(() => ({
      send: jest.fn((cmd) => mockApi.postToConnection(cmd.input)),
    })),
    PostToConnectionCommand: class PostToConnectionCommand { constructor(i) { this.input = i; } },
  }));

  process.env.TABLE_NAME = 'TripWizTable';
  return { handler: require('./index').handler, ddb: ops, api: mockApi };
}

function event({ routeKey = 'sendMessage', connectionId = 'c-1', userId, body } = {}) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      routeKey,
      connectionId,
      domainName: 'example.execute-api.us-east-1.amazonaws.com',
      stage: 'prod',
      authorizer: userId ? { principalId: userId } : undefined,
    },
  };
}

describe('websocket handler', () => {
  test('join stores connection under trip', async () => {
    const ddb = {
      get: jest.fn()
        .mockResolvedValueOnce({ Item: { userId: 'u-1', joinedTrips: [] } })
        .mockResolvedValueOnce({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } }),
      put:    jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    };
    const { handler, ddb: ops } = loadHandler({ ddb });

    const res = await handler(event({ body: { action: 'join', tripId: 't-1' } }));

    expect(res.statusCode).toBe(200);
    expect(ops.put).toHaveBeenCalledWith(expect.objectContaining({
      Item: expect.objectContaining({ PK: 'CONN#TRIP#t-1', connectionId: 'c-1', userId: 'u-1' }),
    }));
  });

  test('edit applies optimistic concurrency and broadcasts accepted delta', async () => {
    const ddb = {
      get: jest.fn()
        .mockResolvedValueOnce({ Item: { userId: 'u-1', joinedTrips: ['t-1'] } })
        .mockResolvedValueOnce({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } }),
      update: jest.fn().mockResolvedValue({ Attributes: { tripId: 't-1', ownerId: 'u-1', version: 2, title: 'Paris' } }),
      query:  jest.fn().mockResolvedValue({ Items: [{ connectionId: 'c-1' }, { connectionId: 'c-2' }] }),
      delete: jest.fn().mockResolvedValue({}),
    };
    const api = { postToConnection: jest.fn().mockResolvedValue({}) };
    const { handler, ddb: ops } = loadHandler({ ddb, api });

    const res = await handler(event({
      body: { action: 'edit', tripId: 't-1', payload: { expectedVersion: 1, tripPatch: { title: 'Paris' } } },
    }));

    expect(res.statusCode).toBe(200);
    expect(ops.update).toHaveBeenCalledWith(expect.objectContaining({
      Key: { PK: 'USER#u-1', SK: 'TRIP#t-1' },
      ConditionExpression: 'attribute_exists(SK) AND #version = :expectedVersion',
    }));
    expect(api.postToConnection).toHaveBeenCalledTimes(1);
    expect(api.postToConnection).toHaveBeenCalledWith(expect.objectContaining({ ConnectionId: 'c-2' }));
  });

  test('stale 410 connection is deleted during broadcast', async () => {
    const stale = Object.assign(new Error('gone'), { statusCode: 410 });
    const ddb = {
      get: jest.fn()
        .mockResolvedValueOnce({ Item: { userId: 'u-1', joinedTrips: ['t-1'] } })
        .mockResolvedValueOnce({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } }),
      update: jest.fn().mockResolvedValue({ Attributes: { tripId: 't-1', ownerId: 'u-1', version: 2 } }),
      query:  jest.fn().mockResolvedValue({ Items: [{ connectionId: 'c-2' }] }),
      delete: jest.fn().mockResolvedValue({}),
    };
    const api = { postToConnection: jest.fn().mockRejectedValue(stale) };
    const { handler, ddb: ops } = loadHandler({ ddb, api });

    const res = await handler(event({
      connectionId: 'c-1',
      body: { action: 'edit', tripId: 't-1', payload: { expectedVersion: 1, tripPatch: { title: 'Paris' } } },
    }));

    expect(res.statusCode).toBe(200);
    expect(ops.delete).toHaveBeenCalledWith(expect.objectContaining({
      Key: { PK: 'CONN#TRIP#t-1', SK: 'CONN#c-2' },
    }));
  });
});
