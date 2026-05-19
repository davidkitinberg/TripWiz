function loadHandler({ ddb, sns, secrets, fetchImpl }) {
  jest.resetModules();
  jest.doMock('aws-sdk', () => ({
    DynamoDB: { DocumentClient: jest.fn(() => ddb) },
    SNS: jest.fn(() => sns),
    SecretsManager: jest.fn(() => secrets)
  }));
  jest.doMock('node-fetch', () => fetchImpl || jest.fn());
  return require('./index').handler;
}

function promiseResult(value) {
  return { promise: jest.fn().mockResolvedValue(value) };
}

function setupEnv() {
  process.env.TABLE_NAME = 'TripWizTable';
  process.env.OPENWEATHER_SECRET_ARN = 'weather-secret';
  process.env.ALERTS_TOPIC_ARN = 'alerts-topic';
}

describe('validate_lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupEnv();
  });

  test('publishes alert when forecast predicts rain for outdoor slot', async () => {
    const trip = {
      PK: 'USER#u-1',
      entityType: 'Trip',
      ownerId: 'u-1',
      tripId: 't-1',
      title: 'Rainy Trip',
      itinerary: [{ slotId: 's-1', start: new Date().toISOString(), coords: { lat: 32.08, lng: 34.78 } }]
    };
    const ddb = {
      query: jest.fn(() => promiseResult({ Items: [trip] })),
      get: jest.fn(() => promiseResult({}))
    };
    const sns = { publish: jest.fn(() => promiseResult({})) };
    const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ hourly: [{ dt: Math.floor(Date.now() / 1000), pop: 0.8, weather: [{ main: 'Rain' }] }] }) });

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish).toHaveBeenCalledTimes(1);
  });

  test('does not publish alert for clear weather', async () => {
    const trip = {
      PK: 'USER#u-1',
      entityType: 'Trip',
      ownerId: 'u-1',
      tripId: 't-1',
      itinerary: [{ slotId: 's-1', start: new Date().toISOString(), coords: { lat: 32.08, lng: 34.78 } }]
    };
    const ddb = {
      query: jest.fn(() => promiseResult({ Items: [trip] })),
      get: jest.fn(() => promiseResult({}))
    };
    const sns = { publish: jest.fn(() => promiseResult({})) };
    const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ hourly: [{ dt: Math.floor(Date.now() / 1000), pop: 0.1, weather: [{ main: 'Clear' }] }] }) });

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(0);
    expect(sns.publish).not.toHaveBeenCalled();
  });

  test('skips slots without coordinates safely', async () => {
    const trip = {
      PK: 'USER#u-1',
      entityType: 'Trip',
      ownerId: 'u-1',
      tripId: 't-1',
      itinerary: [{ slotId: 's-1', start: new Date().toISOString() }]
    };
    const ddb = {
      query: jest.fn(() => promiseResult({ Items: [trip] })),
      get: jest.fn(() => promiseResult({}))
    };
    const sns = { publish: jest.fn(() => promiseResult({})) };
    const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
    const fetchImpl = jest.fn();

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sns.publish).not.toHaveBeenCalled();
  });

  test('missing configuration returns controlled error', async () => {
    delete process.env.OPENWEATHER_SECRET_ARN;
    const handler = loadHandler({
      ddb: {},
      sns: {},
      secrets: {}
    });

    const res = await handler({});

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('CONFIGURATION_ERROR');
  });
});
