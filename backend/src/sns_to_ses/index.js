const AWS = require('aws-sdk');
const ses = new AWS.SES();

const SOURCE_EMAIL = process.env.SOURCE_EMAIL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SOURCE_EMAIL;

function buildEmailBody(messageObj) {
  const lines = [];
  lines.push(`Trip ID: ${messageObj.tripId}`);
  lines.push(`User ID: ${messageObj.userId}`);
  if (messageObj.slot) {
    lines.push(`Slot ID: ${messageObj.slot.slotId || 'n/a'}`);
    lines.push(`Slot start: ${messageObj.slot.start || 'n/a'}`);
    if (messageObj.slot.coords) lines.push(`Location: ${messageObj.slot.coords.lat}, ${messageObj.slot.coords.lng}`);
  }
  lines.push(`Reason: ${messageObj.reason || JSON.stringify(messageObj)}`);
  return lines.join('\n');
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
      const subject = sns.Subject || 'TripWiz Alert';
      let messageObj;
      try { messageObj = JSON.parse(sns.Message); } catch (e) { messageObj = { raw: sns.Message }; }

      const bodyText = buildEmailBody(messageObj);

      await ses.sendEmail({
        Source: SOURCE_EMAIL,
        Destination: { ToAddresses: [ADMIN_EMAIL] },
        Message: {
          Subject: { Data: subject },
          Body: { Text: { Data: bodyText } }
        }
      }).promise();
      console.log('Email sent for SNS message');
    } catch (err) {
      console.error('Failed to send email for SNS message', err);
    }
  }

  return { statusCode: 200 };
};
