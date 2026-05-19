import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { connect, disconnect, on } from '../services/websocket';
import TripMap from '../components/TripMap';

/* ─────────────── Helpers ─────────────── */

function useDebounce(value, delay) {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return dv;
}

function estimateHours(osmClass, osmType) {
  if (osmClass === 'amenity') {
    if (['restaurant', 'cafe', 'bar', 'fast_food', 'pub'].includes(osmType)) return '1–2';
    if (['cinema', 'theatre', 'arts_centre'].includes(osmType)) return '2–3';
  }
  if (osmClass === 'tourism') {
    if (osmType === 'museum') return '2–3';
    if (osmType === 'gallery') return '1–2';
    if (osmType === 'viewpoint') return '0.5–1';
    if (['attraction', 'artwork'].includes(osmType)) return '1–2';
    if (osmType === 'theme_park') return '4–6';
    if (osmType === 'zoo') return '3–4';
  }
  if (osmClass === 'leisure') {
    if (['park', 'garden', 'nature_reserve'].includes(osmType)) return '1–3';
    if (['beach_resort', 'water_park'].includes(osmType)) return '3–5';
  }
  if (osmClass === 'natural') {
    if (osmType === 'beach') return '2–4';
    if (osmType === 'peak') return '3–6';
  }
  if (osmClass === 'historic') return '1–3';
  if (osmClass === 'shop') return '0.5–1';
  return '2–3';
}

function parseLowerHours(label) {
  if (!label) return 2;
  const first = String(label).split(/[–-]/)[0];
  const n = parseFloat(first);
  return Number.isFinite(n) ? n : 2;
}

const DAY_COLORS = [
  '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B',
  '#EF4444', '#EC4899', '#06B6D4', '#84CC16',
];

function routeDistance(stops) {
  let total = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) continue;
    total += Math.hypot(a.lat - b.lat, a.lng - b.lng);
  }
  return total;
}

function nearestNeighborOrder(stops) {
  const withCoords = stops.filter((s) => s.lat != null && s.lng != null);
  const withoutCoords = stops.filter((s) => s.lat == null || s.lng == null);
  if (withCoords.length <= 2) return [...withCoords, ...withoutCoords];
  const result = [withCoords[0]];
  const remaining = withCoords.slice(1);
  while (remaining.length > 0) {
    const last = result[result.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = Math.hypot(s.lat - last.lat, s.lng - last.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    result.push(...remaining.splice(bestIdx, 1));
  }
  return [...result, ...withoutCoords];
}

function formatHHMM(hourDecimal) {
  const h = Math.floor(hourDecimal);
  const m = Math.round((hourDecimal - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getTotalDays(trip, stops) {
  let fromDates = 1;
  if (trip?.startDate) {
    const start = new Date(trip.startDate);
    const end = trip.endDate ? new Date(trip.endDate) : start;
    const diff = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;
    fromDates = Math.max(1, diff);
  }
  const fromStops = stops.reduce((mx, s) => Math.max(mx, (s.dayIndex || 0) + 1), 0);
  return Math.max(fromDates, fromStops, 1);
}

function formatDayLabel(tripStartDate, dayIndex) {
  if (!tripStartDate) return `Day ${dayIndex + 1}`;
  const date = new Date(tripStartDate);
  date.setDate(date.getDate() + dayIndex);
  const label = date.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  return `Day ${dayIndex + 1} · ${label}`;
}

function compareStopsInDay(a, b) {
  if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
  if (a.startTime) return -1;
  if (b.startTime) return 1;
  return 0;
}

/* ─── Convert between API itinerary and our stop shape ─── */

function stopsToItinerary(stops, tripStartDate) {
  return stops.map((s) => {
    let start = '';
    if (s.startTime && tripStartDate) {
      const d = new Date(tripStartDate);
      d.setDate(d.getDate() + (s.dayIndex || 0));
      const [hh, mm] = s.startTime.split(':');
      d.setHours(parseInt(hh, 10) || 0, parseInt(mm, 10) || 0, 0, 0);
      start = d.toISOString();
    }
    return {
      slotId: s.stopId,
      title: s.name,
      coords: s.lat != null ? { lat: s.lat, lng: s.lng } : undefined,
      notes: s.recommendedHours,
      dayIndex: s.dayIndex || 0,
      start,
      end: '',
    };
  });
}

function itineraryToStops(itinerary, tripStartDate) {
  return (itinerary || []).map((item, i) => {
    let dayIndex = item.dayIndex || 0;
    let startTime = '';
    if (item.start) {
      const d = new Date(item.start);
      if (!isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        startTime = `${hh}:${mm}`;
        if (tripStartDate && !item.dayIndex) {
          const tripDate = new Date(tripStartDate);
          tripDate.setHours(0, 0, 0, 0);
          const stopDate = new Date(d);
          stopDate.setHours(0, 0, 0, 0);
          const diffDays = Math.floor((stopDate - tripDate) / (1000 * 60 * 60 * 24));
          if (diffDays >= 0) dayIndex = diffDays;
        }
      }
    }
    return {
      stopId: item.slotId || `s-${i}-${Date.now()}`,
      name: item.title || 'Unnamed Location',
      lat: item.coords?.lat ?? null,
      lng: item.coords?.lng ?? null,
      recommendedHours: item.notes || '2–3',
      dayIndex,
      startTime,
    };
  });
}

/* ─────────────── Autocomplete ─────────────── */

function LocationAutocomplete({ onSelect }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef(null);
  const debouncedQuery = useDebounce(query, 350);

  useEffect(() => {
    if (debouncedQuery.length < 2) { setSuggestions([]); return; }
    setLoading(true);
    fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(debouncedQuery)}&format=json&limit=6&addressdetails=0`,
      { headers: { 'Accept-Language': 'en-US,en' } }
    )
      .then((r) => r.json())
      .then((data) => {
        setSuggestions(data.map((r) => ({
          label: r.display_name,
          short: r.display_name.split(',').slice(0, 2).join(',').trim(),
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lon),
          osmClass: r.class,
          osmType: r.type,
        })));
        setOpen(true);
        setActiveIdx(-1);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debouncedQuery]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function selectSuggestion(s) {
    onSelect({
      name: s.short,
      lat: s.lat,
      lng: s.lng,
      recommendedHours: estimateHours(s.osmClass, s.osmType),
    });
    setQuery('');
    setSuggestions([]);
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); selectSuggestion(suggestions[activeIdx]); }
    if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div className="planner-add-wrapper" ref={wrapperRef}>
      <div className="planner-add-input-row">
        <span className="planner-add-icon">+</span>
        <input
          className="planner-add-input"
          type="text"
          placeholder="Add a destination or landmark…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        {loading && <span className="planner-add-spinner">⋯</span>}
      </div>
      {open && suggestions.length > 0 && (
        <ul className="autocomplete-dropdown planner-autocomplete">
          {suggestions.map((s, i) => (
            <li
              key={i}
              className={`autocomplete-item ${i === activeIdx ? 'autocomplete-item--active' : ''}`}
              onMouseDown={() => selectSuggestion(s)}
            >
              <span className="autocomplete-pin">📍</span>
              <span className="autocomplete-label">{s.short}</span>
              <span className="autocomplete-full">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────────── Stop card ─────────────── */

function StopCard({ stop, globalNum, totalDays, canEdit, alert, suggestions, onRemove, onChangeDay, onChangeTime, onReplace }) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const hasSuggestions = alert && suggestions && suggestions.length > 0;

  return (
    <div className={`stop-card ${alert ? 'stop-card--alert' : ''}`}>
      <div className="stop-num">{globalNum}</div>
      <div className="stop-info">
        <div className="stop-name">
          {stop.name}
          {alert && <span className="stop-alert-badge" title={alert.reason}>⚠️</span>}
        </div>
        <div className="stop-meta-row">
          <span className="stop-duration">🕒 {stop.recommendedHours} hrs</span>
        </div>
        {canEdit && (
          <div className="stop-controls">
            <label className="stop-control">
              <span className="stop-control-label">Day</span>
              <select
                className="stop-day-select"
                value={stop.dayIndex || 0}
                onChange={(e) => onChangeDay(parseInt(e.target.value, 10))}
              >
                {Array.from({ length: totalDays }, (_, i) => (
                  <option key={i} value={i}>Day {i + 1}</option>
                ))}
              </select>
            </label>
            <label className="stop-control">
              <span className="stop-control-label">Time</span>
              <input
                className="stop-time-input"
                type="time"
                value={stop.startTime || ''}
                onChange={(e) => onChangeTime(e.target.value)}
              />
            </label>
          </div>
        )}
        {alert && (
          <div className="stop-alert-reason">
            <strong>Weather warning:</strong> {alert.reason}
            {hasSuggestions && canEdit && (
              <button
                className="stop-suggestions-toggle"
                onClick={() => setShowSuggestions((v) => !v)}
              >
                {showSuggestions ? 'Hide alternatives' : `View ${suggestions.length} indoor alternative${suggestions.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        )}
        {hasSuggestions && showSuggestions && canEdit && (
          <div className="stop-suggestions">
            <div className="stop-suggestions-title">💡 Nearby indoor options:</div>
            {suggestions.map((s, i) => (
              <div key={i} className="stop-suggestion">
                <div className="stop-suggestion-info">
                  <div className="stop-suggestion-name">{s.name}</div>
                  <div className="stop-suggestion-meta">
                    {s.category}
                    {s.distance != null && ` · ${(s.distance / 1000).toFixed(1)} km away`}
                  </div>
                </div>
                <button
                  className="stop-suggestion-replace"
                  onClick={() => onReplace(s)}
                  title={`Replace with ${s.name}`}
                >
                  Replace
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {canEdit && (
        <button className="stop-remove-btn" onClick={onRemove} title="Remove">×</button>
      )}
    </div>
  );
}

/* ─────────────── Page ─────────────── */

export default function TripPage() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const [trip, setTrip] = useState(null);
  const [stops, setStops] = useState([]);
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('saved');
  const [wsConnected, setWsConnected] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [validateMsg, setValidateMsg] = useState('');
  const [validating, setValidating] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [fallbacks, setFallbacks] = useState({});
  const [lastValidatedAt, setLastValidatedAt] = useState(null);

  const [showShareModal, setShowShareModal] = useState(false);
  const [collaborators, setCollaborators] = useState([]);
  const [callerIsOwner, setCallerIsOwner] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [copyToast, setCopyToast] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  const [routeSuggestion, setRouteSuggestion] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
  const [activeDayFilter, setActiveDayFilter] = useState('all');
  const [pendingLocation, setPendingLocation] = useState(null);
  const [pendingDay, setPendingDay] = useState(0);
  const [pendingTime, setPendingTime] = useState('');

  const versionRef = useRef(1);
  const saveTimerRef = useRef(null);
  const tripRef = useRef(null);
  tripRef.current = trip;
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  useEffect(() => {
    api.getTrip(tripId)
      .then((res) => {
        setTrip(res.trip);
        setStops(itineraryToStops(res.trip.itinerary, res.trip.startDate));
        setAccess(res.access);
        versionRef.current = res.trip.version || 1;
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    api.getTripAlerts(tripId)
      .then((res) => {
        setAlerts(res.alerts || []);
        setLastValidatedAt(res.lastValidatedAt || null);
      })
      .catch((err) => console.warn('Failed to load alerts:', err));

    api.getTripFallbacks(tripId)
      .then((res) => {
        const map = {};
        (res.fallbacks || []).forEach((f) => { map[f.slotId] = f.suggestions || []; });
        setFallbacks(map);
      })
      .catch((err) => console.warn('Failed to load fallbacks:', err));
  }, [tripId]);

  useEffect(() => {
    const offConnected = on('connected', () => setWsConnected(true));
    const offDisconnected = on('disconnected', () => setWsConnected(false));
    const offEdit = on('edit', (msg) => {
      if (msg.payload?.accepted && msg.payload?.trip) {
        const incoming = msg.payload.trip;
        setTrip(incoming);
        setStops(itineraryToStops(incoming.itinerary, incoming.startDate));
        versionRef.current = incoming.version;
      }
    });
    connect(tripId).catch(console.warn);
    return () => { offConnected(); offDisconnected(); offEdit(); disconnect(); };
  }, [tripId]);

  const canEdit = access === 'owner' || access === 'editor';

  async function doSave(newStops, newTitle) {
    setSaveStatus('saving');
    try {
      const tripStartDate = tripRef.current?.startDate;
      const patch = {
        itinerary: stopsToItinerary(newStops, tripStartDate),
        version: versionRef.current,
      };
      if (newTitle !== undefined) patch.title = newTitle;
      const res = await api.updateTrip(tripId, patch);
      setTrip(res.trip);
      versionRef.current = res.trip.version;
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('unsaved');
      if (err.code === 'VERSION_CONFLICT') {
        setError('Version conflict — someone else edited this trip. Refresh to get the latest.');
      } else {
        setError(err.message);
      }
    }
  }

  function scheduleSave(newStops) {
    setSaveStatus('unsaved');
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => doSave(newStops), 1200);
  }

  function handleLocationSelect(location) {
    const defaultDay = activeDayFilter !== 'all' ? Number(activeDayFilter) : 0;
    setPendingDay(defaultDay);
    setPendingTime('');
    setPendingLocation(location);
  }

  function confirmAddStop() {
    if (!pendingLocation) return;
    const newStop = {
      stopId: `s-${Date.now()}`,
      name: pendingLocation.name,
      lat: pendingLocation.lat,
      lng: pendingLocation.lng,
      recommendedHours: pendingLocation.recommendedHours || '2–3',
      dayIndex: pendingDay,
      startTime: pendingTime,
    };
    setStops((prev) => {
      const next = [...prev, newStop];
      scheduleSave(next);
      return next;
    });
    setPendingLocation(null);
  }

  function addStop(location) {
    const newStop = {
      stopId: `s-${Date.now()}`,
      name: location.name,
      lat: location.lat,
      lng: location.lng,
      recommendedHours: location.recommendedHours || '2–3',
      dayIndex: 0,
      startTime: '',
    };
    setStops((prev) => {
      const next = [...prev, newStop];
      scheduleSave(next);
      return next;
    });
  }

  function removeStop(stopId) {
    setStops((prev) => {
      const next = prev.filter((s) => s.stopId !== stopId);
      scheduleSave(next);
      return next;
    });
  }

  function updateStop(stopId, updates) {
    setStops((prev) => {
      const next = prev.map((s) => (s.stopId === stopId ? { ...s, ...updates } : s));
      scheduleSave(next);
      return next;
    });
  }

  function replaceStop(stopId, suggestion) {
    updateStop(stopId, {
      name: suggestion.name,
      lat: suggestion.lat,
      lng: suggestion.lng,
      recommendedHours: '1–2',
    });
    setAlerts((prev) => prev.filter((a) => a.slotId !== stopId));
    setFallbacks((prev) => {
      const next = { ...prev };
      delete next[stopId];
      return next;
    });
  }

  /* Optimize via Amazon Bedrock (Claude Haiku 4.5). The backend returns a
     suggested order + reasoning; we build a preview the user can Apply or Cancel. */
  async function handleOptimize() {
    if (optimizing) return;
    const stopsWithCoords = stops.filter((s) => s.lat != null && s.lng != null);
    if (stopsWithCoords.length < 2) {
      setValidateMsg('Add at least 2 stops with locations before optimizing.');
      return;
    }
    setOptimizing(true);
    setValidateMsg('🤖 Claude is planning the smartest route…');
    try {
      const result = await api.optimizeRoute(tripId);
      const proposed = new Map((result.stops || []).map((p) => [p.stopId, p]));

      // Reorder current stops to match Bedrock's suggested order; append any unmatched.
      const ordered = [];
      const seen = new Set();
      (result.stops || []).forEach((p) => {
        const cur = stops.find((s) => s.stopId === p.stopId);
        if (cur) {
          ordered.push({
            ...cur,
            dayIndex: Number.isInteger(p.dayIndex) ? p.dayIndex : (cur.dayIndex || 0),
            startTime: p.startTime || cur.startTime
          });
          seen.add(cur.stopId);
        }
      });
      stops.forEach((s) => { if (!seen.has(s.stopId)) ordered.push({ ...s }); });

      // Compute distance savings as a bonus stat (best-effort, Euclidean).
      let originalDistance = 0;
      let optimizedDistance = 0;
      const days = getTotalDays(tripRef.current, ordered);
      for (let d = 0; d < days; d++) {
        const orig = stops.filter((s) => (s.dayIndex || 0) === d).sort(compareStopsInDay);
        const opt = ordered.filter((s) => (s.dayIndex || 0) === d).sort(compareStopsInDay);
        originalDistance += routeDistance(orig);
        optimizedDistance += routeDistance(opt);
      }
      const savings = originalDistance > 0
        ? Math.max(0, (originalDistance - optimizedDistance) / originalDistance)
        : 0;

      const orderChanged = ordered.some((s, i) => !stops[i] || s.stopId !== stops[i].stopId);
      const timesChanged = ordered.some((s, i) => !stops[i] || s.startTime !== stops[i].startTime);

      if (!orderChanged && !timesChanged) {
        setValidateMsg('✓ Claude says your itinerary is already optimal — no changes suggested.');
        return;
      }

      setRouteSuggestion({
        stops: ordered,
        orderChanged,
        timesChanged,
        savings,
        reasoning: result.reasoning || '',
        model: result.model
      });
      setValidateMsg('');
    } catch (err) {
      setValidateMsg(
        `Optimize failed: ${err.message}. ` +
        'Make sure Claude Haiku 4.5 is enabled in Bedrock model access for your AWS account in us-east-1.'
      );
    } finally {
      setOptimizing(false);
    }
  }

  function applyRouteSuggestion() {
    if (!routeSuggestion) return;
    setStops(routeSuggestion.stops);
    scheduleSave(routeSuggestion.stops);
    setRouteSuggestion(null);
  }

  function dismissRouteSuggestion() {
    setRouteSuggestion(null);
  }

  function startEditTitle() {
    setTitleDraft(trip?.title || '');
    setEditingTitle(true);
  }

  function saveTitle() {
    setEditingTitle(false);
    const newTitle = titleDraft.trim();
    if (!newTitle || newTitle === trip?.title) return;
    setTrip((t) => ({ ...t, title: newTitle }));
    clearTimeout(saveTimerRef.current);
    doSave(stopsRef.current, newTitle);
  }

  async function openShareModal() {
    setShowShareModal(true);
    setInviteError('');
    try {
      const res = await api.getTripCollaborators(tripId);
      setCollaborators(res.collaborators || []);
      setCallerIsOwner(!!res.callerIsOwner);
    } catch (err) {
      console.warn('Failed to load collaborators:', err);
    }
  }

  function closeShareModal() {
    setShowShareModal(false);
    setInviteEmail('');
    setInviteError('');
  }

  async function handleInvite(e) {
    e.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setInviting(true);
    setInviteError('');
    try {
      const res = await api.inviteCollaborator(tripId, email);
      setCollaborators((prev) => [...prev, res.collaborator]);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err.message || 'Invite failed');
    } finally {
      setInviting(false);
    }
  }

  async function handleRemoveCollaborator(userId) {
    if (!window.confirm('Remove this collaborator from the trip?')) return;
    setRemovingId(userId);
    try {
      await api.removeCollaborator(tripId, userId);
      setCollaborators((prev) => prev.filter((c) => c.userId !== userId));
    } catch (err) {
      setInviteError(err.message || 'Remove failed');
    } finally {
      setRemovingId(null);
    }
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 2000);
  }

  async function handleValidate() {
    if (validating) return;

    const stopsWithCoords = stops.filter((s) => s.lat != null && s.lng != null);
    const stopsWithTimes = stops.filter((s) => s.startTime && trip.startDate);
    if (stopsWithCoords.length === 0) {
      setValidateMsg('Add at least one stop with a location before checking the weather.');
      return;
    }
    if (stopsWithTimes.length === 0) {
      setValidateMsg('Set a time on at least one stop — the weather check needs scheduled times to forecast against.');
      return;
    }

    setValidating(true);
    setAlerts([]);
    setFallbacks({});
    setValidateMsg('Triggering weather check…');
    const baseline = lastValidatedAt;

    try {
      const triggerRes = await api.validateTrip(tripId);
      const slotsToCheck = triggerRes && typeof triggerRes.slotsToCheck === 'number'
        ? triggerRes.slotsToCheck
        : stopsWithTimes.length;
      setValidateMsg(`Checking forecast for ${slotsToCheck} ${slotsToCheck === 1 ? 'stop' : 'stops'}…`);

      const refreshFallbacks = async () => {
        try {
          const fbRes = await api.getTripFallbacks(tripId);
          const map = {};
          (fbRes.fallbacks || []).forEach((f) => { map[f.slotId] = f.suggestions || []; });
          setFallbacks(map);
        } catch {}
      };

      for (let attempt = 0; attempt < 14; attempt++) {
        await new Promise((r) => setTimeout(r, 2500));
        const res = await api.getTripAlerts(tripId);
        const updated = res.lastValidatedAt && res.lastValidatedAt !== baseline;
        if (updated) {
          setAlerts(res.alerts || []);
          setLastValidatedAt(res.lastValidatedAt);
          await refreshFallbacks();
          const n = (res.alerts || []).length;
          setValidateMsg(
            n === 0
              ? '✓ Weather looks good — no issues found across your itinerary.'
              : `Found ${n} weather ${n === 1 ? 'alert' : 'alerts'} — see warnings below.`
          );
          return;
        }
      }

      // Final fetch in case the timestamp just changed
      const finalRes = await api.getTripAlerts(tripId);
      if (finalRes.lastValidatedAt && finalRes.lastValidatedAt !== baseline) {
        setAlerts(finalRes.alerts || []);
        setLastValidatedAt(finalRes.lastValidatedAt);
        await refreshFallbacks();
        const n = (finalRes.alerts || []).length;
        setValidateMsg(
          n === 0
            ? '✓ Weather looks good — no issues found across your itinerary.'
            : `Found ${n} weather ${n === 1 ? 'alert' : 'alerts'} — see warnings below.`
        );
        return;
      }

      setValidateMsg(
        'Validation did not complete in time. Common causes: the OpenWeather API key is missing or not subscribed to "One Call API 3.0"; stops are scheduled beyond the 48-hour forecast window; or the backend has not been redeployed with the latest changes. Check CloudWatch logs for the TripWiz-Validate function.'
      );
    } catch (err) {
      setValidateMsg(`Error: ${err.message}`);
    } finally {
      setValidating(false);
    }
  }

  if (loading) return <div className="loading">Loading trip…</div>;
  if (!trip) {
    return (
      <div style={{ padding: '2rem' }}>
        <div className="error-banner">{error || 'Trip not found'}</div>
        <button className="link-btn" onClick={() => navigate('/trips')}>← Back to trips</button>
      </div>
    );
  }

  /* Group + globally number stops (use suggestion if previewing) */
  const isPreview = !!routeSuggestion;
  const displayStops = isPreview ? routeSuggestion.stops : stops;
  const totalDays = getTotalDays(trip, displayStops);
  const dayGroups = {};
  for (let i = 0; i < totalDays; i++) dayGroups[i] = [];
  displayStops.forEach((s) => {
    const d = Math.max(0, s.dayIndex || 0);
    if (!dayGroups[d]) dayGroups[d] = [];
    dayGroups[d].push(s);
  });
  Object.keys(dayGroups).forEach((d) => dayGroups[d].sort(compareStopsInDay));

  const orderedStops = [];
  Object.keys(dayGroups)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((d) => { orderedStops.push(...dayGroups[d]); });

  const globalNum = new Map(orderedStops.map((s, i) => [s.stopId, i + 1]));
  const alertsBySlot = new Map(alerts.map((a) => [a.slotId, a]));

  const safeFilter = activeDayFilter !== 'all' && Number(activeDayFilter) >= totalDays ? 'all' : activeDayFilter;
  const sidebarDays = safeFilter === 'all'
    ? Array.from({ length: totalDays }, (_, i) => i)
    : [Number(safeFilter)];

  const mapDayGroups = sidebarDays.map((dayIdx) => ({
    dayIndex: dayIdx,
    color: DAY_COLORS[dayIdx % DAY_COLORS.length],
    points: (dayGroups[dayIdx] || [])
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({
        lat: s.lat,
        lng: s.lng,
        title: s.name,
        globalNum: globalNum.get(s.stopId),
        startTime: s.startTime,
      })),
  })).filter((g) => g.points.length > 0);

  return (
    <div className="planner-page">

      {/* Header */}
      <header className="planner-header">
        <div className="planner-header-left">
          <button className="link-btn planner-back-btn" onClick={() => navigate('/trips')}>← Trips</button>

          <div className="planner-title-row">
            {editingTitle ? (
              <input
                className="planner-title-input"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveTitle();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                autoFocus
              />
            ) : (
              <>
                <span className="planner-title-text">{trip.title || 'Untitled Trip'}</span>
                {canEdit && (
                  <button className="planner-title-edit-btn" onClick={startEditTitle} title="Edit title">
                    ✏️
                  </button>
                )}
              </>
            )}
            {trip.startDate && (
              <span className="planner-dates">
                {trip.startDate}{trip.endDate ? ` → ${trip.endDate}` : ''}
              </span>
            )}
          </div>

          <div className="planner-save-status">
            {saveStatus === 'saving'  && <><span className="planner-save-dot saving" />Saving…</>}
            {saveStatus === 'saved'   && <><span className="planner-save-dot saved"  />Saved</>}
            {saveStatus === 'unsaved' && <><span className="planner-save-dot unsaved"/>Unsaved</>}
          </div>
        </div>

        <div className="planner-header-right">
          <div className="collab-status">
            <span className={`dot ${wsConnected ? 'green' : 'grey'}`} />
            {wsConnected ? 'Live' : 'Offline'}
          </div>
          <button className="planner-share-btn" onClick={openShareModal}>🔗 Share</button>
        </div>
      </header>

      {error && (
        <div className="error-banner planner-banner">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
      {validateMsg && (
        <div className="info-banner planner-banner">
          {validateMsg}
          <button onClick={() => setValidateMsg('')} style={{ background: 'none', color: 'inherit', padding: '0 0.25rem' }}>×</button>
        </div>
      )}

      {/* Body */}
      <div className="planner-body">

        {/* Left panel */}
        <div className="planner-left">
          {canEdit && (
            <div className="planner-add-section">
              <LocationAutocomplete onSelect={handleLocationSelect} />
            </div>
          )}

          {/* Day filter tabs */}
          {totalDays > 0 && (
            <div className="day-tabs">
              <button
                className={`day-tab ${safeFilter === 'all' ? 'day-tab--active' : ''}`}
                onClick={() => setActiveDayFilter('all')}
              >
                All Days
              </button>
              {Array.from({ length: totalDays }, (_, i) => (
                <button
                  key={i}
                  className={`day-tab ${safeFilter === i ? 'day-tab--active' : ''}`}
                  style={safeFilter === i
                    ? { background: DAY_COLORS[i % DAY_COLORS.length], borderColor: DAY_COLORS[i % DAY_COLORS.length] }
                    : {}}
                  onClick={() => setActiveDayFilter(i)}
                >
                  <span className="day-tab-dot" style={{ background: DAY_COLORS[i % DAY_COLORS.length] }} />
                  Day {i + 1}
                </button>
              ))}
            </div>
          )}

          {(alerts.length > 0 || lastValidatedAt) && !isPreview && (
            <div className={`alerts-summary ${alerts.length > 0 ? 'alerts-summary--warn' : 'alerts-summary--ok'}`}>
              <div className="alerts-summary-icon">{alerts.length > 0 ? '⚠️' : '✓'}</div>
              <div className="alerts-summary-text">
                <div className="alerts-summary-title">
                  {alerts.length > 0
                    ? `${alerts.length} weather ${alerts.length === 1 ? 'alert' : 'alerts'}`
                    : 'Weather looks good'}
                </div>
                {lastValidatedAt && (
                  <div className="alerts-summary-meta">
                    Checked {new Date(lastValidatedAt).toLocaleString([], {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {isPreview && (
            <div className="route-suggestion-banner">
              <div className="route-suggestion-icon">🤖</div>
              <div className="route-suggestion-text">
                <div className="route-suggestion-title">
                  Claude suggests this route
                </div>
                {routeSuggestion.reasoning && (
                  <div className="route-suggestion-reasoning">
                    "{routeSuggestion.reasoning}"
                  </div>
                )}
                <div className="route-suggestion-summary">
                  {routeSuggestion.savings > 0.02 && (
                    <>~{(routeSuggestion.savings * 100).toFixed(0)}% shorter travel · </>
                  )}
                  {routeSuggestion.orderChanged && routeSuggestion.timesChanged
                    ? 'Stops reordered and times reassigned'
                    : routeSuggestion.orderChanged
                      ? 'Stops reordered'
                      : 'Times reassigned'}
                </div>
              </div>
              <div className="route-suggestion-actions">
                <button className="route-suggestion-apply" onClick={applyRouteSuggestion}>
                  Apply
                </button>
                <button className="route-suggestion-cancel" onClick={dismissRouteSuggestion}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className={`planner-stops ${isPreview ? 'planner-stops--preview' : ''}`}>
            {stops.length === 0 ? (
              <div className="planner-empty">
                <span style={{ fontSize: '2.5rem' }}>🗺️</span>
                <p>Search above to add your first destination.</p>
              </div>
            ) : (
              sidebarDays.map((dayIdx) => {
                const dayStops = dayGroups[dayIdx] || [];
                const dayColor = DAY_COLORS[dayIdx % DAY_COLORS.length];
                return (
                  <div key={dayIdx} className="day-group">
                    <div className="day-header">
                      <span className="day-label">
                        <span className="day-color-pill" style={{ background: dayColor }} />
                        {formatDayLabel(trip.startDate, dayIdx)}
                      </span>
                      <span className="day-count">
                        {dayStops.length} {dayStops.length === 1 ? 'stop' : 'stops'}
                      </span>
                    </div>
                    {dayStops.length === 0 ? (
                      <div className="day-empty">No stops planned</div>
                    ) : (
                      <div className="day-stops">
                        {dayStops.map((stop) => (
                          <StopCard
                            key={stop.stopId}
                            stop={stop}
                            globalNum={globalNum.get(stop.stopId)}
                            totalDays={totalDays}
                            canEdit={canEdit && !isPreview}
                            alert={isPreview ? null : alertsBySlot.get(stop.stopId)}
                            suggestions={isPreview ? null : fallbacks[stop.stopId]}
                            onRemove={() => removeStop(stop.stopId)}
                            onChangeDay={(d) => updateStop(stop.stopId, { dayIndex: d })}
                            onChangeTime={(t) => updateStop(stop.stopId, { startTime: t })}
                            onReplace={(s) => replaceStop(stop.stopId, s)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {stops.length > 1 && canEdit && !isPreview && (
            <button
              className="planner-optimize-btn"
              onClick={handleOptimize}
              disabled={optimizing}
            >
              {optimizing ? '🤖 Claude is thinking…' : '🤖 Optimize with Claude'}
            </button>
          )}
          {!isPreview && (
            <button
              className="planner-weather-btn secondary-btn"
              onClick={handleValidate}
              disabled={validating}
            >
              {validating ? '⏳ Checking weather…' : '🌦️ Check Weather'}
            </button>
          )}
        </div>

        {/* Right panel: map */}
        <div className="planner-right">
          <TripMap dayGroups={mapDayGroups} />
        </div>
      </div>

      {/* Add stop modal */}
      {pendingLocation && (
        <div className="add-stop-backdrop" onClick={() => setPendingLocation(null)}>
          <div className="add-stop-modal" onClick={(e) => e.stopPropagation()}>
            <div className="add-stop-place">
              <span className="add-stop-pin">📍</span>
              <div className="add-stop-place-info">
                <div className="add-stop-place-name">{pendingLocation.name}</div>
                <div className="add-stop-place-duration">~{pendingLocation.recommendedHours} hrs estimated</div>
              </div>
              <button className="add-stop-close" onClick={() => setPendingLocation(null)}>×</button>
            </div>

            <div className="add-stop-fields">
              <label className="add-stop-field">
                <span className="add-stop-field-label">Day</span>
                <select
                  className="add-stop-select"
                  value={pendingDay}
                  onChange={(e) => setPendingDay(parseInt(e.target.value, 10))}
                >
                  {Array.from({ length: Math.max(totalDays, 1) }, (_, i) => (
                    <option key={i} value={i}>{formatDayLabel(trip?.startDate, i)}</option>
                  ))}
                </select>
              </label>

              <label className="add-stop-field">
                <span className="add-stop-field-label">
                  Time <span className="add-stop-optional">optional</span>
                </span>
                <input
                  className="add-stop-time"
                  type="time"
                  value={pendingTime}
                  onChange={(e) => setPendingTime(e.target.value)}
                />
              </label>
            </div>

            <div className="add-stop-actions">
              <button className="add-stop-cancel" onClick={() => setPendingLocation(null)}>
                Cancel
              </button>
              <button
                className="add-stop-confirm"
                style={{ background: DAY_COLORS[pendingDay % DAY_COLORS.length] }}
                onClick={confirmAddStop}
              >
                Add to Day {pendingDay + 1}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Share modal */}
      {showShareModal && (
        <div className="share-modal-backdrop" onClick={closeShareModal}>
          <div className="share-modal" onClick={(e) => e.stopPropagation()}>
            <div className="share-modal-header">
              <h2>Share "{trip.title || 'this trip'}"</h2>
              <button className="share-modal-close" onClick={closeShareModal}>×</button>
            </div>

            {callerIsOwner && (
              <div className="share-section">
                <div className="share-section-label">Invite by email</div>
                <form className="share-invite-form" onSubmit={handleInvite}>
                  <input
                    type="email"
                    placeholder="name@example.com"
                    value={inviteEmail}
                    onChange={(e) => { setInviteEmail(e.target.value); setInviteError(''); }}
                    disabled={inviting}
                    required
                  />
                  <button type="submit" disabled={inviting || !inviteEmail.trim()}>
                    {inviting ? 'Inviting…' : 'Invite'}
                  </button>
                </form>
                {inviteError && <div className="share-error">{inviteError}</div>}
                <div className="share-hint">User must already have a TripWiz account.</div>
              </div>
            )}

            <div className="share-section">
              <div className="share-section-label">
                People with access ({1 + collaborators.length})
              </div>
              <div className="share-people">
                <div className="share-person">
                  <div className="share-person-avatar share-person-avatar--owner">★</div>
                  <div className="share-person-info">
                    <div className="share-person-name">
                      {callerIsOwner ? 'You' : 'Trip owner'}
                    </div>
                    <div className="share-person-role">Owner</div>
                  </div>
                </div>
                {collaborators.map((c) => (
                  <div key={c.userId} className="share-person">
                    <div className="share-person-avatar">
                      {(c.email || '?').slice(0, 1).toUpperCase()}
                    </div>
                    <div className="share-person-info">
                      <div className="share-person-name">{c.email || c.userId}</div>
                      <div className="share-person-role">
                        {c.role === 'editor' ? 'Editor' : c.role || 'Editor'}
                      </div>
                    </div>
                    {callerIsOwner && (
                      <button
                        className="share-remove-btn"
                        onClick={() => handleRemoveCollaborator(c.userId)}
                        disabled={removingId === c.userId}
                        title="Remove collaborator"
                      >
                        {removingId === c.userId ? '…' : '×'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="share-section">
              <div className="share-section-label">Or share link</div>
              <div className="share-link-row">
                <input className="share-link-input" type="text" readOnly value={window.location.href} />
                <button className="share-copy-btn" onClick={handleCopyLink}>
                  {copyToast ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="share-hint">
                Anyone with the link still needs an invite to view or edit.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
