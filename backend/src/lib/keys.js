'use strict';

// [Review #3] Single source of truth for the single-table key scheme. Previously the
// `USER#`, `TRIP#`, `ACCESS#`, `CONN#` … prefixes were inlined as string literals in
// every handler, where a single typo silently breaks an access pattern. Centralising
// the builders makes the data model explicit and typo-resistant.

const userPk = (userId) => `USER#${userId}`;
const tripPk = (tripId) => `TRIP#${tripId}`;
const tripSk = (tripId) => `TRIP#${tripId}`;

const accessSk = (userId) => `ACCESS#${userId}`;
const collabSk = (userId) => `COLLAB#${userId}`;
const attachmentSk = (fileId) => `ATTACHMENT#${fileId}`;

const PREFS_SK = 'PREFS';
const VALIDATION_META_SK = 'META#VALIDATION';

const connPk = (connectionId) => `CONN#${connectionId}`;
const connTripPk = (tripId) => `CONN#TRIP#${tripId}`;
const connTripSk = (connectionId) => `CONN#${connectionId}`;

// SK prefixes for begins_with queries
const PREFIX = {
  trip: 'TRIP#',
  access: 'ACCESS#',
  collab: 'COLLAB#',
  attachment: 'ATTACHMENT#',
  alert: 'ALERT#',
  weather: 'WEATHER#',
  fallbacks: 'FALLBACKS#'
};

module.exports = {
  userPk,
  tripPk,
  tripSk,
  accessSk,
  collabSk,
  attachmentSk,
  PREFS_SK,
  VALIDATION_META_SK,
  connPk,
  connTripPk,
  connTripSk,
  PREFIX
};
