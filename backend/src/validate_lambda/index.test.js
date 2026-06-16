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

function openMeteoForecast(startIso, pop, weathercode, windSpeed = 5, windGusts = 8, cloudCover = 0) {
  const hour = startIso.slice(0, 13) + ':00';
  const day = startIso.slice(0, 10);
  return {
    hourly_units: {
      windspeed_10m: 'kn',
      wind_gusts_10m: 'kn'
    },
    hourly: {
      time: [hour],
      temperature_2m: [22],
      apparent_temperature: [22],
      weathercode: [weathercode],
      windspeed_10m: [windSpeed],
      wind_gusts_10m: [windGusts],
      relativehumidity_2m: [65],
      precipitation_probability: [Math.round(pop * 100)],
      cloud_cover: [cloudCover]
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

function buildDdbWithTrip(trip) {
  return {
    query: jest.fn(() => promiseResult({ Items: [trip] })),
    get: jest.fn(() => promiseResult({})),
    batchWrite: jest.fn(() => promiseResult({})),
    put: jest.fn(() => promiseResult({}))
  };
}

async function runForecastCase({ title = 'Observation deck', pop = 0.1, weathercode = 0, windSpeed = 5, windGusts = 8, cloudCover = 0, activityType }) {
  const start = new Date().toISOString();
  const trip = {
    PK: 'USER#u-1',
    entityType: 'Trip',
    ownerId: 'u-1',
    tripId: 't-1',
    itinerary: [{ slotId: 's-1', title, start, coords: { lat: 32.08, lng: 34.78 }, ...(activityType ? { activityType } : {}) }]
  };
  const ddb = buildDdbWithTrip(trip);
  const sns = { publish: jest.fn(() => promiseResult({})) };
  const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
  const fetchImpl = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => openMeteoForecast(start, pop, weathercode, windSpeed, windGusts, cloudCover)
  });

  const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
  const res = await handler({});
  return { res, ddb, sns, fetchImpl };
}

function weatherPutItem(ddb) {
  return ddb.put.mock.calls.map(([params]) => params.Item).find((item) => item.entityType === 'WeatherData');
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

  test('requests wind speed in knots and hourly wind gusts from Open-Meteo', async () => {
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
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('wind_speed_unit=kn');
    expect(url).toContain('wind_gusts_10m');
    expect(url).toContain('cloud_cover');
  });

  test('classifies scenic view activities from scenic keywords', async () => {
    const { res, ddb } = await runForecastCase({ title: 'Panoramic viewpoint', cloudCover: 0 });

    expect(res.statusCode).toBe(200);
    expect(weatherPutItem(ddb).category).toBe('SCENIC_VIEW');
  });

  test('uses manual activity type before keyword detection', async () => {
    const { res, ddb, sns } = await runForecastCase({
      title: 'Panoramic viewpoint',
      activityType: 'INDOOR',
      pop: 0.9,
      weathercode: 61
    });

    expect(res.statusCode).toBe(200);
    expect(weatherPutItem(ddb).category).toBe('INDOOR');
    expect(JSON.parse(res.body).alertsPublished).toBe(0);
    expect(sns.publish).not.toHaveBeenCalled();
  });

  test('auto activity type keeps keyword-based detection', async () => {
    const { res, ddb } = await runForecastCase({
      title: 'Panoramic viewpoint',
      activityType: 'AUTO'
    });

    expect(res.statusCode).toBe(200);
    expect(weatherPutItem(ddb).category).toBe('SCENIC_VIEW');
  });

  test('publishes scenic view alert for mist or fog', async () => {
    const { res, sns } = await runForecastCase({ title: 'Mountain lookout', weathercode: 45 });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Low visibility expected due to fog or mist');
  });

  test('publishes scenic view alert when cloud cover is 6 oktas or higher', async () => {
    const { res, ddb, sns } = await runForecastCase({ title: 'Observation deck', cloudCover: 75 });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Cloud cover is 6/8 or higher');
    expect(weatherPutItem(ddb).cloudCoverPercent).toBe(75);
    expect(weatherPutItem(ddb).cloudCoverOktas).toBe(6);
  });

  test.each([
    [38, 3],
    [50, 4]
  ])('does not publish scenic cloud alert for %i percent cloud cover (%i oktas)', async (cloudCover, oktas) => {
    const { res, ddb, sns } = await runForecastCase({ title: 'Scenic viewpoint', cloudCover });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(0);
    expect(sns.publish).not.toHaveBeenCalled();
    expect(weatherPutItem(ddb).cloudCoverOktas).toBe(oktas);
  });

  test('scenic view uses the regular outdoor rain threshold', async () => {
    const lowRain = await runForecastCase({ title: 'Summit panorama', pop: 0.49, weathercode: 61 });
    const thresholdRain = await runForecastCase({ title: 'Summit panorama', pop: 0.50, weathercode: 61 });

    expect(JSON.parse(lowRain.res.body).alertsPublished).toBe(0);
    expect(lowRain.sns.publish).not.toHaveBeenCalled();
    expect(JSON.parse(thresholdRain.res.body).alertsPublished).toBe(1);
    expect(thresholdRain.sns.publish.mock.calls[0][0].Message).toContain('50% chance');
  });

  test('scenic view uses the regular outdoor sustained wind threshold', async () => {
    const { res, sns } = await runForecastCase({ title: 'Cable car viewpoint', windSpeed: 10, windGusts: 8 });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Wind speed is 10 knots or higher');
  });

  test('scenic view uses the regular outdoor wind gust threshold', async () => {
    const { res, sns } = await runForecastCase({ title: 'Gondola lookout', windSpeed: 5, windGusts: 15 });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Wind gusts are 15 knots or higher');
  });

  test('publishes outdoor alert when sustained wind reaches 10 knots', async () => {
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
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => openMeteoForecast(start, 0.1, 0, 10, 8) });

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Wind speed is 10 knots or higher');
  });

  test('publishes outdoor alert when wind gusts reach 15 knots', async () => {
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
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => openMeteoForecast(start, 0.1, 0, 5, 15) });

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Wind gusts are 15 knots or higher');
  });

  test('publishes ski alert when sustained wind reaches 20 knots', async () => {
    const start = new Date().toISOString();
    const trip = {
      PK: 'USER#u-1',
      entityType: 'Trip',
      ownerId: 'u-1',
      tripId: 't-1',
      itinerary: [{ slotId: 's-1', title: 'Ski lesson', start, coords: { lat: 46.02, lng: 7.75 } }]
    };
    const ddb = {
      query: jest.fn(() => promiseResult({ Items: [trip] })),
      get: jest.fn(() => promiseResult({})),
      batchWrite: jest.fn(() => promiseResult({})),
      put: jest.fn(() => promiseResult({}))
    };
    const sns = { publish: jest.fn(() => promiseResult({})) };
    const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => openMeteoForecast(start, 0.1, 71, 20, 8) });

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Ski wind speed is 20 knots or higher');
  });

  test('publishes ski alert when wind gusts reach 25 knots', async () => {
    const start = new Date().toISOString();
    const trip = {
      PK: 'USER#u-1',
      entityType: 'Trip',
      ownerId: 'u-1',
      tripId: 't-1',
      itinerary: [{ slotId: 's-1', title: 'Ski lesson', start, coords: { lat: 46.02, lng: 7.75 } }]
    };
    const ddb = {
      query: jest.fn(() => promiseResult({ Items: [trip] })),
      get: jest.fn(() => promiseResult({})),
      batchWrite: jest.fn(() => promiseResult({})),
      put: jest.fn(() => promiseResult({}))
    };
    const sns = { publish: jest.fn(() => promiseResult({})) };
    const secrets = { getSecretValue: jest.fn(() => promiseResult({ SecretString: JSON.stringify({ apiKey: 'fake-key' }) })) };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => openMeteoForecast(start, 0.1, 71, 5, 25) });

    const handler = loadHandler({ ddb, sns, secrets, fetchImpl });
    const res = await handler({});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alertsPublished).toBe(1);
    expect(sns.publish.mock.calls[0][0].Message).toContain('Ski wind gusts are 25 knots or higher');
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
