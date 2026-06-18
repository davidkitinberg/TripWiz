'use strict';

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

// [Review #2] Collaborator-invite email templating + delivery, extracted out of the
// REST monolith so the handler is no longer responsible for HTML composition. Pure,
// self-contained, and independently testable.

const ses = new SESClient({});
const SOURCE_EMAIL = process.env.SOURCE_EMAIL;
const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://tripwiz.app').replace(/\/$/, '');

function formatTripDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function formatSlotDateTime(iso) {
  if (!iso) return 'Not scheduled';
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCategory(category) {
  const labels = {
    BEACH: 'Beach',
    SKI: 'Ski',
    SCENIC_VIEW: 'Scenic view',
    INDOOR: 'Indoor',
    GENERAL_OUTDOOR: 'Outdoor',
  };
  return labels[category] || category || 'Outdoor';
}

function buildWeatherAlertEmailHtml({
  tripTitle,
  tripId,
  reason,
  slot = {},
  weather = {},
}) {
  const tripUrl = `${FRONTEND_URL}/trips/${tripId}`;
  const rainPct = weather.pop != null ? `${Math.round(weather.pop * 100)}%` : '—';
  const temp = weather.tempC != null ? `${weather.tempC}°C` : '—';
  const wind = weather.windSpeedKnots != null ? `${Math.round(weather.windSpeedKnots)} kn` : '—';
  const clouds = weather.cloudCoverOktas != null ? `${weather.cloudCoverOktas}/8` : '—';
  const coords = slot.coords
    ? `${Number(slot.coords.lat).toFixed(2)}, ${Number(slot.coords.lng).toFixed(2)}`
    : '—';

  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#d97706,#ea580c);border-radius:14px 14px 0 0;padding:36px 32px;text-align:center;">
      <p style="color:rgba(255,255,255,0.75);font-size:12px;margin:0 0 6px;letter-spacing:1.5px;text-transform:uppercase;">TripWiz Weather Alert</p>
      <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700;">⚠️ Weather concern detected</h1>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:32px;">
      <p style="color:#4b5563;margin:0 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.08em;">Trip</p>
      <h2 style="color:#111827;margin:0 0 20px;font-size:22px;font-weight:700;">${escapeHtml(tripTitle || 'Your trip')}</h2>

      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px 18px;margin-bottom:24px;">
        <p style="color:#9a3412;margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Warning</p>
        <p style="color:#7c2d12;margin:0;font-size:16px;line-height:1.55;font-weight:600;">${escapeHtml(reason)}</p>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;width:40%;">Affected stop</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(slot.title || 'Scheduled stop')}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">When</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;">${escapeHtml(formatSlotDateTime(slot.start))}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Activity type</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;">${escapeHtml(formatCategory(slot.category))}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Forecast</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;">${escapeHtml(weather.description || weather.condition || '—')}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Temperature</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;">${escapeHtml(temp)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Rain chance</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;">${escapeHtml(rainPct)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Wind</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;">${escapeHtml(wind)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Cloud cover</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;">${escapeHtml(clouds)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:14px;">Location</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;">${escapeHtml(coords)}</td>
        </tr>
      </table>

      <div style="text-align:center;">
        <a href="${tripUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
          Review trip in TripWiz
        </a>
      </div>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px;">
      Trip ID: ${escapeHtml(tripId)} · You received this because TripWiz detected a weather risk for a planned stop.
    </p>
  </div>
</body>
</html>`;
}

function buildWeatherAlertEmailText({ tripTitle, tripId, reason, slot = {}, weather = {} }) {
  const lines = [
    'TripWiz Weather Alert',
    '',
    `Trip: ${tripTitle || 'Your trip'}`,
    `Trip ID: ${tripId}`,
    '',
    `Warning: ${reason}`,
    '',
    `Stop: ${slot.title || 'Scheduled stop'}`,
    `When: ${formatSlotDateTime(slot.start)}`,
    `Activity: ${formatCategory(slot.category)}`,
    `Forecast: ${weather.description || weather.condition || '—'}`,
    `Temperature: ${weather.tempC != null ? `${weather.tempC}°C` : '—'}`,
    `Rain chance: ${weather.pop != null ? `${Math.round(weather.pop * 100)}%` : '—'}`,
    `Wind: ${weather.windSpeedKnots != null ? `${Math.round(weather.windSpeedKnots)} kn` : '—'}`,
    '',
    `Open trip: ${FRONTEND_URL}/trips/${tripId}`,
  ];
  return lines.join('\n');
}

async function sendWeatherAlertEmail({ toEmail, tripTitle, tripId, reason, slot, weather }) {
  if (!SOURCE_EMAIL) throw new Error('SOURCE_EMAIL is not configured');

  const subject = `Weather alert: ${tripTitle || 'your trip'}`;
  const html = buildWeatherAlertEmailHtml({ tripTitle, tripId, reason, slot, weather });
  const text = buildWeatherAlertEmailText({ tripTitle, tripId, reason, slot, weather });

  await ses.send(new SendEmailCommand({
    Source: SOURCE_EMAIL,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: html, Charset: 'UTF-8' },
        Text: { Data: text, Charset: 'UTF-8' },
      },
    },
  }));
}

function buildCollaboratorInviteEmailHtml({ tripTitle, tripId, inviterEmail, role, startDate, endDate }) {
  const tripUrl = `${FRONTEND_URL}/trips/${tripId}`;
  const roleLabel = role === 'editor' ? 'Editor' : 'Viewer';
  const dateLine = startDate
    ? `<p style="color:#4b5563;margin:0 0 16px;">Dates: <strong>${formatTripDate(startDate)}</strong>${endDate ? ` – <strong>${formatTripDate(endDate)}</strong>` : ''}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:14px 14px 0 0;padding:36px 32px;text-align:center;">
      <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:0 0 6px;letter-spacing:1.5px;text-transform:uppercase;">TripWiz</p>
      <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700;">You've been invited to a trip</h1>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:32px;">
      <p style="color:#4b5563;margin:0 0 16px;line-height:1.6;">
        <strong>${inviterEmail}</strong> invited you to collaborate on
        <strong>${tripTitle}</strong> as an <strong>${roleLabel}</strong>.
      </p>
      ${dateLine}
      <p style="color:#4b5563;margin:0 0 24px;line-height:1.6;">
        Sign in to TripWiz to view the itinerary, edit stops together in real time, and help plan the trip.
      </p>
      <div style="text-align:center;">
        <a href="${tripUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
          Open Trip
        </a>
      </div>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px;">
      You received this because a TripWiz user shared a trip with your account.
    </p>
  </div>
</body>
</html>`;
}

async function sendCollaboratorInviteEmail({ toEmail, tripTitle, tripId, inviterEmail, role, startDate, endDate }) {
  if (!SOURCE_EMAIL) {
    // Throw so callers can report that the notification was not delivered, rather than
    // silently treating an unconfigured sender as a successful send.
    throw new Error('SOURCE_EMAIL is not configured');
  }

  const subject = `You're invited to plan "${tripTitle}" on TripWiz`;
  const html = buildCollaboratorInviteEmailHtml({ tripTitle, tripId, inviterEmail, role, startDate, endDate });

  await ses.send(new SendEmailCommand({
    Source: SOURCE_EMAIL,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: html, Charset: 'UTF-8' } }
    }
  }));
}

module.exports = {
  formatTripDate,
  buildCollaboratorInviteEmailHtml,
  sendCollaboratorInviteEmail,
  buildWeatherAlertEmailHtml,
  buildWeatherAlertEmailText,
  sendWeatherAlertEmail,
};
