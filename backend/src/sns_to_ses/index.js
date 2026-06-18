<<<<<<< Updated upstream
const AWS = require('aws-sdk');
const ses = new AWS.SES();
=======
'use strict';

const { sendWeatherAlertEmail } = require('../lib/email');
>>>>>>> Stashed changes

const SOURCE_EMAIL = process.env.SOURCE_EMAIL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SOURCE_EMAIL;

function normalizeAlertPayload(messageObj) {
  // Support the enriched alert payload and older weather-only payloads.
  if (messageObj.tripId && messageObj.reason) return messageObj;

  return {
    tripId: messageObj.tripId || 'unknown',
    userId: messageObj.userId,
    tripTitle: messageObj.tripTitle || 'Your trip',
    reason: messageObj.reason || 'Weather concern detected',
    slot: messageObj.slot || {
      slotId: messageObj.slotId,
      title: messageObj.slotTitle,
      start: messageObj.slotStart,
      coords: messageObj.coords,
      category: messageObj.category,
    },
    weather: messageObj.weather || {
      condition: messageObj.condition,
      description: messageObj.description,
      tempC: messageObj.tempC,
      pop: messageObj.pop,
      windSpeedKnots: messageObj.windSpeedKnots,
      windGustsKnots: messageObj.windGustsKnots,
      cloudCoverOktas: messageObj.cloudCoverOktas,
    },
    toEmail: messageObj.toEmail,
  };
}

// [Feature #41] Convert each published SNS weather alert into an email sent via SES
exports.handler = async (event) => {
  console.log('SNS->SES handler received', JSON.stringify(event));
  if (!SOURCE_EMAIL || !ADMIN_EMAIL) {
    console.error('SOURCE_EMAIL or ADMIN_EMAIL env var not set');
    return { statusCode: 500 };
  }

  for (const rec of event.Records || []) {
    try {
      const sns = rec.Sns;
      let messageObj;
      try { messageObj = JSON.parse(sns.Message); } catch (e) { messageObj = { raw: sns.Message }; }

      const alert = normalizeAlertPayload(messageObj);
      const toEmail = alert.toEmail || ADMIN_EMAIL;

<<<<<<< Updated upstream
      await ses.sendEmail({
        Source: SOURCE_EMAIL,
        Destination: { ToAddresses: [ADMIN_EMAIL] },
        Message: {
          Subject: { Data: subject },
          Body: { Text: { Data: bodyText } }
        }
      }).promise();
      console.log('Email sent for SNS message');
=======
      await sendWeatherAlertEmail({
        toEmail,
        tripTitle: alert.tripTitle,
        tripId: alert.tripId,
        reason: alert.reason,
        slot: alert.slot,
        weather: alert.weather,
      });
      console.log(`Weather alert email sent to ${toEmail}`);
>>>>>>> Stashed changes
    } catch (err) {
      console.error('Failed to send email for SNS message', err);
    }
  }

  return { statusCode: 200 };
};
