function promiseResult(value) {
  return { promise: jest.fn().mockResolvedValue(value) };
}

function promiseReject(error) {
  return { promise: jest.fn().mockRejectedValue(error) };
}

function loadHandler({ ddb, lambda, secrets, fetchImpl }) {
  jest.resetModules();
  jest.doMock('aws-sdk', () => ({
    DynamoDB: { DocumentClient: jest.fn(() => ddb) },
    Lambda: jest.fn(() => lambda || { invoke: jest.fn(() => promiseResult({})) }),
    SecretsManager: jest.fn(() => secrets || { getSecretValue: jest.fn(() => promiseResult({ SecretString: '{}' })) })
  }));
  jest.doMock('node-fetch', () => fetchImpl || jest.fn());
  process.env.TABLE_NAME = 'TripWizTable';
  process.env.VALIDATE_FUNCTION_NAME = 'TripWiz-Validate';
  process.env.MAPPING_SECRET_ARN = 'mapping-secret';
  return require('./trips').handler;
}

function event({ method, resource, userId, tripId, body }) {
  return {
    httpMethod: method,
    resource,
    pathParameters: tripId ? { tripId } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: userId ? { claims: { sub: userId } } : undefined
    }
  };
}

describe('rest trip handler', () => {
  test('missing Cognito claims returns 401', async () => {
    const handler = loadHandler({ ddb: {} });

    const res = await handler(event({ method: 'GET', resource: '/trips' }));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  test('owner can create and list trips', async () => {
    const ddb = {
      put: jest.fn(() => promiseResult({})),
      batchWrite: jest.fn(() => promiseResult({})),
      query: jest.fn(() => promiseResult({ Items: [{ entityType: 'Trip', tripId: 't-1', ownerId: 'u-1', title: 'Rome' }] }))
    };
    const handler = loadHandler({ ddb });

    const createRes = await handler(event({
      method: 'POST',
      resource: '/trips',
      userId: 'u-1',
      body: { title: 'Rome', collaborators: ['u-2'] }
    }));
    const listRes = await handler(event({ method: 'GET', resource: '/trips', userId: 'u-1' }));

    expect(createRes.statusCode).toBe(201);
    expect(ddb.put).toHaveBeenCalledTimes(1);
    expect(ddb.batchWrite).toHaveBeenCalledTimes(1);
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body).items[0].tripId).toBe('t-1');
  });

  test('non-collaborator receives 403 when deleting someone else trip', async () => {
    const ddb = {
      get: jest.fn()
        .mockReturnValueOnce(promiseResult({}))
        .mockReturnValueOnce(promiseResult({ Item: { ownerId: 'u-1', role: 'editor' } }))
        .mockReturnValueOnce(promiseResult({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } }))
    };
    const handler = loadHandler({ ddb });

    const res = await handler(event({ method: 'DELETE', resource: '/trips/{tripId}', userId: 'u-2', tripId: 't-1' }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
  });

  test('version mismatch returns 409', async () => {
    const conditionalError = new Error('conflict');
    conditionalError.code = 'ConditionalCheckFailedException';
    const ddb = {
      get: jest.fn(() => promiseResult({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1', version: 2 } })),
      update: jest.fn(() => promiseReject(conditionalError))
    };
    const handler = loadHandler({ ddb });

    const res = await handler(event({
      method: 'PUT',
      resource: '/trips/{tripId}',
      userId: 'u-1',
      tripId: 't-1',
      body: { version: 1, title: 'Updated' }
    }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('VERSION_CONFLICT');
  });
});
