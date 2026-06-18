/**
 * @fileoverview HTTP client for the TripWiz REST API with Cognito JWT authorization.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

import config from '../config';
import { getIdToken } from './auth';

// [Feature #4] Every API call carries the Cognito JWT ID token for authorization
async function request(method, path, body) {
  const token = await getIdToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${config.api.baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));

  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }

  return data;
}

// [Feature #35] Browser uploads a trip document straight to S3 via a presigned PUT URL
async function uploadToSignedUrl(uploadUrl, file) {
  const fallbackTypeByExtension = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  const extension = String(file.name || '').toLowerCase().split('.').pop();
  const contentType = file.type || fallbackTypeByExtension[extension] || 'application/octet-stream';
  try {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: file,
    });
    if (!res.ok) {
      throw new Error(`S3 upload failed with HTTP ${res.status}`);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('S3 upload failed before a response was received. Check the documents bucket CORS configuration and redeploy the backend stack.');
    }
    throw err;
  }
}

export const api = {
  getTrips: () => request('GET', '/trips'),
  createTrip: (data) => request('POST', '/trips', data),
  getTrip: (tripId) => request('GET', `/trips/${tripId}`),
  updateTrip: (tripId, data) => request('PUT', `/trips/${tripId}`, data),
  deleteTrip: (tripId) => request('DELETE', `/trips/${tripId}`),
  validateTrip: (tripId) => request('POST', `/trips/${tripId}/validate`, {}),
  getTripAlerts: (tripId) => request('GET', `/trips/${tripId}/alerts`),
  getTripFallbacks: (tripId) => request('GET', `/trips/${tripId}/fallbacks`),
  getTripWeather: (tripId) => request('GET', `/trips/${tripId}/weather`),
  getTripAttachments: (tripId) => request('GET', `/trips/${tripId}/attachments`),
  createAttachmentUploadUrl: (tripId, data) => request('POST', `/trips/${tripId}/attachments/upload-url`, data),
  completeAttachmentUpload: (tripId, fileId, data) => request('POST', `/trips/${tripId}/attachments/${fileId}/complete`, data),
  getAttachmentDownloadUrl: (tripId, fileId) => request('GET', `/trips/${tripId}/attachments/${fileId}/download-url`),
  deleteAttachment: (tripId, fileId) => request('DELETE', `/trips/${tripId}/attachments/${fileId}`),
  uploadToSignedUrl,
  getTripCollaborators: (tripId) => request('GET', `/trips/${tripId}/collaborators`),
  inviteCollaborator: (tripId, email) => request('POST', `/trips/${tripId}/invite`, { email }),
  removeCollaborator: (tripId, userId) => request('DELETE', `/trips/${tripId}/invite/${userId}`),
  optimizeRoute: (tripId) => request('POST', `/trips/${tripId}/optimize`, {}),
  calculateRoute: (stops) => request('POST', '/routes/calculate', { stops }),
  searchPlaces: (q, biasLng, biasLat) => {
    const params = new URLSearchParams({ q });
    if (biasLng != null) params.set('lng', biasLng);
    if (biasLat != null) params.set('lat', biasLat);
    return request('GET', `/places/search?${params}`);
  },

  // User preferences (synced to DynamoDB so the reminder Lambda can read them)
  getUserPrefs:  ()      => request('GET', '/user/prefs'),
  saveUserPrefs: (prefs) => request('PUT', '/user/prefs', prefs),

  // Trending destinations (read available to any signed-in user)
  getTrending: () => request('GET', '/trending'),

  // Admin endpoints
  getAdminMetrics:    () => request('GET', '/admin/metrics'),
  getAdminUsers:      () => request('GET', '/admin/users'),
  suspendUser:        (userId) => request('POST', `/admin/users/${userId}/suspend`, {}),
  unsuspendUser:      (userId) => request('POST', `/admin/users/${userId}/unsuspend`, {}),
  deleteUserAccount:  (userId) => request('DELETE', `/admin/users/${userId}`),
  getAdminTrips:      (q) => request('GET', `/admin/trips${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  deleteAdminTrip:    (tripId) => request('DELETE', `/admin/trips/${tripId}`),
  hideAdminTrip:      (tripId, hidden) => request('POST', `/admin/trips/${tripId}/hide`, { hidden }),
  updateTrending:     (destinations) => request('PUT', '/admin/trending', { destinations }),
};
