import config from '../config';
import { getIdToken } from './auth';

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

export const api = {
  getTrips: () => request('GET', '/trips'),
  createTrip: (data) => request('POST', '/trips', data),
  getTrip: (tripId) => request('GET', `/trips/${tripId}`),
  updateTrip: (tripId, data) => request('PUT', `/trips/${tripId}`, data),
  deleteTrip: (tripId) => request('DELETE', `/trips/${tripId}`),
  validateTrip: (tripId) => request('POST', `/trips/${tripId}/validate`, {}),
  getTripAlerts: (tripId) => request('GET', `/trips/${tripId}/alerts`),
  getTripFallbacks: (tripId) => request('GET', `/trips/${tripId}/fallbacks`),
  getTripCollaborators: (tripId) => request('GET', `/trips/${tripId}/collaborators`),
  inviteCollaborator: (tripId, email) => request('POST', `/trips/${tripId}/invite`, { email }),
  removeCollaborator: (tripId, userId) => request('DELETE', `/trips/${tripId}/invite/${userId}`),
  optimizeRoute: (tripId) => request('POST', `/trips/${tripId}/optimize`, {}),
  calculateRoute: (waypoints, profile = 'driving') =>
    request('POST', '/routes/calculate', { waypoints, profile }),
};
