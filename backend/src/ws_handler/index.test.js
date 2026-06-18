/**
 * @fileoverview Unit tests for the WebSocket collaboration handler.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

function promiseResult(value) {
  return { promise: jest.fn().mockResolvedValue(value) };
}

function promiseReject(error) {
  return { promise: jest.fn().mockRejectedValue(error) };
}

function loadHandler({ ddb, api }) {
  jest.resetModules();
  jest.doMock('aws-sdk', () => ({
    DynamoDB: { DocumentClient: jest.fn(() => ddb) },
    ApiGatewayManagementApi: jest.fn(() => api || { postToConnection: jest.fn(() => promiseResult({})) })
  }));
  process.env.TABLE_NAME = 'TripWizTable';
  return require('./index').handler;
}

function event({ routeKey = 'sendMessage', connectionId = 'c-1', userId, body }) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      routeKey,
      connectionId,
      domainName: 'example.execute-api.us-east-1.amazonaws.com',
      stage: 'prod',
      authorizer: userId ? { principalId: userId } : undefined
    }
  };
}

describe('websocket handler', () => {
  test('join stores connection under trip', async () => {
    const ddb = {
      get: jest.fn()
        .mockReturnValueOnce(promiseResult({ Item: { userId: 'u-1', joinedTrips: [] } }))
        .mockReturnValueOnce(promiseResult({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } })),
      put: jest.fn(() => promiseResult({})),
      update: jest.fn(() => promiseResult({})),
      createSet: jest.fn((values) => values)
    };
    const handler = loadHandler({ ddb });

    const res = await handler(event({ body: { action: 'join', tripId: 't-1' } }));

    expect(res.statusCode).toBe(200);
    expect(ddb.put).toHaveBeenCalledWith(expect.objectContaining({
      Item: expect.objectContaining({ PK: 'CONN#TRIP#t-1', connectionId: 'c-1', userId: 'u-1' })
    }));
  });

  test('edit applies optimistic concurrency and broadcasts accepted delta', async () => {
    const ddb = {
      get: jest.fn()
        .mockReturnValueOnce(promiseResult({ Item: { userId: 'u-1', joinedTrips: ['t-1'] } }))
        .mockReturnValueOnce(promiseResult({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } })),
      update: jest.fn(() => promiseResult({ Attributes: { tripId: 't-1', ownerId: 'u-1', version: 2, title: 'Paris' } })),
      query: jest.fn(() => promiseResult({ Items: [{ connectionId: 'c-1' }, { connectionId: 'c-2' }] })),
      delete: jest.fn(() => promiseResult({}))
    };
    const api = { postToConnection: jest.fn(() => promiseResult({})) };
    const handler = loadHandler({ ddb, api });

    const res = await handler(event({
      body: { action: 'edit', tripId: 't-1', payload: { expectedVersion: 1, tripPatch: { title: 'Paris' } } }
    }));

    expect(res.statusCode).toBe(200);
    expect(ddb.update).toHaveBeenCalledWith(expect.objectContaining({
      Key: { PK: 'USER#u-1', SK: 'TRIP#t-1' },
      ConditionExpression: 'attribute_exists(SK) AND #version = :expectedVersion'
    }));
    expect(api.postToConnection).toHaveBeenCalledTimes(1);
    expect(api.postToConnection).toHaveBeenCalledWith(expect.objectContaining({ ConnectionId: 'c-2' }));
  });

  test('stale 410 connection is deleted during broadcast', async () => {
    const stale = new Error('gone');
    stale.statusCode = 410;
    const ddb = {
      get: jest.fn()
        .mockReturnValueOnce(promiseResult({ Item: { userId: 'u-1', joinedTrips: ['t-1'] } }))
        .mockReturnValueOnce(promiseResult({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } })),
      update: jest.fn(() => promiseResult({ Attributes: { tripId: 't-1', ownerId: 'u-1', version: 2 } })),
      query: jest.fn(() => promiseResult({ Items: [{ connectionId: 'c-2' }] })),
      delete: jest.fn(() => promiseResult({}))
    };
    const api = { postToConnection: jest.fn(() => promiseReject(stale)) };
    const handler = loadHandler({ ddb, api });

    const res = await handler(event({
      connectionId: 'c-1',
      body: { action: 'edit', tripId: 't-1', payload: { expectedVersion: 1, tripPatch: { title: 'Paris' } } }
    }));

    expect(res.statusCode).toBe(200);
    expect(ddb.delete).toHaveBeenCalledWith(expect.objectContaining({
      Key: { PK: 'CONN#TRIP#t-1', SK: 'CONN#c-2' }
    }));
  });
});
