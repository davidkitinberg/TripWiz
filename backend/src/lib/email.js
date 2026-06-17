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

module.exports = { formatTripDate, buildCollaboratorInviteEmailHtml, sendCollaboratorInviteEmail };
