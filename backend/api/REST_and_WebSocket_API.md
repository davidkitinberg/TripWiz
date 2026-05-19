# TripWiz API - REST & WebSocket (POC)

## Overview
- Auth: Amazon Cognito JWT (Bearer) for REST; WebSocket `$connect` uses a Lambda authorizer that validates a Cognito access token.
- All backend calls go through API Gateway (REST for CRUD; WebSocket for real-time collaboration).

---

## REST Endpoints

1. GET /trips
- Description: List user's trips (paginated).
- Auth: Bearer JWT
- Query: `?limit=&lastKey=`
- Response: 200 { items: [ { tripId, title, startDate, endDate, metadata } ], lastKey }

2. POST /trips
- Description: Create a new trip
- Body: { title, startDate, endDate, collaborators?: [userId...], data?: {...} }
- Response: 201 { tripId, trip }

3. GET /trips/{tripId}
- Description: Get trip details (includes itinerary slots)
- Auth: Must be owner or collaborator
- Response: 200 { trip, access }

4. PUT /trips/{tripId}
- Description: Update trip metadata
- Body: partial trip fields
- Response: 200 { trip }

5. DELETE /trips/{tripId}
- Description: Delete trip (soft-delete recommended)
- Response: 204

6. POST /trips/{tripId}/validate
- Description: Trigger an on-demand validation (weather & hours) for the trip
- Response: 202 { jobId }

7. POST /routes/calculate
- Description: Request route calculation for a set of waypoints (proxy to Amazon Location or 3rd-party)
- Body: { waypoints: [{lat,lng}], profile?: "driving" }
- Response: 200 { routeGeoJson, legs }

Notes:
- REST endpoints should be protected by a Cognito Authorizer (JWT) and validate scope/permissions in Lambda.
- All requests that require third-party API keys MUST be proxied through a Lambda that retrieves keys from Secrets Manager.

---

## WebSocket Contract (API Gateway WebSocket)

- Routes:
  - $connect: validate Cognito access token from `?token=...` and register connection identity.
  - $disconnect: remove connection and trip subscription records.
  - join, leave, edit, cursor, ping: primary collaboration routes selected from `action`.

- Message payload (JSON):
{
  "action": "edit|cursor|join|leave|ping",
  "tripId": "...",
  "payload": { ... }
}

- Actions:
  - `join`: client requests to join a trip channel; Lambda adds connection to trip subscribers.
  - `leave`: client leaves subscription.
  - `edit`: contains a minimal delta with `payload.expectedVersion` and either `payload.tripPatch` or `payload.field`/`payload.newValue`. Server applies optimistic concurrency via `version` and broadcasts accepted edits.
  - `cursor`: share cursor position for collaborative UX.
  - `ping`: keepalive.

- Server behavior:
  - On `edit`, Lambda validates user permission, writes change to DynamoDB (with conditional writes using `version`), and broadcasts the accepted change to all other connections for the trip using API Gateway Management API.
  - When API Gateway Management API returns 410 (stale connectionId), purge the stale connection record.

---

## Error handling & quotas
- Use structured error responses: { code, message, details? }
- Rate limit critical routes (e.g., route calculations) and return 429 when throttled.

---

## Security notes (compliant with Project_Idea.md)
- Never expose third-party API keys to frontend. All mapping/routing/weather calls must be performed server-side by Lambdas retrieving keys from `AWS::SecretsManager::Secret`.
- Least-privilege IAM roles: Lambdas only get `secretsmanager:GetSecretValue` for specific secrets, `dynamodb:PutItem`/`UpdateItem`/`Query` for the specific table, and `sns:Publish` for alerts.

