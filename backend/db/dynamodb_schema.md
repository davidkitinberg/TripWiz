# TripWiz DynamoDB Schema (POC)

## Table: TripWizTable
- TableName: TripWizTable
- Partition Key (PK): `PK` (string)
- Sort Key (SK): `SK` (string)
- BillingMode: PAY_PER_REQUEST (On-Demand) to reduce management and fit Free Tier usage
- TTL attribute: `ttl` for ephemeral WebSocket connection records

## Item patterns

1. User item
- PK: `USER#<userId>`
- SK: `PROFILE#<userId>`
- Attributes: { displayName, email, preferences }

2. Trip item
- PK: `USER#<ownerUserId>`
- SK: `TRIP#<tripId>`
- Attributes: { entityType: "Trip", tripId, ownerId, title, startDate, endDate, collaborators: [userId], itinerary: [slot objects], metadata, version }
- GSI fields: `GSI1PK` = "TRIP" and `tripStart` = ISO startDate for GSI queries

3. User trip pointer item
- PK: `USER#<collaboratorUserId>`
- SK: `TRIP#<tripId>`
- Attributes: { entityType: "TripPointer", tripId, ownerId, title, startDate, endDate, role }

4. Trip access item
- PK: `TRIP#<tripId>`
- SK: `ACCESS#<userId>`
- Attributes: { entityType: "TripAccess", tripId, userId, ownerId, role }

5. Trip-Item (waypoint/activity)
- PK: `TRIP#<tripId>`
- SK: `ITEM#<itemId>`
- Attributes: { itemId, type (attraction|restaurant), coords: {lat,lng}, openingHours, durationMinutes, indoor:boolean, metadata }

6. Connection item (WebSocket connection identity)
- PK: `CONN#<connectionId>`
- SK: `META`
- Attributes: { entityType: "Connection", connectionId, userId, joinedTrips, ttl, connectedAt }

7. Trip connection item (WebSocket trip subscription)
- PK: `CONN#TRIP#<tripId>`
- SK: `CONN#<connectionId>`
- Attributes: { entityType: "TripConnection", tripId, connectionId, userId, ttl, joinedAt }

## Access patterns
- Get all trips for a user: Query PK=`USER#<userId>` AND SK begins_with `TRIP#` (owned trips plus shared pointers).
- Get trip details: resolve access, then Get PK=`USER#<ownerUserId>`, SK=`TRIP#<tripId>`.
- Get trip waypoint/activity items: Query PK=`TRIP#<tripId>` and SK begins_with `ITEM#`.
- Check trip access: Get PK=`TRIP#<tripId>`, SK=`ACCESS#<userId>`.
- Broadcast connections for a trip: Query PK=`CONN#TRIP#<tripId>`.
 - Query upcoming trips (e.g., next 24h): Query GSI1 where `GSI1PK = 'TRIP'` AND `tripStart` BETWEEN `<nowIso>` AND `<tomorrowIso>`.

## Notes
- Use `version` and conditional writes (`ConditionExpression: attribute_not_exists(version) OR version = :expected`) to implement optimistic concurrency control for collaborative edits.
- Keep item sizes modest; store large media in S3 (not in DynamoDB).
- TTL is enabled for ephemeral connection items.

Example Trip item JSON:
{
  "PK": "USER#u-123",
  "SK": "TRIP#t-456",
  "entityType": "Trip",
  "tripId": "t-456",
  "ownerId": "u-123",
  "title": "Tel Aviv Weekend",
  "startDate": "2026-06-10",
  "endDate": "2026-06-13",
  "collaborators": ["u-234","u-345"],
  "itinerary": [{ "slotId":"s-1","start":"2026-06-10T09:00:00Z","end":"2026-06-10T11:00:00Z","itemId":"i-1" }],
  "version": 7
}
