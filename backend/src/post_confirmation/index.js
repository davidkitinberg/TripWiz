'use strict';

<<<<<<< Updated upstream
const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient();
=======
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
} = require('@aws-sdk/client-sesv2');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESv2Client({});
>>>>>>> Stashed changes

const TABLE_NAME = process.env.TABLE_NAME;

async function ensureSesIdentity(email) {
  const address = String(email).trim().toLowerCase();
  if (!address) return;

  try {
    const existing = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: address }));
    if (existing?.VerifiedForSendingStatus === 'SUCCESS') return;
  } catch (err) {
    if (err.name !== 'NotFoundException') {
      console.warn(`SES identity lookup failed for ${address}:`, err.message);
      return;
    }
  }

  try {
    await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: address }));
    console.log(`SES identity verification requested for ${address}`);
  } catch (err) {
    if (err.name === 'AlreadyExistsException') return;
    console.warn(`SES identity creation failed for ${address}:`, err.message);
  }
}

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
<<<<<<< Updated upstream
      }).promise();
=======
      }));

      await ensureSesIdentity(email);
>>>>>>> Stashed changes
    }
  } catch (err) {
    if (err.code !== 'ConditionalCheckFailedException') {
      console.error('Failed to create default user prefs on signup', err);
    }
  }

  // Cognito requires the original event to be returned unmodified
  return event;
};
