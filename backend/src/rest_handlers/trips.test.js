/**
 * @fileoverview Unit tests for the REST trip API handler.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

function loadHandler({ ddb = {}, s3Send, s3Presigner } = {}) {
  jest.resetModules();

  const ops = {
    get:        ddb.get        || jest.fn().mockResolvedValue({}),
    put:        ddb.put        || jest.fn().mockResolvedValue({}),
    update:     ddb.update     || jest.fn().mockResolvedValue({}),
    delete:     ddb.delete     || jest.fn().mockResolvedValue({}),
    query:      ddb.query      || jest.fn().mockResolvedValue({ Items: [] }),
    batchWrite: ddb.batchWrite || jest.fn().mockResolvedValue({}),
  };

  const mockDdb = {
    ...ops,
    send: jest.fn((cmd) => {
      const t = cmd.constructor.name;
      if (t === 'GetCommand')        return ops.get(cmd.input);
      if (t === 'PutCommand')        return ops.put(cmd.input);
      if (t === 'UpdateCommand')     return ops.update(cmd.input);
      if (t === 'DeleteCommand')     return ops.delete(cmd.input);
      if (t === 'QueryCommand')      return ops.query(cmd.input);
      if (t === 'BatchWriteCommand') return ops.batchWrite(cmd.input);
    }),
  };

  const mockS3Send = s3Send || jest.fn().mockImplementation((cmd) => {
    const t = cmd.constructor.name;
    if (t === 'HeadObjectCommand') return Promise.resolve({ ContentLength: 1 });
    return Promise.resolve({});
  });

  const mockGetSignedUrl = s3Presigner || jest.fn().mockResolvedValue('https://signed.example/upload');

  jest.doMock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn(() => ({})),
  }));

  jest.doMock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => mockDdb) },
    GetCommand:        class GetCommand        { constructor(i) { this.input = i; } },
    PutCommand:        class PutCommand        { constructor(i) { this.input = i; } },
    UpdateCommand:     class UpdateCommand     { constructor(i) { this.input = i; } },
    DeleteCommand:     class DeleteCommand     { constructor(i) { this.input = i; } },
    QueryCommand:      class QueryCommand      { constructor(i) { this.input = i; } },
    BatchWriteCommand: class BatchWriteCommand { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/client-lambda', () => ({
    LambdaClient:   jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
    InvokeCommand:  class InvokeCommand { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient:  jest.fn(() => ({ send: jest.fn().mockResolvedValue({ SecretString: '{}' }) })),
    GetSecretValueCommand: class GetSecretValueCommand { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/client-cognito-identity-provider', () => ({
    CognitoIdentityProviderClient:   jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Users: [] }) })),
    ListUsersCommand:                class { constructor(i) { this.input = i; } },
    ListUsersInGroupCommand:         class { constructor(i) { this.input = i; } },
    AdminDisableUserCommand:         class { constructor(i) { this.input = i; } },
    AdminEnableUserCommand:          class { constructor(i) { this.input = i; } },
    AdminAddUserToGroupCommand:      class { constructor(i) { this.input = i; } },
    AdminRemoveUserFromGroupCommand: class { constructor(i) { this.input = i; } },
    AdminDeleteUserCommand:          class { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/client-location', () => ({
    LocationClient:                jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Results: [] }) })),
    SearchPlaceIndexForTextCommand: class { constructor(i) { this.input = i; } },
    CalculateRouteCommand:         class { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/client-s3', () => ({
    S3Client:           jest.fn(() => ({ send: mockS3Send })),
    PutObjectCommand:   class { constructor(i) { this.input = i; } },
    GetObjectCommand:   class { constructor(i) { this.input = i; } },
    HeadObjectCommand:  class { constructor(i) { this.input = i; } },
    DeleteObjectCommand: class { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: mockGetSignedUrl,
  }));

  jest.doMock('@aws-sdk/client-apigatewaymanagementapi', () => ({
    ApiGatewayManagementApiClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
    PostToConnectionCommand: class { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/client-ses', () => ({
    SESClient:        jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
    SendEmailCommand: class { constructor(i) { this.input = i; } },
  }));

  jest.doMock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ body: Buffer.from('{"itinerary":[]}') }) })),
    InvokeModelCommand:   class { constructor(i) { this.input = i; } },
  }));

  jest.doMock('node-fetch', () => jest.fn());

  process.env.TABLE_NAME = 'TripWizTable';
  process.env.VALIDATE_FUNCTION_NAME = 'TripWiz-Validate';
  process.env.MAPPING_SECRET_ARN = 'mapping-secret';
  process.env.DOCUMENTS_BUCKET = 'tripwiz-documents';

  return { handler: require('./trips').handler, ddb: ops, getSignedUrl: mockGetSignedUrl, s3Send: mockS3Send };
}

function event({ method, resource, userId, tripId, fileId, body }) {
  return {
    httpMethod: method,
    resource,
    pathParameters: tripId ? { tripId, ...(fileId ? { fileId } : {}) } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: userId ? { claims: { sub: userId } } : undefined,
    },
  };
}

describe('rest trip handler', () => {
  test('missing Cognito claims returns 401', async () => {
    const { handler } = loadHandler({ ddb: {} });

    const res = await handler(event({ method: 'GET', resource: '/trips' }));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  test('owner can create and list trips', async () => {
    const ddb = {
      put:        jest.fn().mockResolvedValue({}),
      batchWrite: jest.fn().mockResolvedValue({}),
      query:      jest.fn().mockResolvedValue({ Items: [{ entityType: 'Trip', tripId: 't-1', ownerId: 'u-1', title: 'Rome' }] }),
    };
    const { handler, ddb: ops } = loadHandler({ ddb });

    const createRes = await handler(event({
      method: 'POST',
      resource: '/trips',
      userId: 'u-1',
      body: { title: 'Rome', collaborators: ['u-2'] },
    }));
    const listRes = await handler(event({ method: 'GET', resource: '/trips', userId: 'u-1' }));

    expect(createRes.statusCode).toBe(201);
    expect(ops.put).toHaveBeenCalledTimes(1);
    expect(ops.batchWrite).toHaveBeenCalledTimes(1);
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body).items[0].tripId).toBe('t-1');
  });

  test('non-collaborator receives 403 when deleting someone else trip', async () => {
    const ddb = {
      get: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Item: { ownerId: 'u-1', role: 'editor' } })
        .mockResolvedValueOnce({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1' } }),
    };
    const { handler } = loadHandler({ ddb });

    const res = await handler(event({ method: 'DELETE', resource: '/trips/{tripId}', userId: 'u-2', tripId: 't-1' }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
  });

  test('version mismatch returns 409', async () => {
    const conditionalError = Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
    const ddb = {
      get:    jest.fn().mockResolvedValue({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1', version: 2 } }),
      update: jest.fn().mockRejectedValue(conditionalError),
    };
    const { handler } = loadHandler({ ddb });

    const res = await handler(event({
      method: 'PUT',
      resource: '/trips/{tripId}',
      userId: 'u-1',
      tripId: 't-1',
      body: { version: 1, title: 'Updated' },
    }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('VERSION_CONFLICT');
  });

  test('attachment upload URL rejects unsupported file types before S3 signing', async () => {
    const mockGetSignedUrl = jest.fn();
    const ddb = {
      get: jest.fn().mockResolvedValue({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1', version: 1 } }),
    };
    const { handler } = loadHandler({ ddb, s3Presigner: mockGetSignedUrl });

    const res = await handler(event({
      method: 'POST',
      resource: '/trips/{tripId}/attachments/upload-url',
      userId: 'u-1',
      tripId: 't-1',
      body: {
        fileName: 'ticket.exe',
        fileType: 'application/x-msdownload',
        fileSize: 100,
        relatedItemType: 'flight',
        relatedItemId: 'flight-1',
      },
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('attachment complete does not create metadata when S3 upload is missing', async () => {
    const notFoundErr = Object.assign(new Error('missing'), { name: 'NotFound' });
    const mockS3Send = jest.fn().mockRejectedValue(notFoundErr);
    const ddb = {
      get: jest.fn().mockResolvedValue({ Item: { entityType: 'Trip', tripId: 't-1', ownerId: 'u-1', version: 1 } }),
      put: jest.fn().mockResolvedValue({}),
    };
    const { handler, ddb: ops } = loadHandler({ ddb, s3Send: mockS3Send });

    const res = await handler(event({
      method: 'POST',
      resource: '/trips/{tripId}/attachments/{fileId}/complete',
      userId: 'u-1',
      tripId: 't-1',
      fileId: 'f-1',
      body: {
        fileName: 'ticket.pdf',
        fileType: 'application/pdf',
        fileSize: 100,
        s3Key: 'trip-documents/u-1/t-1/f-1/ticket.pdf',
        relatedItemType: 'flight',
        relatedItemId: 'flight-1',
      },
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('UPLOAD_NOT_FOUND');
    expect(ops.put).not.toHaveBeenCalled();
  });
});
