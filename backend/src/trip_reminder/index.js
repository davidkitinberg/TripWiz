/**
 * @fileoverview Scheduled Lambda that emails trip reminders before upcoming departures.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

'use strict';

const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient();
const ses = new AWS.SES();

const TABLE_NAME    = process.env.TABLE_NAME;
const SOURCE_EMAIL  = process.env.SOURCE_EMAIL;
const REMINDER_DAYS = parseInt(process.env.REMINDER_DAYS || '2', 10);

async function getUpcomingTrips() {
  const now    = new Date();
  const cutoff = new Date(now.getTime() + REMINDER_DAYS * 24 * 3600 * 1000);
  const res = await ddb.query({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :gpk AND tripStart BETWEEN :now AND :cutoff',
    FilterExpression: 'attribute_not_exists(deleted) OR deleted = :f',
    ExpressionAttributeValues: {
      ':gpk':    'TRIP',
      ':now':    now.toISOString(),
      ':cutoff': cutoff.toISOString(),
      ':f':      false,
    },
  }).promise();
  return res.Items || [];
}

async function getUserPrefs(userId) {
  const res = await ddb.get({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: 'PREFS' },
  }).promise();
  return res.Item || null;
}

async function getActiveAlerts(tripId) {
  const res = await ddb.query({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skp)',
    ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':skp': 'ALERT#' },
  }).promise();
  return res.Items || [];
}

function formatDate(iso) {
  if (!iso) return 'soon';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function buildEmailHtml(trip, alerts, prefs) {
  const name      = prefs.firstName || 'Traveller';
  const startDate = formatDate(trip.tripStart || trip.startDate);

  const alertsBlock = alerts.length ? `
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:16px 20px;margin:20px 0;">
      <p style="color:#b91c1c;font-weight:700;margin:0 0 10px;font-size:15px;">Weather Alerts</p>
      ${alerts.map((a) => `
        <div style="padding:8px 0;border-top:1px solid #fecaca;">
          <strong style="color:#111827;">${a.slotTitle || 'Stop'}</strong><br/>
          <span style="color:#6b7280;font-size:13px;">${a.reason || `${a.weatherCondition} — ${Math.round((a.precipitationProb || 0) * 100)}% precipitation chance`}</span>
        </div>`).join('')}
    </div>` : '';

  const stops = trip.itinerary || [];
  const itineraryBlock = stops.length ? `
    <h3 style="color:#4f46e5;font-size:16px;margin:24px 0 12px;">Your Itinerary</h3>
    ${stops.map((slot, i) => `
      <div style="display:flex;gap:14px;padding:12px 0;border-bottom:1px solid #f3f4f6;align-items:flex-start;">
        <div style="min-width:28px;height:28px;background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:50%;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${i + 1}</div>
        <div>
          <strong style="color:#111827;">${slot.title || 'Stop'}</strong>
          ${slot.start ? `<br/><span style="color:#6b7280;font-size:13px;">${formatTime(slot.start)}</span>` : ''}
          ${slot.notes ? `<br/><span style="color:#9ca3af;font-size:13px;">${slot.notes}</span>` : ''}
        </div>
      </div>`).join('')}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:14px 14px 0 0;padding:36px 32px;text-align:center;">
      <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:0 0 6px;letter-spacing:1.5px;text-transform:uppercase;">TripWiz</p>
      <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700;">Your trip is coming up!</h1>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:32px;">
      <h2 style="color:#111827;margin:0 0 8px;">Hi ${name},</h2>
      <p style="color:#4b5563;margin:0 0 4px;">
        <strong>${trip.title || 'Your Trip'}</strong> starts on <strong>${startDate}</strong>.
        ${alerts.length ? 'We spotted some weather alerts you should know about.' : 'Everything looks great so far.'}
      </p>
      ${alertsBlock}
      ${itineraryBlock}
      <div style="text-align:center;margin-top:32px;">
        <a href="https://tripwiz.app/trips/${trip.tripId}"
           style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
          Open My Trip
        </a>
      </div>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px;">
      You received this because trip reminders are enabled on your TripWiz account.
      <a href="https://tripwiz.app/settings" style="color:#6366f1;">Manage preferences</a>
    </p>
  </div>
</body>
</html>`;
}

// [Feature #40] Daily trip reminder emails — for trips starting within REMINDER_DAYS,
// respect each owner's notifyTrips preference and send a branded HTML email via SES.
exports.handler = async () => {
  console.log('TripReminder Lambda invoked', { REMINDER_DAYS });

  if (!TABLE_NAME || !SOURCE_EMAIL) {
    console.error('Missing required env vars: TABLE_NAME or SOURCE_EMAIL');
    return { statusCode: 500 };
  }

  const trips = await getUpcomingTrips();
  console.log(`Upcoming trips in next ${REMINDER_DAYS} day(s): ${trips.length}`);

  let sent = 0;
  let skipped = 0;

  for (const trip of trips) {
    try {
      const ownerId = trip.ownerId || trip.userId;
      if (!ownerId) { skipped++; continue; }

      const prefs = await getUserPrefs(ownerId);
      if (!prefs?.notifyTrips || !prefs?.email) { skipped++; continue; }

      const alerts  = await getActiveAlerts(trip.tripId);
      const html    = buildEmailHtml(trip, alerts, prefs);
      const subject = alerts.length
        ? `Weather alert for "${trip.title || 'Your Trip'}"`
        : `Reminder: "${trip.title || 'Your Trip'}" starts ${REMINDER_DAYS === 1 ? 'tomorrow' : `in ${REMINDER_DAYS} days`}`;

      await ses.sendEmail({
        Source:      SOURCE_EMAIL,
        Destination: { ToAddresses: [prefs.email] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body:    { Html: { Data: html, Charset: 'UTF-8' } },
        },
      }).promise();

      sent++;
      console.log(`Sent reminder: trip=${trip.tripId} to=${prefs.email}`);
    } catch (err) {
      console.warn(`Reminder failed for trip ${trip.tripId}:`, err.message);
      skipped++;
    }
  }

  console.log(`TripReminder done — sent=${sent} skipped=${skipped} total=${trips.length}`);
  return { statusCode: 200, body: JSON.stringify({ sent, skipped, total: trips.length }) };
};
