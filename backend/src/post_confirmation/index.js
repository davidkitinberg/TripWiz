'use strict';

const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient();

const TABLE_NAME = process.env.TABLE_NAME;

// [Feature #6][Feature #7][Feature #40] Cognito post-confirmation trigger — give every
// new user a default PREFS record with trip-reminder emails enabled, so they start
// receiving notifications immediately without having to visit Settings first.
exports.handler = async (event) => {
  try {
    const attrs  = event.request.userAttributes || {};
    const userId = attrs.sub;
    const email  = attrs.email;

    if (userId && email) {
      const now = new Date().toISOString();
      await ddb.put({
        TableName: TABLE_NAME,
        Item: {
          PK:              `USER#${userId}`,
          SK:              'PREFS',
          entityType:      'UserPrefs',
          email:           String(email).toLowerCase(),
          firstName:       attrs.given_name  || '',
          lastName:        attrs.family_name || '',
          currency:        'USD',
          timezone:        'America/New_York',
          language:        'en',
          notifyTrips:     true,
          notifyMarketing: false,
          createdAt:       now,
          updatedAt:       now,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }).promise();
    }
  } catch (err) {
    if (err.code !== 'ConditionalCheckFailedException') {
      console.error('Failed to create default user prefs on signup', err);
    }
  }

  // Cognito requires the original event to be returned unmodified
  return event;
};
