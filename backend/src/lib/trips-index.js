'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

// [Review #1] The GSI1 "list every trip" / time-range access patterns originally put
// every trip under a single partition key (GSI1PK = 'TRIP'). That is a classic hot
// partition: all admin scans, the daily reminder, and scheduled validation hammer one
// physical partition, which throttles under load and makes the read cost grow with the
// whole platform. We now write-shard across TRIP_SHARD_COUNT partitions and scatter-
// gather on read.
//
// MIGRATION NOTE: existing rows written before this change still carry GSI1PK = 'TRIP'.
// The legacy key is therefore kept in TRIP_GSI_PKS so those rows stay visible to readers
// during/after rollout. A one-off backfill (re-PUT each trip so GSI1PK becomes its shard
// key) lets you eventually drop the legacy key. Until then reads simply fan out over one
// extra (shrinking) partition, which is correct and safe.

const TRIP_SHARD_COUNT = 10;
const LEGACY_TRIP_GSI_PK = 'TRIP';

// Deterministic, stable string hash (FNV-1a) so a trip always maps to the same shard.
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Shard key used when WRITING a trip's GSI projection.
function tripGsiPk(tripId) {
  const shard = hashString(String(tripId || '')) % TRIP_SHARD_COUNT;
  return `TRIP#${shard}`;
}

// All partition keys a reader must visit: every shard plus the legacy key.
const TRIP_GSI_PKS = [
  ...Array.from({ length: TRIP_SHARD_COUNT }, (_, i) => `TRIP#${i}`),
  LEGACY_TRIP_GSI_PK
];

// Scatter-gather a full Query across every trip shard, paginating each partition fully.
// `extra` may carry { FilterExpression, ExpressionAttributeNames, ExpressionAttributeValues }.
async function queryAllTrips(ddb, tableName, extra = {}) {
  const perPk = await Promise.all(TRIP_GSI_PKS.map(async (pk) => {
    const items = [];
    let lastKey;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ...(extra.FilterExpression ? { FilterExpression: extra.FilterExpression } : {}),
        ...(extra.ExpressionAttributeNames ? { ExpressionAttributeNames: extra.ExpressionAttributeNames } : {}),
        ExpressionAttributeValues: { ':pk': pk, ...(extra.ExpressionAttributeValues || {}) },
        ExclusiveStartKey: lastKey
      }));
      items.push(...(res.Items || []));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return items;
  }));
  return perPk.flat();
}

// Scatter-gather a tripStart range Query (used by the reminder + scheduled validation).
async function queryTripsByStartRange(ddb, tableName, fromIso, toIso) {
  const perPk = await Promise.all(TRIP_GSI_PKS.map(async (pk) => {
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND tripStart BETWEEN :from AND :to',
      FilterExpression: 'attribute_not_exists(deleted) OR deleted = :notDeleted',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':from': fromIso,
        ':to': toIso,
        ':notDeleted': false
      }
    }));
    return res.Items || [];
  }));
  return perPk.flat();
}

// Find a single trip by id across all shards (replaces the old single-partition,
// single-page Query that could miss matches — see [Review #4]).
async function findTripById(ddb, tableName, tripId) {
  for (const pk of TRIP_GSI_PKS) {
    let lastKey;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        FilterExpression: 'tripId = :tid',
        ExpressionAttributeValues: { ':pk': pk, ':tid': tripId },
        ExclusiveStartKey: lastKey
      }));
      if (res.Items && res.Items.length > 0) return res.Items[0];
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  }
  return null;
}

module.exports = {
  TRIP_SHARD_COUNT,
  TRIP_GSI_PKS,
  tripGsiPk,
  queryAllTrips,
  queryTripsByStartRange,
  findTripById
};
