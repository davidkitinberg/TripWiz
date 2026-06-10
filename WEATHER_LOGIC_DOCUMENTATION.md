# TripWiz Weather Logic Documentation

This document describes the current weather feature as implemented in the project. It documents the code as it exists now, including the currently modified wind logic in `backend/src/validate_lambda/index.js`.

## 1. External APIs And Providers

### Weather Forecast Data

| Provider | Used For | Backend/Frontend | File | Function |
|---|---|---:|---|---|
| Open-Meteo | 16-day forecast data for scheduled trip stops | Backend | `backend/src/validate_lambda/index.js` | `fetchForecast(lat, lon)` |

The active weather provider is Open-Meteo. The validator calls `https://api.open-meteo.com/v1/forecast` directly using `node-fetch`. No API key is used.

There are stale OpenWeather references in the project:

- `backend/infra/template.yaml:570-574` creates a `TripWiz/OpenWeatherApiKey` secret.
- `backend/README.md` and `backend/infra/notes.md` mention populating OpenWeather secrets.
- `frontend/src/pages/TripPage.jsx:1043-1044` has timeout copy mentioning OpenWeather.
- `backend/src/validate_lambda/index.test.js:19` sets `OPENWEATHER_SECRET_ARN` in test setup.

Those references are not used by the current validator. `backend/src/validate_lambda/index.js` reads only `TABLE_NAME`, `ALERTS_TOPIC_ARN`, and `PLACE_INDEX_NAME` for weather validation.

### Geocoding, Place Search, Fallbacks, And Routing

| Provider | Used For | Backend/Frontend | File | Function |
|---|---|---:|---|---|
| AWS Location Service Place Index, Esri data source | Backend place search proxy | Backend | `backend/src/rest_handlers/trips.js` | `searchPlaces(query, biasLng, biasLat)` |
| AWS Location Service Place Index, Esri data source | Indoor fallback suggestions after weather alerts | Backend | `backend/src/validate_lambda/index.js` | `findFallbacks(coords, max = 5)` |
| AWS Location Service Route Calculator, Esri data source | Road-following route geometry for itinerary map | Backend | `backend/src/rest_handlers/trips.js` | `calculateRoute(body)` |
| OpenStreetMap Nominatim | Frontend trip-stop autocomplete and coordinate lookup | Frontend | `frontend/src/pages/TripPage.jsx` | `searchNominatim(query)` |
| OpenStreetMap Nominatim | Home page location suggestions | Frontend | `frontend/src/pages/HomePage.jsx` | `LocationAutocomplete` effect |
| Leaflet + React Leaflet | Interactive map rendering | Frontend | `frontend/src/components/TripMap.jsx` | `TripMap({ dayGroups })` |
| OpenStreetMap tile server | Map tile display | Frontend | `frontend/src/components/TripMap.jsx` | `TileLayer` |

Google Maps and Mapbox are not used in the searched project files. The map display is Leaflet with OpenStreetMap tiles.

## 2. API Endpoints And Request Parameters

### Open-Meteo Forecast Request

Built in `backend/src/validate_lambda/index.js:64-75`, function `fetchForecast(lat, lon)`.

URL structure:

```text
https://api.open-meteo.com/v1/forecast
  ?latitude={lat}&longitude={lon}
  &hourly=temperature_2m,apparent_temperature,weathercode,windspeed_10m,wind_gusts_10m,relativehumidity_2m,precipitation_probability,cloud_cover
  &daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max
  &wind_speed_unit=kn
  &timezone=auto&forecast_days=16
```

Parameters:

| Parameter | Value | Meaning |
|---|---|---|
| `latitude` | `lat` argument | Stop latitude from saved coordinates. |
| `longitude` | `lon` argument | Stop longitude from saved coordinates. |
| `hourly` | `temperature_2m,apparent_temperature,weathercode,windspeed_10m,wind_gusts_10m,relativehumidity_2m,precipitation_probability,cloud_cover` | Hourly forecast fields used for per-stop forecast matching. |
| `daily` | `weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max` | Daily fallback fields and daily min/max for heat and beach checks. |
| `wind_speed_unit` | `kn` | Requests wind speed and gust values in knots. |
| `timezone` | `auto` | Lets Open-Meteo choose local timezone for the coordinates. |
| `forecast_days` | `16` | Requests a 16-day forecast window. |

### AWS Location Place Search

Backend place search proxy:

- File: `backend/src/rest_handlers/trips.js:603-636`
- Function: `searchPlaces(query, biasLng, biasLat)`
- AWS SDK call: `location.searchPlaceIndexForText(params)`
- Endpoint exposed by REST handler: `GET /places/search`, implemented at `backend/src/rest_handlers/trips.js:1309-1315`

Request parameters sent to AWS Location:

| AWS Location parameter | Value |
|---|---|
| `IndexName` | `PLACE_INDEX_NAME`, default `TripWizPlaceIndex` |
| `Text` | Query string `q` |
| `MaxResults` | `6` |
| `Language` | `en` |
| `BiasPosition` | Optional `[lng, lat]` from query params `lng` and `lat` |

Returned frontend shape:

```js
{
  label,
  short,
  lat,
  lng,
  categories,
  placeId
}
```

Note: `frontend/src/services/api.js:82-87` defines `api.searchPlaces`, but the trip editor currently uses direct Nominatim search instead.

### AWS Location Fallback Suggestions

- File: `backend/src/validate_lambda/index.js:427-470`
- Function: `findFallbacks(coords, max = 5)`
- AWS SDK call: `location.searchPlaceIndexForText(params)`

For each fallback term in `FALLBACK_SEARCH_TERMS`, the validator sends:

| AWS Location parameter | Value |
|---|---|
| `IndexName` | `PLACE_INDEX_NAME` |
| `Text` | One of `museum`, `gallery`, `shopping mall`, `cinema`, `aquarium` |
| `BiasPosition` | `[coords.lng, coords.lat]` |
| `MaxResults` | `3` |

The code collects unique nearby suggestions and stores at most `max`, default `5`.

### AWS Location Route Calculation

- File: `backend/src/rest_handlers/trips.js:639-690`
- Function: `calculateRoute(body)`
- Endpoint: `POST /routes/calculate`, implemented at `backend/src/rest_handlers/trips.js:1302-1307`
- Frontend caller: `frontend/src/pages/TripPage.jsx:661-672`

Request parameters sent to AWS Location:

| AWS Location parameter | Value |
|---|---|
| `CalculatorName` | `ROUTE_CALCULATOR_NAME`, default `TripWizRouteCalculator` |
| `DeparturePosition` | `[lng, lat]` of first stop in a day |
| `DestinationPosition` | `[lng, lat]` of last stop in a day |
| `WaypointPositions` | Optional intermediate stop positions as `[lng, lat]` |
| `TravelMode` | `Car` |
| `IncludeLegGeometry` | `true` |

The returned route geometry is flattened into frontend positions as `[lat, lng]`.

### Nominatim Frontend Geocoding

Trip editor autocomplete:

- File: `frontend/src/pages/TripPage.jsx:253-269`
- Function: `searchNominatim(query)`
- Endpoint: `https://nominatim.openstreetmap.org/search`

Query parameters:

| Parameter | Value |
|---|---|
| `q` | User query |
| `format` | `json` |
| `addressdetails` | `1` |
| `namedetails` | `1` |
| `limit` | `7` |
| `dedupe` | `1` |
| `accept-language` | `he,en` for Hebrew query, otherwise `en` |

Home page autocomplete also calls Nominatim at `frontend/src/pages/HomePage.jsx:45-60` with `q`, `format=json`, `limit=6`, and `addressdetails=0`.

### Map Display

- File: `frontend/src/components/TripMap.jsx:1-96`
- Library: `leaflet` and `react-leaflet`, dependencies in `frontend/package.json:15,19`
- Leaflet CSS loaded from `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` in `frontend/index.html:8-11`
- Marker icon images loaded from Cloudflare CDN in `TripMap.jsx:5-10`
- Tile URL: `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` in `TripMap.jsx:39-42`

## 3. Weather Data Requested From Open-Meteo

| Field | Hourly/Daily | Unit | Meaning | Used In Alerts | Stored In DynamoDB |
|---|---|---|---|---|---|
| `temperature_2m` | Hourly | Celsius | Forecast air temperature at 2 meters. | Used as `tempC`; also fallback for `tempMaxC`/`tempMinC` if daily values missing. Heat uses `tempMaxC`. | Stored as `tempC`. |
| `apparent_temperature` | Hourly | Celsius | Feels-like temperature. | Not used for current alerts. | Stored as `feelsLikeC`. |
| `weathercode` | Hourly | WMO code | Hourly weather condition code. | Mapped by `wmoToCondition`; affects rain, snow, storm checks. | Stored as mapped `condition` and `description`. |
| `windspeed_10m` | Hourly | Knots requested by `wind_speed_unit=kn` | Sustained wind speed at 10 meters. | General outdoor and ski wind thresholds. | Stored as `windSpeed` and `windSpeedKnots`. |
| `wind_gusts_10m` | Hourly | Knots requested by `wind_speed_unit=kn` | Wind gusts at 10 meters. | General outdoor and ski gust thresholds. | Stored as `windGustsKnots`. |
| `relativehumidity_2m` | Hourly | Percent | Relative humidity at 2 meters. | Not used for current alerts. | Stored as `humidity`. |
| `precipitation_probability` | Hourly | Percent from API, normalized to 0-1 | Probability of precipitation for the hour. | Rain probability checks for beach and general outdoor; storm message displays it. | Stored as `pop` after conversion to fraction. |
| `cloud_cover` | Hourly | Percent from API | Cloud cover for the hour. | Scenic view visibility check after regular outdoor checks. | Stored as `cloudCoverPercent`; also converted to `cloudCoverOktas = Math.round(cloudCoverPercent / 12.5)`. |
| `weathercode` | Daily | WMO code | Daily weather condition code. | Used only in daily fallback path. | Stored as mapped `condition` and `description` if daily fallback is used. |
| `temperature_2m_max` | Daily | Celsius | Daily high temperature. | Heat threshold and beach coldness checks use `tempMaxC`. Ski warm check uses `tempMaxC`. | Stored as `tempMaxC`. |
| `temperature_2m_min` | Daily | Celsius | Daily low temperature. | Not directly compared, but stored and used if daily fallback computes average. | Stored as `tempMinC`. |
| `precipitation_probability_max` | Daily | Percent from API, normalized to 0-1 | Maximum daily precipitation probability. | Used only in daily fallback path. | Stored as `pop` if daily fallback is used. |

Wind normalization happens in `windToKnots(value, unit)` at `backend/src/validate_lambda/index.js:78-83`. If Open-Meteo returns `km/h` in `hourly_units`, the code converts to knots using `1 knot = 1.852 km/h`; otherwise it treats the value as already in knots.

## 4. Map And Location Data

### How Weather Validation Gets Coordinates

Weather validation does not geocode missing coordinates. It uses already saved coordinates:

- File: `backend/src/validate_lambda/index.js:293-297`
- Function: `getCoordinates(slot, item)`
- Logic:
  1. Use `slot.coords` if present.
  2. Otherwise use `item.coords` if the slot references a trip item.
  3. If no coordinates exist, return `null`.

`getWeatherForSlot()` skips the slot if coordinates are missing at `backend/src/validate_lambda/index.js:361-363`.

### How Coordinates Enter Trip Stops

In the trip editor, coordinates usually come from Nominatim:

- `searchNominatim()` fetches search results from OpenStreetMap Nominatim (`frontend/src/pages/TripPage.jsx:253-269`).
- `parseNominatimResult()` converts result fields into `{ name, subtitle, flag, icon, lat, lng, categories }` (`TripPage.jsx:231-250`).
- `LocationAutocomplete` calls `onSelect()` with `name`, `lat`, `lng`, and `recommendedHours` (`TripPage.jsx:303-309`).
- `confirmAddStop()` creates a stop with `lat` and `lng` (`TripPage.jsx:715-725`).
- `stopsToItinerary()` saves those as `coords: { lat, lng }` in the trip itinerary (`TripPage.jsx:116-135`).

The backend also exposes an AWS Location search proxy (`GET /places/search`), but the current TripPage autocomplete path uses Nominatim directly.

## 5. Weather Thresholds

Defined in `backend/src/validate_lambda/index.js:16-33`.

| Constant | Value | Unit | Meaning | Alert Trigger |
|---|---:|---|---|---|
| `RAIN_PROB_OUTDOOR` | `0.50` | Fraction, 50 percent | General outdoor rain threshold. | General outdoor alert when mapped condition is rain/drizzle and `fw.pop >= 0.50`. |
| `RAIN_PROB_BEACH` | `0.30` | Fraction, 30 percent | Beach rain threshold. | Beach alert when `fw.pop >= 0.30`. |
| `HEAT_ALERT_C` | `35` | Celsius | Dangerous heat for any non-indoor activity. | Any non-indoor category alerts when `tempMax > 35`. This comparison is exclusive. |
| `BEACH_MIN_C` | `24` | Celsius | Minimum comfortable beach temperature. | Beach alert when `tempMax < 24`. |
| `SKI_WARM_MAX_C` | `5` | Celsius | Maximum ski temperature if no snow forecast. | Ski alert when `tempMax > 5` and mapped condition is not snow. |
| `KMH_PER_KNOT` | `1.852` | km/h per knot | Conversion constant for fallback wind unit handling. | Used only by `windToKnots()` when API units say km/h. |
| `WIND_ALERT_KNOTS` | `10` | Knots | General outdoor sustained wind threshold. | General outdoor alert when `windSpeedKnots >= 10`. |
| `WIND_GUST_ALERT_KNOTS` | `15` | Knots | General outdoor wind gust threshold. | General outdoor alert when `windGustsKnots >= 15`. |
| `SKI_WIND_ALERT_KNOTS` | `20` | Knots | Ski sustained wind threshold. | Ski alert when `windSpeedKnots >= 20`. |
| `SKI_WIND_GUST_ALERT_KNOTS` | `25` | Knots | Ski wind gust threshold. | Ski alert when `windGustsKnots >= 25`. |
| `SCENIC_CLOUD_ALERT_OKTAS` | `6` | Oktas, 0-8 cloud scale | Scenic view cloud cover threshold. | Scenic view alert when `cloudCoverOktas >= 6`. |

## 6. Activity Categories

Activity categorization is implemented in `categorizeActivity(slot, item)` at `backend/src/validate_lambda/index.js:168-184`.

Keyword constants are defined at `backend/src/validate_lambda/index.js:37-43`.

### Categories

| Category | How It Is Selected |
|---|---|
| `INDOOR` | Returned immediately if `slot.indoor === true` or `item.indoor === true`; otherwise selected by indoor keywords. |
| `SKI` | Selected if searchable text contains any ski keyword. |
| `BEACH` | Selected if searchable text contains any beach keyword. |
| `SCENIC_VIEW` | Selected if searchable text contains any scenic/view keyword after ski and beach checks. |
| `GENERAL_OUTDOOR` | Default if no explicit indoor flag and no keyword category matches. |

Searchable text is built from:

- `slot.title`
- `slot.notes`
- `item.category`
- `item.type`
- `item.name`

Priority order:

1. Explicit indoor flag
2. Ski keyword
3. Beach keyword
4. Scenic/view keyword
5. Indoor keyword
6. `GENERAL_OUTDOOR`

Keywords:

| Category | Keywords |
|---|---|
| `SKI` | `ski`, `skiing`, `snowboard`, `snowboarding`, `slopes`, `piste` |
| `BEACH` | `beach`, `coast`, `coastal`, `shore`, `snorkel`, `surf`, `sunbath`, `sunbathe`, `swim`, `swimming`, `waterpark`, `water park` |
| `SCENIC_VIEW` | `viewpoint`, `lookout`, `observation deck`, `observatory`, `panorama`, `panoramic`, `scenic`, `summit`, `mountain view`, `tower`, `cable car`, `gondola`, `ropeway`, `funicular` |
| `INDOOR` | `museum`, `gallery`, `mall`, `cinema`, `theater`, `theatre`, `restaurant`, `cafe`, `bar`, `pub`, `hotel`, `airport`, `train station`, `aquarium`, `shopping`, `spa`, `indoor` |

## 7. Weather Conditions And WMO Code Mapping

Open-Meteo weather codes are mapped by `wmoToCondition(code)` in `backend/src/validate_lambda/index.js:47-60`.

| Code Range | App Condition | Description |
|---|---|---|
| `0` | `Clear` | `clear sky` |
| `1` | `Clouds` | `mainly clear` |
| `2` | `Clouds` | `partly cloudy` |
| `3` | `Clouds` | `overcast` |
| `<= 48` | `Mist` | `fog` |
| `<= 55` | `Drizzle` | `drizzle` |
| `<= 67` | `Rain` | `rain` for codes `<= 65`, otherwise `freezing rain` |
| `<= 77` | `Snow` | `snow` |
| `<= 82` | `Rain` | `rain showers` |
| `<= 86` | `Snow` | `snow showers` |
| `<= 99` | `Thunderstorm` | `thunderstorm` |
| Other | `Unknown` | Empty description |

The mapped `condition` is lowercased in `assessWeather()`:

- `isSnow` checks whether condition includes `snow`.
- `isRain` checks whether condition includes `rain` or `drizzle`.
- `isStorm` checks whether condition includes `storm` or `thunder`.

These booleans drive ski snow/no-snow logic, rain alerts, and storm alerts.

## 8. Forecast Selection And Normalization

Implemented in `findForecastForTimestamp(forecast, timestampSec)` at `backend/src/validate_lambda/index.js:89-163`.

### Daily Min/Max Lookup

Before selecting an hourly forecast, the function computes `slotDate` from the stop timestamp and tries to find the matching daily record. It extracts:

- `tempMaxC` from `daily.temperature_2m_max`
- `tempMinC` from `daily.temperature_2m_min`

These are used even when the final forecast comes from hourly data.

### Hourly Selection

If `forecast.hourly.time` exists and has entries, hourly data is preferred:

1. Iterate through all hourly timestamps.
2. Convert each hourly time to Unix seconds.
3. Choose the index with the smallest absolute time difference from the stop timestamp.
4. Map `hourly.weathercode[bestIdx]` to app condition and description.
5. Normalize wind speed and gusts to knots.
6. Normalize cloud cover to `cloudCoverPercent` and calculate `cloudCoverOktas = Math.round(cloudCoverPercent / 12.5)`.

Returned hourly object:

```js
{
  tempC,
  feelsLikeC,
  tempMaxC,
  tempMinC,
  condition,
  description,
  icon: '',
  pop,
  humidity,
  windSpeed,
  windSpeedKnots,
  windGustsKnots,
  cloudCoverPercent,
  cloudCoverOktas,
  source: 'hourly'
}
```

Notes:

- `pop` is normalized from percent to fraction by dividing by 100.
- `windSpeed` currently mirrors `windSpeedKnots`.
- `cloudCoverOktas` uses the nearest okta value from 0 to 8.
- `forecastSource` is later set from `fw.source`.

### Daily Fallback

If hourly data is unavailable but daily data exists, the function chooses the daily date nearest to the slot date.

Returned daily fallback object:

```js
{
  tempC,
  feelsLikeC,
  tempMaxC,
  tempMinC,
  condition,
  description,
  icon: '',
  pop,
  humidity: null,
  windSpeed: null,
  windSpeedKnots: null,
  windGustsKnots: null,
  cloudCoverPercent: null,
  cloudCoverOktas: null,
  source: 'daily'
}
```

Daily fallback does not have humidity, wind, or cloud-cover values.

## 9. Full Alert Logic

Implemented in `assessWeather(fw, category)` at `backend/src/validate_lambda/index.js:191-289`.

### Shared Preprocessing

For any non-indoor category, the function derives:

- `isSnow`
- `isRain`
- `isStorm`
- `windSpeedKnots`
- `windGustsKnots`
- `tempMax`, preferring `fw.tempMaxC` and falling back to `fw.tempC`

### INDOOR

If category is `INDOOR`, the function immediately returns:

```js
{ isAlert: false, reason: null }
```

No temperature, rain, storm, or wind rule is applied.

### Global Heat Rule

Before category-specific rules, every non-indoor category checks:

```js
tempMax > HEAT_ALERT_C
```

With `HEAT_ALERT_C = 35`, alert triggers only above 35 C, not at exactly 35 C.

Message:

```text
Dangerous heat ({tempMax}C / {toF(tempMax)}F) - consider rescheduling any outdoor activity
```

### SKI

Ski logic is implemented at `backend/src/validate_lambda/index.js:212-238`.

Rules are evaluated in this order:

1. Too warm without snow:
   - Trigger: `tempMax > SKI_WARM_MAX_C && !isSnow`
   - Constant: `SKI_WARM_MAX_C = 5`
   - Message: too warm for skiing with no snow forecast.

2. Sustained wind:
   - Trigger: `windSpeedKnots >= SKI_WIND_ALERT_KNOTS`
   - Constant: `SKI_WIND_ALERT_KNOTS = 20`
   - Message: `Ski wind speed is 20 knots or higher (...) - ski lifts may be suspended`

3. Wind gusts:
   - Trigger: `windGustsKnots >= SKI_WIND_GUST_ALERT_KNOTS`
   - Constant: `SKI_WIND_GUST_ALERT_KNOTS = 25`
   - Message: `Ski wind gusts are 25 knots or higher (...) - ski lifts may be suspended`

4. Storm:
   - Trigger: `isStorm`
   - Message: thunderstorm forecast, ski lifts likely closed.

If none match, no alert.

Important ordering detail: for ski, the no-snow warm rule is checked before storm and wind. If multiple rules are true, only the first reason is returned.

### BEACH

Beach logic is implemented at `backend/src/validate_lambda/index.js:241-261`.

Rules are evaluated in this order:

1. Too cold:
   - Trigger: `tempMax < BEACH_MIN_C`
   - Constant: `BEACH_MIN_C = 24`
   - Message: too cold for the beach.

2. Storm:
   - Trigger: `isStorm`
   - Message: thunderstorm forecast, beach conditions unsafe.

3. Rain probability:
   - Trigger: `fw.pop >= RAIN_PROB_BEACH`
   - Constant: `RAIN_PROB_BEACH = 0.30`
   - Message: `{percent}% chance of {description} - beach plans may be disrupted`

Beach does not currently apply wind-specific beach rules.

### SCENIC_VIEW

Scenic view logic first applies the same regular outdoor checks used by `GENERAL_OUTDOOR`:

1. Storm:
   - Trigger: `isStorm`
   - Message: thunderstorm forecast with precipitation chance.

2. Rain:
   - Trigger: `isRain && fw.pop >= RAIN_PROB_OUTDOOR`
   - Constant: `RAIN_PROB_OUTDOOR = 0.50`
   - Message: `{percent}% chance of {description} - outdoor activity may be disrupted`

3. Sustained wind:
   - Trigger: `windSpeedKnots >= WIND_ALERT_KNOTS`
   - Constant: `WIND_ALERT_KNOTS = 10`
   - Message: `Wind speed is 10 knots or higher (...) - outdoor activity may be uncomfortable or unsafe`

4. Wind gusts:
   - Trigger: `windGustsKnots >= WIND_GUST_ALERT_KNOTS`
   - Constant: `WIND_GUST_ALERT_KNOTS = 15`
   - Message: `Wind gusts are 15 knots or higher (...) - outdoor activity may be uncomfortable or unsafe`

If none of those regular outdoor checks alert, scenic-specific visibility checks run:

5. Mist or fog:
   - Trigger: mapped condition includes `mist`
   - Message: `Low visibility expected due to fog or mist - the view may be limited.`

6. Cloud cover:
   - Trigger: `cloudCoverOktas >= SCENIC_CLOUD_ALERT_OKTAS`
   - Constant: `SCENIC_CLOUD_ALERT_OKTAS = 6`
   - Message: `Cloud cover is 6/8 or higher - visibility at this scenic location may be limited.`

Minor and partly cloudy conditions do not alert from cloud cover alone. For example, 3/8 and 4/8 cloud cover are below the scenic threshold.

### GENERAL_OUTDOOR

General outdoor logic is implemented at `backend/src/validate_lambda/index.js:263-289`.

Rules are evaluated in this order:

1. Storm:
   - Trigger: `isStorm`
   - Message: thunderstorm forecast with precipitation chance.

2. Rain:
   - Trigger: `isRain && fw.pop >= RAIN_PROB_OUTDOOR`
   - Constant: `RAIN_PROB_OUTDOOR = 0.50`
   - Message: `{percent}% chance of {description} - outdoor activity may be disrupted`

3. Sustained wind:
   - Trigger: `windSpeedKnots >= WIND_ALERT_KNOTS`
   - Constant: `WIND_ALERT_KNOTS = 10`
   - Message: `Wind speed is 10 knots or higher (...) - outdoor activity may be uncomfortable or unsafe`

4. Wind gusts:
   - Trigger: `windGustsKnots >= WIND_GUST_ALERT_KNOTS`
   - Constant: `WIND_GUST_ALERT_KNOTS = 15`
   - Message: `Wind gusts are 15 knots or higher (...) - outdoor activity may be uncomfortable or unsafe`

If none match, no alert.

## 10. Weather Data Flow Through The System

1. A user adds a stop in the trip editor.
   - `LocationAutocomplete` in `frontend/src/pages/TripPage.jsx` uses Nominatim to find a place.
   - The selected place provides `lat` and `lng`.

2. The stop is saved into the trip itinerary.
   - `stopsToItinerary()` stores `coords: { lat, lng }`.

3. The user clicks `Check Weather`.
   - `handleValidate()` validates that at least one stop has coordinates and at least one stop has time.
   - It calls `api.validateTrip(tripId)`.

4. Frontend calls backend.
   - `frontend/src/services/api.js:67` calls `POST /trips/{tripId}/validate`.
   - The API base URL is configured in `frontend/src/config.js:7-9`.

5. REST handler invokes validator asynchronously.
   - `backend/src/rest_handlers/trips.js:1088-1105` invokes `ValidateLambdaFunction` with `{ source: 'tripwiz.rest', detail: { tripId, userId } }`.

6. Validator loads trips.
   - For on-demand validation, `getOnDemandTrip()` loads the requested trip and validates access path.
   - For scheduled validation, `getScheduledTrips()` queries trips starting between now and tomorrow.

7. Existing validation data is cleared.
   - `clearValidationData()` deletes old `ALERT#`, `FALLBACKS#`, and `WEATHER#` records for the trip.

8. Each scheduled stop is processed.
   - `getWeatherForSlot()` skips stops without `start` or coordinates.
   - It fetches Open-Meteo forecast by coordinates.
   - It chooses the nearest hourly forecast or daily fallback.
   - It categorizes the activity.
   - It calls `assessWeather()`.

9. Weather data is stored.
   - `persistWeatherData()` writes a `WEATHER#slotId` record for every processed stop.

10. Alerts are stored and published.
   - If `wd.isAlert` is true, `persistAlert()` writes an `ALERT#timestamp#slotId` record.
   - The validator publishes the weather object to SNS (`backend/src/validate_lambda/index.js:601-606`).
   - `backend/src/sns_to_ses/index.js` receives SNS records and sends an SES email.

11. Fallback suggestions are searched and stored.
   - If an alert exists, `findFallbacks()` searches nearby indoor places via AWS Location.
   - `persistFallbacks()` stores suggestions in `FALLBACKS#slotId`.

12. Validation metadata is stored.
   - `persistValidationMeta()` writes `META#VALIDATION` with `lastValidatedAt`.

13. Frontend polls and displays results.
   - `TripPage.jsx:1010-1039` polls `GET /trips/{tripId}/alerts`.
   - When metadata changes, it also refreshes weather and fallbacks.
   - Stop cards show weather badges and warning reasons.
   - Fallback suggestions are shown under alerted stop cards.
   - `TripOverviewPage.jsx` also loads and displays weather pills.

The frontend does not calculate weather alerts itself. It displays stored backend results.

## 11. Stored Weather And Alert Data

All records use the DynamoDB table from `TABLE_NAME`.

### Weather Records

Written by `persistWeatherData(tripId, slotId, wd)` at `backend/src/validate_lambda/index.js:473-507`.

Key:

| Field | Value |
|---|---|
| `PK` | `TRIP#{tripId}` |
| `SK` | `WEATHER#{slotId}` |
| `entityType` | `WeatherData` |

Stored fields:

- `tripId`
- `slotId`
- `slotTitle`
- `slotStart`
- `category`
- `coords`
- `tempC`
- `feelsLikeC`
- `tempMaxC`
- `tempMinC`
- `condition`
- `description`
- `icon`
- `pop`
- `humidity`
- `windSpeed`
- `windSpeedKnots`
- `windGustsKnots`
- `cloudCoverPercent`
- `cloudCoverOktas`
- `forecastSource`
- `isAlert`
- `reason`
- `createdAt`
- `ttl`

### Alert Records

Written by `persistAlert(wd, tripId)` at `backend/src/validate_lambda/index.js:528-551`.

Key:

| Field | Value |
|---|---|
| `PK` | `TRIP#{tripId}` |
| `SK` | `ALERT#{nowISOString}#{slotId}` |
| `entityType` | `Alert` |

Stored fields:

- `tripId`
- `slotId`
- `slotTitle`
- `slotStart`
- `category`
- `coords`
- `weatherCondition`
- `precipitationProb`
- `cloudCoverPercent`
- `cloudCoverOktas`
- `severity: warning`
- `reason`
- `createdAt`
- `ttl`

Alerts are created only when `wd.isAlert` is true.

### Fallback Suggestion Records

Written by `persistFallbacks(tripId, slotId, suggestions)` at `backend/src/validate_lambda/index.js:509-526`.

Key:

| Field | Value |
|---|---|
| `PK` | `TRIP#{tripId}` |
| `SK` | `FALLBACKS#{slotId}` |
| `entityType` | `Fallbacks` |

Stored fields:

- `tripId`
- `slotId`
- `suggestions`
- `createdAt`
- `ttl`

Suggestion object fields:

- `name`
- `fullAddress`
- `lat`
- `lng`
- `category`
- `distance`

### Validation Metadata

Written by `persistValidationMeta(tripId)` at `backend/src/validate_lambda/index.js:553-565`.

Key:

| Field | Value |
|---|---|
| `PK` | `TRIP#{tripId}` |
| `SK` | `META#VALIDATION` |
| `entityType` | `ValidationMeta` |

Stored fields:

- `tripId`
- `lastValidatedAt`

## 12. Backend API And Frontend Connection

### Backend Endpoints

Defined in `backend/infra/template.yaml:307-330` and implemented in `backend/src/rest_handlers/trips.js`.

| Endpoint | Method | Backend Functionality | Implementation |
|---|---:|---|---|
| `/trips/{tripId}/validate` | `POST` | Asynchronously invokes the validation Lambda. | `trips.js:1088-1105` |
| `/trips/{tripId}/alerts` | `GET` | Returns stored alerts and `lastValidatedAt`. | `trips.js:1005-1034` |
| `/trips/{tripId}/fallbacks` | `GET` | Returns stored indoor fallback suggestions. | `trips.js:1036-1056` |
| `/trips/{tripId}/weather` | `GET` | Returns stored per-stop weather forecast data and `lastValidatedAt`. | `trips.js:1058-1086` |
| `/routes/calculate` | `POST` | Returns route geometry from AWS Location. | `trips.js:1302-1307` |
| `/places/search` | `GET` | Returns AWS Location place search results. | `trips.js:1309-1315` |

Frontend wrappers are defined in `frontend/src/services/api.js:61-87`.

### Frontend Display

| File | Role |
|---|---|
| `frontend/src/pages/TripPage.jsx` | Main editor. Loads alerts/fallbacks/weather, triggers validation, polls for results, shows weather badges, alert reasons, and fallback suggestions. |
| `frontend/src/pages/TripOverviewPage.jsx` | Overview/dashboard. Loads alerts/fallbacks/weather and shows compact weather pills. Includes alerts/fallbacks in exports. |
| `frontend/src/components/TripMap.jsx` | Displays stop markers and route lines using Leaflet/OpenStreetMap tiles. |
| `frontend/src/services/api.js` | Defines calls to validation, weather, alerts, fallbacks, route, and place-search endpoints. |

The frontend displays backend-calculated weather data. It does not re-run threshold or alert calculations.

## 13. Files And Functions

| Concern | File | Function/Location |
|---|---|---|
| Open-Meteo request | `backend/src/validate_lambda/index.js` | `fetchForecast(lat, lon)` |
| Open-Meteo response parsing | `backend/src/validate_lambda/index.js` | `findForecastForTimestamp(forecast, timestampSec)` |
| Wind normalization | `backend/src/validate_lambda/index.js` | `windToKnots(value, unit)` |
| WMO code mapping | `backend/src/validate_lambda/index.js` | `wmoToCondition(code)` |
| Activity categorization | `backend/src/validate_lambda/index.js` | `categorizeActivity(slot, item)` |
| Alert decision | `backend/src/validate_lambda/index.js` | `assessWeather(fw, category)` |
| Coordinates for weather | `backend/src/validate_lambda/index.js` | `getCoordinates(slot, item)` |
| Per-slot weather processing | `backend/src/validate_lambda/index.js` | `getWeatherForSlot(trip, slot)` |
| Clear old validation data | `backend/src/validate_lambda/index.js` | `clearValidationData(tripId)` |
| Fallback search | `backend/src/validate_lambda/index.js` | `findFallbacks(coords, max)` |
| Save weather | `backend/src/validate_lambda/index.js` | `persistWeatherData(tripId, slotId, wd)` |
| Save alert | `backend/src/validate_lambda/index.js` | `persistAlert(wd, tripId)` |
| Save fallbacks | `backend/src/validate_lambda/index.js` | `persistFallbacks(tripId, slotId, suggestions)` |
| Validation handler | `backend/src/validate_lambda/index.js` | `exports.handler` |
| REST weather endpoints | `backend/src/rest_handlers/trips.js` | `/validate`, `/alerts`, `/fallbacks`, `/weather` branches |
| AWS Location place search | `backend/src/rest_handlers/trips.js` | `searchPlaces(query, biasLng, biasLat)` |
| AWS Location route calculation | `backend/src/rest_handlers/trips.js` | `calculateRoute(body)` |
| Frontend API wrapper | `frontend/src/services/api.js` | `validateTrip`, `getTripAlerts`, `getTripFallbacks`, `getTripWeather`, `calculateRoute`, `searchPlaces` |
| Trip stop geocoding | `frontend/src/pages/TripPage.jsx` | `searchNominatim(query)`, `parseNominatimResult()` |
| Trip editor weather UI | `frontend/src/pages/TripPage.jsx` | `StopCard`, `handleValidate()` |
| Overview weather UI | `frontend/src/pages/TripOverviewPage.jsx` | load effect and weather pill rendering |
| Map display | `frontend/src/components/TripMap.jsx` | `TripMap({ dayGroups })` |
| Alert email | `backend/src/sns_to_ses/index.js` | `exports.handler`, `buildEmailBody()` |

## 14. Summary Tables

### Table 1: Weather Logic Summary

| Category / Condition | Threshold | Unit | When Alert Is Triggered | Message / Reason | File And Line |
|---|---:|---|---|---|---|
| Any non-indoor / heat | `HEAT_ALERT_C = 35` | C | `tempMax > 35` | `Dangerous heat (...) - consider rescheduling any outdoor activity` | `backend/src/validate_lambda/index.js:203-209` |
| `INDOOR` | None | N/A | Never alerts; returns immediately. | None | `backend/src/validate_lambda/index.js:192-193` |
| `SKI` / too warm with no snow | `SKI_WARM_MAX_C = 5` | C | `tempMax > 5 && !isSnow` | `Too warm for skiing (...) with no snow forecast - expect poor snow conditions` | `backend/src/validate_lambda/index.js:212-218` |
| `SKI` / sustained wind | `SKI_WIND_ALERT_KNOTS = 20` | knots | `windSpeedKnots >= 20` | `Ski wind speed is 20 knots or higher (...) - ski lifts may be suspended` | `backend/src/validate_lambda/index.js:219-224` |
| `SKI` / wind gusts | `SKI_WIND_GUST_ALERT_KNOTS = 25` | knots | `windGustsKnots >= 25` | `Ski wind gusts are 25 knots or higher (...) - ski lifts may be suspended` | `backend/src/validate_lambda/index.js:225-230` |
| `SKI` / storm | N/A | N/A | `isStorm` | `Thunderstorm forecast - ski lifts likely closed for safety` | `backend/src/validate_lambda/index.js:231-236` |
| `BEACH` / too cold | `BEACH_MIN_C = 24` | C | `tempMax < 24` | `Too cold for the beach (...)` | `backend/src/validate_lambda/index.js:241-247` |
| `BEACH` / storm | N/A | N/A | `isStorm` | `Thunderstorm forecast - beach conditions unsafe` | `backend/src/validate_lambda/index.js:248-253` |
| `BEACH` / rain probability | `RAIN_PROB_BEACH = 0.30` | fraction | `fw.pop >= 0.30` | `{percent}% chance of {description} - beach plans may be disrupted` | `backend/src/validate_lambda/index.js:254-259` |
| `GENERAL_OUTDOOR` / storm | N/A | N/A | `isStorm` | `Thunderstorm forecast (...) - outdoor activity not recommended` | `backend/src/validate_lambda/index.js:263-269` |
| `GENERAL_OUTDOOR` / rain | `RAIN_PROB_OUTDOOR = 0.50` | fraction | `isRain && fw.pop >= 0.50` | `{percent}% chance of {description} - outdoor activity may be disrupted` | `backend/src/validate_lambda/index.js:270-275` |
| `GENERAL_OUTDOOR` / sustained wind | `WIND_ALERT_KNOTS = 10` | knots | `windSpeedKnots >= 10` | `Wind speed is 10 knots or higher (...) - outdoor activity may be uncomfortable or unsafe` | `backend/src/validate_lambda/index.js:276-281` |
| `GENERAL_OUTDOOR` / wind gusts | `WIND_GUST_ALERT_KNOTS = 15` | knots | `windGustsKnots >= 15` | `Wind gusts are 15 knots or higher (...) - outdoor activity may be uncomfortable or unsafe` | `backend/src/validate_lambda/index.js:282-287` |
| `SCENIC_VIEW` / regular outdoor rules | Same as `GENERAL_OUTDOOR` | Mixed | Storm, rain at `RAIN_PROB_OUTDOOR`, sustained wind at `WIND_ALERT_KNOTS`, wind gusts at `WIND_GUST_ALERT_KNOTS` | Same regular outdoor messages | `backend/src/validate_lambda/index.js` |
| `SCENIC_VIEW` / mist or fog | N/A | N/A | mapped condition includes `mist` | `Low visibility expected due to fog or mist - the view may be limited.` | `backend/src/validate_lambda/index.js` |
| `SCENIC_VIEW` / cloud cover | `SCENIC_CLOUD_ALERT_OKTAS = 6` | oktas | `cloudCoverOktas >= 6` | `Cloud cover is 6/8 or higher - visibility at this scenic location may be limited.` | `backend/src/validate_lambda/index.js` |

### Table 2: API And Data Source Summary

| Provider / API | Purpose | Endpoint / Function | Data Requested | File Path | How It Is Used |
|---|---|---|---|---|---|
| Open-Meteo Forecast API | Weather forecast for trip stops | `https://api.open-meteo.com/v1/forecast`, `fetchForecast(lat, lon)` | Hourly temperature, apparent temperature, weather code, wind speed, wind gusts, humidity, precipitation probability, cloud cover; daily weather code, max/min temperature, max precipitation probability. | `backend/src/validate_lambda/index.js` | Validator fetches forecast for each stop with coordinates and scheduled time. |
| AWS Location Place Index | Indoor fallback suggestions | `location.searchPlaceIndexForText`, `findFallbacks(coords, max)` | Text terms `museum`, `gallery`, `shopping mall`, `cinema`, `aquarium`; bias position; max results. | `backend/src/validate_lambda/index.js` | Runs only after a weather alert, stores nearby indoor alternatives. |
| AWS Location Place Index | Backend place-search proxy | `GET /places/search`, `searchPlaces(query, biasLng, biasLat)` | Query text, optional bias coordinates, English language, max 6 results. | `backend/src/rest_handlers/trips.js` | Available to frontend via `api.searchPlaces`, but current TripPage uses Nominatim directly. |
| AWS Location Route Calculator | Road-following itinerary map routes | `POST /routes/calculate`, `calculateRoute(body)` | Per-day departure, destination, optional waypoints, car mode, leg geometry. | `backend/src/rest_handlers/trips.js` | Frontend map uses returned route positions; falls back to straight lines on failure. |
| OpenStreetMap Nominatim | Trip stop autocomplete and geocoding | `https://nominatim.openstreetmap.org/search`, `searchNominatim(query)` | Query text, JSON format, address details, named details, limit 7, dedupe, language. | `frontend/src/pages/TripPage.jsx` | User-selected result becomes an itinerary stop with saved coordinates. |
| OpenStreetMap Nominatim | Home page suggestions | `https://nominatim.openstreetmap.org/search` in `LocationAutocomplete` effect | Query text, JSON format, limit 6, no address details. | `frontend/src/pages/HomePage.jsx` | Home page destination suggestions. |
| Leaflet / React Leaflet | Map rendering | `TripMap({ dayGroups })` | Stop coordinates and route positions from app state. | `frontend/src/components/TripMap.jsx` | Renders markers, popups, and polylines. |
| OpenStreetMap tiles | Map base layer | `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` | Map tiles by zoom/x/y. | `frontend/src/components/TripMap.jsx` | TileLayer background for Leaflet map. |
| Amazon SNS | Alert publication | `sns.publish()` | Weather alert object and subject. | `backend/src/validate_lambda/index.js` | Publishes alerts when `wd.isAlert` is true. |
| Amazon SES | Alert email delivery | `ses.sendEmail()` | SNS message rendered as text email. | `backend/src/sns_to_ses/index.js` | Sends email for published weather alerts. |
