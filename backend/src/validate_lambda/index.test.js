/**
 * @fileoverview Unit tests for the weather validation Lambda.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

function loadHandler({ ddb, sns, secrets, fetchImpl }) {
  jest.resetModules();
  jest.doMock('aws-sdk', () => ({
    DynamoDB: { DocumentClient: jest.fn(() => ddb) },
    SNS: jest.fn(() => sns),
    SecretsManager: jest.fn(() => secrets),
    Location: jest.fn(() => ({ searchPlaceIndexForPosition: jest.fn(() => promiseResult({ Results: [] })) }))
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

function openMeteoForecast(startIso, pop, weathercode) {
  const hour = startIso.slice(0, 13) + ':00';
  const day = startIso.slice(0, 10);
  return {
    hourly: {
      time: [hour],
      temperature_2m: [22],
      apparent_temperature: [22],
      weathercode: [weathercode],
      windspeed_10m: [12],
      relativehumidity_2m: [65],
      precipitation_probability: [Math.round(pop * 100)]
    },
    daily: {
      time: [day],
      weathercode: [weathercode],
      temperature_2m_max: [24],
      temperature_2m_min: [18],
      precipitation_probability_max: [Math.round(pop * 100)]
    }
  };
}

describe('validate_lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupEnv();
  });

  test('publishes alert when forecast predicts rain for outdoor slot', async () => {
    const start = new Date().toISOString();
    const trip = {
      PK: 'USER#u-1',
      entityType: 'Trip',
      ownerId: 'u-1',
      tripId: 't-1',
      title: 'Rainy Trip',
      itinerary: [{ slotId: 's-1', start, coords: { lat: 32.08, lng: 34.78 } }]
    };
    const ddb = {
      query: jest.fn(() => promiseResult({ Items: [trip] })),
      get: jest.fn(() => promiseResult({})),
      batchWrite: jest.fn(() => promiseResult({})),
      put: jest.fn(() => promiseResult({}))
    };
    const sns = { publish: jest.fn(() => promiseResult({})) };
    const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => openMeteoForecast(start, 0.8, 61) });

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish).toHaveBeenCalledTimes(1);
  });

  test('does not publish alert for clear weather', async () => {
    const start = new Date().toISOString();
    const trip = {
      PK: 'USER#u-1',
      entityType: 'Trip',
      ownerId: 'u-1',
      tripId: 't-1',
      itinerary: [{ slotId: 's-1', start, coords: { lat: 32.08, lng: 34.78 } }]
    };
    const ddb = {
      query: jest.fn(() => promiseResult({ Items: [trip] })),
      get: jest.fn(() => promiseResult({})),
      batchWrite: jest.fn(() => promiseResult({})),
      put: jest.fn(() => promiseResult({}))
    };
    const sns = { publish: jest.fn(() => promiseResult({})) };
    const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => openMeteoForecast(start, 0.1, 0) });

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
      get: jest.fn(() => promiseResult({})),
      batchWrite: jest.fn(() => promiseResult({})),
      put: jest.fn(() => promiseResult({}))
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
    delete process.env.TABLE_NAME;
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
