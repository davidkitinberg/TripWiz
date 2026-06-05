import config from '../config';
import { getAccessToken } from './auth';

let ws = null;
let currentTripId = null;
const listeners = {};

function emit(event, data) {
  (listeners[event] || []).forEach((fn) => fn(data));
}

export function on(event, handler) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(handler);
  return () => {
    listeners[event] = listeners[event].filter((fn) => fn !== handler);
  };
}

export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// [Feature #29] Open the collaborative WebSocket and join a trip "room"
// [Feature #30] Connection open/close drives the Live/Offline presence indicator
export async function connect(tripId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (currentTripId !== tripId) {
      send({ action: 'leave', tripId: currentTripId });
      currentTripId = tripId;
      send({ action: 'join', tripId });
    }
    return;
  }

  const token = await getAccessToken();
  ws = new WebSocket(`${config.websocket.url}?token=${encodeURIComponent(token)}`);
  currentTripId = tripId;

  ws.onopen = () => {
    send({ action: 'join', tripId });
    emit('connected', {});
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      emit('message', msg);
      if (msg.action) emit(msg.action, msg);
    } catch (_) {
      // Ignore malformed frames
    }
  };

  ws.onclose = () => {
    emit('disconnected', {});
    ws = null;
  };

  ws.onerror = (e) => emit('error', e);
}

export function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
    currentTripId = null;
  }
}
