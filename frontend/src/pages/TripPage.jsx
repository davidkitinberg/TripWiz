import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { connect, disconnect, on } from '../services/websocket';
import TripMap from '../components/TripMap';
import { ArrowLeft, Pencil, Share2, Bot, CloudSun, MapPin } from 'lucide-react';

/* ─────────────── Helpers ─────────────── */

function useDebounce(value, delay) {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return dv;
}

// [Feature #21] Per-stop duration estimation from the place's category
function estimateHours(categories = []) {
  const cats = categories.map((c) => c.toLowerCase());
  if (cats.some((c) => c.includes('airport') || c.includes('terminal'))) return '2–3';
  if (cats.some((c) => c.includes('hotel') || c.includes('lodging') || c.includes('accommodation'))) return '0';
  if (cats.some((c) => c.includes('museum') || c.includes('gallery'))) return '2–3';
  if (cats.some((c) => c.includes('theme park') || c.includes('amusement'))) return '4–6';
  if (cats.some((c) => c.includes('zoo') || c.includes('aquarium'))) return '3–4';
  if (cats.some((c) => c.includes('beach'))) return '2–4';
  if (cats.some((c) => c.includes('park') || c.includes('garden') || c.includes('nature'))) return '1–3';
  if (cats.some((c) => c.includes('restaurant') || c.includes('food') || c.includes('cafe') || c.includes('bar'))) return '1–2';
  if (cats.some((c) => c.includes('shop') || c.includes('market') || c.includes('store'))) return '0.5–1';
  if (cats.some((c) => c.includes('attraction') || c.includes('landmark') || c.includes('historic'))) return '1–2';
  if (cats.some((c) => c.includes('viewpoint') || c.includes('scenic'))) return '0.5–1';
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

const ACTIVITY_TYPE_OPTIONS = [
  { value: 'AUTO', label: 'Auto detect' },
  { value: 'GENERAL_OUTDOOR', label: 'General outdoor' },
  { value: 'INDOOR', label: 'Indoor' },
  { value: 'BEACH', label: 'Beach' },
  { value: 'SKI', label: 'Ski' },
  { value: 'SCENIC_VIEW', label: 'Scenic / viewpoint' },
];

const DURATION_OPTIONS = [
  { value: '', label: 'Select duration' },
  { value: '30 min', label: '30 min' },
  { value: '1 hour', label: '1 hour' },
  { value: '1.5 hours', label: '1.5 hours' },
  { value: '2 hours', label: '2 hours' },
  { value: '2.5 hours', label: '2.5 hours' },
  { value: '3 hours', label: '3 hours' },
  { value: '4 hours', label: '4 hours' },
  { value: '5 hours', label: '5 hours' },
  { value: 'Full day', label: 'Full day' },
  { value: 'CUSTOM', label: 'Custom' },
];

const PRESET_DURATION_VALUES = new Set(DURATION_OPTIONS.map((option) => option.value));

function getDurationSelectValue(duration) {
  if (!duration) return '';
  return PRESET_DURATION_VALUES.has(duration) ? duration : 'CUSTOM';
}

function formatDurationForDisplay(duration) {
  if (!duration) return '';
  if (/hour|min|day/i.test(duration)) return duration;
  return `${duration} hrs`;
}

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
    const activityType = s.activityType && s.activityType !== 'AUTO' ? s.activityType : undefined;
    const duration = s.recommendedHours || '';
    return {
      slotId: s.stopId,
      title: s.name,
      coords: s.lat != null ? { lat: s.lat, lng: s.lng } : undefined,
      notes: duration,
      duration,
      dayIndex: s.dayIndex || 0,
      start,
      end: '',
      ...(activityType ? { activityType } : {}),
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
      recommendedHours: item.duration || item.notes || '',
      dayIndex,
      startTime,
      activityType: item.activityType || 'AUTO',
    };
  });
}

/* ─────────────── Autocomplete ─────────────── */

function isHebrewText(text) {
  return /[֐-׿יִ-ﭏ]/.test(text);
}

function placeIcon(cls, type) {
  const t = (type || '').toLowerCase();
  const c = (cls || '').toLowerCase();
  if (t === 'museum' || t === 'gallery' || t === 'arts_centre') return '🏛️';
  if (t === 'hotel' || t === 'hostel' || t === 'guest_house' || t === 'motel') return '🏨';
  if (t === 'restaurant' || t === 'fast_food' || t === 'food_court') return '🍽️';
  if (t === 'cafe' || t === 'coffee_shop') return '☕';
  if (t === 'bar' || t === 'pub' || t === 'nightclub') return '🍺';
  if (t === 'beach') return '🏖️';
  if (t === 'theme_park' || t === 'amusement_park') return '🎡';
  if (t === 'zoo') return '🦁';
  if (t === 'aquarium') return '🐠';
  if (t === 'aerodrome') return '✈️';
  if (t === 'viewpoint') return '🔭';
  if (t === 'monument' || t === 'memorial') return '🗿';
  if (t === 'castle' || t === 'ruins' || t === 'fort') return '🏰';
  if (t === 'park' || t === 'garden' || t === 'nature_reserve') return '🌿';
  if (c === 'shop') return '🛍️';
  if (c === 'historic') return '🏛️';
  if (c === 'natural') return '🌲';
  if (c === 'tourism' || t === 'attraction') return '🎯';
  if (c === 'place') return '🏙️';
  return '📍';
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  const c = code.toUpperCase();
  try {
    return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65);
  } catch { return ''; }
}

function nominatimToCategories(cls, type) {
  const t = (type || '').toLowerCase();
  const c = (cls || '').toLowerCase();
  const cats = [];
  if (t === 'museum' || t === 'gallery') cats.push('museum');
  if (t === 'hotel' || t === 'hostel' || t === 'guest_house') cats.push('hotel');
  if (t === 'restaurant' || t === 'fast_food' || t === 'cafe') cats.push('restaurant');
  if (t === 'bar' || t === 'pub') cats.push('bar');
  if (t === 'beach') cats.push('beach');
  if (t === 'park' || t === 'garden') cats.push('park');
  if (c === 'natural') cats.push('nature');
  if (t === 'theme_park' || t === 'amusement_park') cats.push('theme park');
  if (t === 'zoo') cats.push('zoo');
  if (t === 'aquarium') cats.push('aquarium');
  if (t === 'aerodrome') cats.push('airport');
  if (t === 'viewpoint') cats.push('viewpoint');
  if (c === 'shop') cats.push('shop');
  if (c === 'historic') cats.push('historic');
  if (c === 'tourism' || t === 'attraction') cats.push('attraction');
  return cats;
}

function parseNominatimResult(r, hebrewQuery) {
  const addr = r.address || {};
  const nd = r.namedetails || {};
  const name = (hebrewQuery && nd['name:he'])
    ? nd['name:he']
    : (r.name || r.display_name.split(',')[0].trim());
  const city = addr.city || addr.town || addr.village || addr.municipality || addr.county;
  const country = addr.country;
  const parts = [];
  if (city && city !== name) parts.push(city);
  if (country && country !== name) parts.push(country);
  return {
    name,
    subtitle: parts.join(', '),
    flag: countryFlag(addr.country_code || ''),
    icon: placeIcon(r.class, r.type),
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    categories: nominatimToCategories(r.class, r.type),
  };
}

// [Feature #15] Place autocomplete search (OpenStreetMap / Nominatim, Hebrew-aware)
async function searchNominatim(query) {
  const hebrew = isHebrewText(query);
  const lang = hebrew ? 'he,en' : 'en';
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    namedetails: '1',
    limit: '7',
    dedupe: '1',
    'accept-language': lang,
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error('Nominatim error');
  const data = await res.json();
  return data.map((r) => parseNominatimResult(r, hebrew));
}

function LocationAutocomplete({ onSelect }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef(null);
  const debouncedQuery = useDebounce(query, 420);
  const isHebrew = isHebrewText(query);

  useEffect(() => {
    if (debouncedQuery.length < 2) { setSuggestions([]); setOpen(false); return; }
    setLoading(true);
    searchNominatim(debouncedQuery)
      .then((results) => {
        setSuggestions(results);
        setOpen(results.length > 0);
        setActiveIdx(-1);
      })
      .catch(() => setSuggestions([]))
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
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      recommendedHours: estimateHours(s.categories),
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
          dir={isHebrew ? 'rtl' : 'ltr'}
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
              <span className="autocomplete-pin">{s.icon}</span>
              <span className="autocomplete-texts">
                <span className={`autocomplete-label${isHebrew ? ' autocomplete-label--rtl' : ''}`}>{s.name}</span>
                <span className="autocomplete-full">{s.subtitle}{s.flag ? ` ${s.flag}` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────────── Stop card ─────────────── */

function weatherIcon(condition) {
  const c = (condition || '').toLowerCase();
  if (c.includes('thunder')) return '⛈️';
  if (c.includes('rain') || c.includes('drizzle')) return '🌧️';
  if (c.includes('snow')) return '❄️';
  if (c.includes('mist') || c.includes('fog') || c.includes('haze')) return '🌫️';
  if (c.includes('cloud')) return '⛅';
  if (c.includes('clear')) return '☀️';
  return '🌤️';
}

// [Feature #17] Stop card with day/time edit + remove controls
// [Feature #23] Shows per-stop weather badge and any weather warning
// [Feature #24] Lists nearby indoor fallback suggestions with one-click Replace
function StopCard({ stop, globalNum, totalDays, canEdit, alert, suggestions, weather, onRemove, onEdit, onChangeDay, onChangeTime, onReplace }) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const hasSuggestions = alert && suggestions && suggestions.length > 0;
  const durationLabel = formatDurationForDisplay(stop.recommendedHours);

  return (
    <div className={`stop-card ${alert ? 'stop-card--alert' : ''}`}>
      <div className="stop-num">{globalNum}</div>
      <div className="stop-info">
        <div className="stop-name">
          {stop.name}
          {alert && <span className="stop-alert-badge" title={alert.reason}>⚠️</span>}
        </div>
        <div className="stop-meta-row">
          {durationLabel && <span className="stop-duration">🕒 {durationLabel}</span>}
          {weather && (
            <span className={`stop-weather-badge${weather.isAlert ? ' stop-weather-badge--alert' : ''}`}
              title={weather.description || weather.condition}>
              {weatherIcon(weather.condition)} {weather.tempC}°C
            </span>
          )}
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
        <div className="stop-card-actions">
          <button className="stop-edit-btn" onClick={onEdit} title="Edit stop details" aria-label="Edit stop details">
            <Pencil size={13} strokeWidth={2} />
          </button>
          <button className="stop-remove-btn" onClick={onRemove} title="Remove">×</button>
        </div>
      )}
    </div>
  );
}

/* ─────────────── AI Suggestion Panel ─────────────── */

// [Feature #20] AI route suggestion preview panel (reasoning, day-by-day, savings)
function AiSuggestionPanel({ suggestion, onApply, onDismiss }) {
  if (!suggestion) return null;

  const daySet = [...new Set(suggestion.stops.map((s) => s.dayIndex ?? 0))].sort((a, b) => a - b);
  const summaryByDay = new Map((suggestion.dailySummary || []).map((d) => [d.dayIndex, d]));

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <div className="ai-panel-header-left">
          <span className="ai-panel-robot"><Bot size={24} strokeWidth={1.8} /></span>
          <div>
            <div className="ai-panel-title">AI Route Suggestion</div>
            <div className="ai-panel-model">{suggestion.model || 'Claude Haiku'}</div>
          </div>
        </div>
        <button className="ai-panel-close" onClick={onDismiss} title="Dismiss">×</button>
      </div>

      <div className="ai-panel-body">

        {/* Stats chips */}
        <div className="ai-panel-section">
          <div className="ai-panel-section-label">📊 Summary</div>
          <div className="ai-panel-chips">
            {suggestion.savings > 0.02 && (
              <span className="ai-chip ai-chip--green">
                ⚡ ~{(suggestion.savings * 100).toFixed(0)}% less travel
              </span>
            )}
            {suggestion.orderChanged && (
              <span className="ai-chip ai-chip--blue">🔀 Order optimized</span>
            )}
            {suggestion.timesChanged && (
              <span className="ai-chip ai-chip--purple">⏰ Times adjusted</span>
            )}
            {!suggestion.orderChanged && !suggestion.timesChanged && (
              <span className="ai-chip ai-chip--gray">✓ Already optimal</span>
            )}
          </div>
        </div>

        {/* Overall reasoning */}
        {suggestion.reasoning && (
          <div className="ai-panel-section">
            <div className="ai-panel-section-label">💡 Overall Strategy</div>
            <div className="ai-panel-reasoning">{suggestion.reasoning}</div>
          </div>
        )}

        {/* Day-by-day breakdown: heading + description + stop list per day */}
        <div className="ai-panel-section">
          <div className="ai-panel-section-label">📅 Day-by-Day Plan</div>
          <div className="ai-stop-list">
            {daySet.map((dayIdx) => {
              const dayStops = suggestion.stops.filter((s) => (s.dayIndex ?? 0) === dayIdx);
              const daySummary = summaryByDay.get(dayIdx);
              return (
                <div key={dayIdx} className="ai-day-group">
                  <div className="ai-day-heading">
                    {daySummary ? daySummary.heading : `Day ${dayIdx + 1}`}
                  </div>
                  {daySummary && (
                    <div className="ai-day-description">{daySummary.description}</div>
                  )}
                  <div className="ai-day-stops">
                    {dayStops.map((s, i) => (
                      <div key={s.stopId} className="ai-stop-row">
                        <span className="ai-stop-num">{i + 1}</span>
                        <div className="ai-stop-info">
                          <span className="ai-stop-name">{s.name}</span>
                          {s.startTime && <span className="ai-stop-time">{s.startTime}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      <div className="ai-panel-footer">
        <button className="ai-panel-btn ai-panel-btn--dismiss" onClick={onDismiss}>Dismiss</button>
        <button className="ai-panel-btn ai-panel-btn--apply" onClick={onApply}>Apply suggestion →</button>
      </div>
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
  const [stopWeather, setStopWeather] = useState({});
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
  const [dayRoutes, setDayRoutes] = useState({});
  const [pendingLocation, setPendingLocation] = useState(null);
  const [pendingDay, setPendingDay] = useState(0);
  const [pendingTime, setPendingTime] = useState('');
  const [pendingActivityType, setPendingActivityType] = useState('AUTO');
  const [pendingDuration, setPendingDuration] = useState('');
  const [pendingCustomDuration, setPendingCustomDuration] = useState('');
  const [editingStopId, setEditingStopId] = useState(null);

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

    api.getTripWeather(tripId)
      .then((res) => {
        const map = {};
        (res.weather || []).forEach((w) => { map[w.slotId] = w; });
        setStopWeather(map);
      })
      .catch(() => {});
  }, [tripId]);

  // [Feature #29] Live co-editing: receive broadcast edits from other collaborators
  // [Feature #30] Track WebSocket connect/disconnect for the Live/Offline indicator
  useEffect(() => {
    const offConnected = on('connected', () => setWsConnected(true));
    const offDisconnected = on('disconnected', () => setWsConnected(false));
    const offEdit = on('edit', (msg) => {
      if (msg.payload?.accepted && msg.payload?.trip) {
        const incoming = msg.payload.trip;
        // Skip if this is an echo of our own save — our version is already up to date
        if (incoming.version <= versionRef.current) return;
        setTrip(incoming);
        setStops(itineraryToStops(incoming.itinerary, incoming.startDate));
        versionRef.current = incoming.version;
      }
    });
    connect(tripId).catch(console.warn);
    return () => { offConnected(); offDisconnected(); offEdit(); disconnect(); };
  }, [tripId]);

  // [Feature #19] Recompute real road-route geometry (Amazon Location) when stops settle
  const debouncedStops = useDebounce(stops, 1500);
  useEffect(() => {
    const geoStops = debouncedStops.filter((s) => s.lat != null && s.lng != null);
    if (geoStops.length < 2) { setDayRoutes({}); return; }
    api.calculateRoute(geoStops.map((s) => ({ lat: s.lat, lng: s.lng, dayIndex: s.dayIndex ?? 0 })))
      .then((res) => {
        const map = {};
        for (const d of res.days || []) map[d.dayIndex] = d.positions;
        setDayRoutes(map);
      })
      .catch(() => {}); // silently fall back to straight lines
  }, [debouncedStops]);

  const canEdit = access === 'owner' || access === 'editor';

  // [Feature #18] Auto-save the itinerary with optimistic version control (409 on conflict)
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
    setPendingActivityType('AUTO');
    setPendingDuration('');
    setPendingCustomDuration('');
    setEditingStopId(null);
    setPendingLocation(location);
  }

  function closeStopModal() {
    setPendingLocation(null);
    setEditingStopId(null);
    setPendingActivityType('AUTO');
    setPendingDuration('');
    setPendingCustomDuration('');
  }

  function getPendingDurationValue() {
    return pendingDuration === 'CUSTOM' ? pendingCustomDuration.trim() : pendingDuration;
  }

  function openEditStop(stop) {
    const duration = stop.recommendedHours || '';
    setEditingStopId(stop.stopId);
    setPendingLocation({
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng,
      recommendedHours: duration,
    });
    setPendingDay(stop.dayIndex || 0);
    setPendingTime(stop.startTime || '');
    setPendingActivityType(stop.activityType || 'AUTO');
    setPendingDuration(getDurationSelectValue(duration));
    setPendingCustomDuration(getDurationSelectValue(duration) === 'CUSTOM' ? duration : '');
  }

  // [Feature #15] Add or edit the chosen place on the selected day/time
  function confirmAddStop() {
    if (!pendingLocation) return;
    const duration = getPendingDurationValue();

    if (editingStopId) {
      updateStop(editingStopId, {
        dayIndex: pendingDay,
        startTime: pendingTime,
        activityType: pendingActivityType,
        recommendedHours: duration,
      });
      closeStopModal();
      return;
    }

    const newStop = {
      stopId: `s-${Date.now()}`,
      name: pendingLocation.name,
      lat: pendingLocation.lat,
      lng: pendingLocation.lng,
      recommendedHours: duration,
      dayIndex: pendingDay,
      startTime: pendingTime,
      activityType: pendingActivityType,
    };
    setStops((prev) => {
      const next = [...prev, newStop];
      scheduleSave(next);
      return next;
    });
    closeStopModal();
  }

  function addStop(location) {
    const newStop = {
      stopId: `s-${Date.now()}`,
      name: location.name,
      lat: location.lat,
      lng: location.lng,
      recommendedHours: '',
      dayIndex: 0,
      startTime: '',
    };
    setStops((prev) => {
      const next = [...prev, newStop];
      scheduleSave(next);
      return next;
    });
  }

  // [Feature #17] Remove a stop from the itinerary
  function removeStop(stopId) {
    setStops((prev) => {
      const next = prev.filter((s) => s.stopId !== stopId);
      scheduleSave(next);
      return next;
    });
  }

  // [Feature #17] Update a stop's day/time (re-sorts and re-numbers the itinerary)
  function updateStop(stopId, updates) {
    setStops((prev) => {
      const next = prev.map((s) => (s.stopId === stopId ? { ...s, ...updates } : s));
      scheduleSave(next);
      return next;
    });
  }

  // [Feature #24] Replace a weather-flagged stop with a suggested indoor alternative
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

  /* [Feature #20] Optimize via Amazon Bedrock (Claude Haiku 4.5). The backend returns a
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
        dailySummary: result.dailySummary || [],
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

  // [Feature #20] Apply the AI suggestion to the itinerary and save immediately
  async function applyRouteSuggestion() {
    if (!routeSuggestion) return;
    const appliedStops = routeSuggestion.stops;
    // Update UI immediately, close the panel, cancel any pending debounce timer
    setStops(appliedStops);
    setRouteSuggestion(null);
    clearTimeout(saveTimerRef.current);
    // Save directly — no debounce so nothing can cancel this
    setSaveStatus('saving');
    try {
      const tripStartDate = tripRef.current?.startDate;
      const patch = {
        itinerary: stopsToItinerary(appliedStops, tripStartDate),
        version: versionRef.current,
      };
      const res = await api.updateTrip(tripId, patch);
      setTrip(res.trip);
      versionRef.current = res.trip.version;
      setSaveStatus('saved');
      setValidateMsg('✓ AI suggestion applied and saved.');
    } catch (err) {
      setSaveStatus('unsaved');
      setError(err.code === 'VERSION_CONFLICT'
        ? 'Version conflict — someone else edited this trip. Refresh to get the latest.'
        : `Apply failed: ${err.message}`);
    }
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

  // [Feature #27] Open the Share modal and load the trip's collaborators
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

  // [Feature #26] Invite a collaborator by email (grants editor access)
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

  // [Feature #27] Remove a collaborator from the trip
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

  // [Feature #28] Copy the shareable trip link (link openers get viewer access)
  function handleCopyLink() {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 2000);
  }

  // [Feature #22] Trigger the weather check (async validate Lambda) and poll for results
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
    setStopWeather({});
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

      const refreshWeather = async () => {
        try {
          const wRes = await api.getTripWeather(tripId);
          const map = {};
          (wRes.weather || []).forEach((w) => { map[w.slotId] = w; });
          setStopWeather(map);
        } catch {}
      };

      for (let attempt = 0; attempt < 14; attempt++) {
        await new Promise((r) => setTimeout(r, 2500));
        const res = await api.getTripAlerts(tripId);
        const updated = res.lastValidatedAt && res.lastValidatedAt !== baseline;
        if (updated) {
          setAlerts(res.alerts || []);
          setLastValidatedAt(res.lastValidatedAt);
          await Promise.all([refreshFallbacks(), refreshWeather()]);
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
        await Promise.all([refreshFallbacks(), refreshWeather()]);
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

  /* [Feature #16] Group + globally number stops by day — always use original stops so sidebar is never overridden */
  const totalDays = getTotalDays(trip, stops);
  const dayGroups = {};
  for (let i = 0; i < totalDays; i++) dayGroups[i] = [];
  stops.forEach((s) => {
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
    routePositions: dayRoutes[dayIdx] || null,
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

      {/* Aurora background */}
      <div className="planner-bg" aria-hidden="true">
        <div className="aurora-orb aurora-orb--1" />
        <div className="aurora-orb aurora-orb--2" />
        <div className="aurora-orb aurora-orb--3" />
        <div className="aurora-orb aurora-orb--4" />
      </div>

      {/* Header */}
      <header className="planner-header">
        <div className="planner-header-left">
          <button className="link-btn planner-back-btn" onClick={() => navigate('/trips')}>
            <ArrowLeft size={14} strokeWidth={2.5} /> Trips
          </button>

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
                    <Pencil size={13} strokeWidth={2.2} />
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
          <button className="planner-share-btn" onClick={openShareModal}>
            <Share2 size={14} strokeWidth={2.2} /> Share
          </button>
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

          {(alerts.length > 0 || lastValidatedAt) && (
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

          <div className="planner-stops">
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
                            canEdit={canEdit}
                            alert={alertsBySlot.get(stop.stopId)}
                            suggestions={fallbacks[stop.stopId]}
                            weather={stopWeather[stop.stopId]}
                            onRemove={() => removeStop(stop.stopId)}
                            onEdit={() => openEditStop(stop)}
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

          {stops.length > 1 && canEdit && (
            <button
              className="planner-optimize-btn"
              onClick={handleOptimize}
              disabled={optimizing}
            >
              <Bot size={15} strokeWidth={2} />
              {optimizing ? 'Claude is thinking…' : 'Optimize with Claude'}
            </button>
          )}
          <button
            className="planner-weather-btn secondary-btn"
            onClick={handleValidate}
            disabled={validating}
          >
            <CloudSun size={15} strokeWidth={2} />
            {validating ? 'Checking weather…' : 'Check Weather'}
          </button>
        </div>

        {/* AI suggestion slide-in panel */}
        <AiSuggestionPanel
          suggestion={routeSuggestion}
          onApply={applyRouteSuggestion}
          onDismiss={dismissRouteSuggestion}
        />

        {/* Right panel: map */}
        <div className="planner-right">
          <TripMap dayGroups={mapDayGroups} />
        </div>
      </div>

      {/* Add stop modal */}
      {pendingLocation && (
        <div className="add-stop-backdrop" onClick={closeStopModal}>
          <div className="add-stop-modal" onClick={(e) => e.stopPropagation()}>
            <div className="add-stop-place">
              <span className="add-stop-pin"><MapPin size={20} strokeWidth={2} color="#a5b4fc" /></span>
              <div className="add-stop-place-info">
                <div className="add-stop-place-name">{pendingLocation.name}</div>
                {pendingLocation.recommendedHours && (
                  <div className="add-stop-place-duration">~{formatDurationForDisplay(pendingLocation.recommendedHours)} estimated</div>
                )}
              </div>
              <button className="add-stop-close" onClick={closeStopModal}>×</button>
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

              <label className="add-stop-field">
                <span className="add-stop-field-label">Activity type</span>
                <select
                  className="add-stop-select"
                  value={pendingActivityType}
                  onChange={(e) => setPendingActivityType(e.target.value)}
                >
                  {ACTIVITY_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="add-stop-field">
                <span className="add-stop-field-label">Duration</span>
                <select
                  className="add-stop-select"
                  value={pendingDuration}
                  onChange={(e) => {
                    setPendingDuration(e.target.value);
                    if (e.target.value !== 'CUSTOM') setPendingCustomDuration('');
                  }}
                >
                  {DURATION_OPTIONS.map((option) => (
                    <option key={option.value || 'none'} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              {pendingDuration === 'CUSTOM' && (
                <label className="add-stop-field">
                  <span className="add-stop-field-label">Custom duration</span>
                  <input
                    className="add-stop-time"
                    type="text"
                    value={pendingCustomDuration}
                    onChange={(e) => setPendingCustomDuration(e.target.value)}
                    placeholder="e.g. 45 min"
                  />
                </label>
              )}
            </div>

            <div className="add-stop-actions">
              <button className="add-stop-cancel" onClick={closeStopModal}>
                Cancel
              </button>
              <button
                className="add-stop-confirm"
                style={{ background: DAY_COLORS[pendingDay % DAY_COLORS.length] }}
                onClick={confirmAddStop}
              >
                {editingStopId ? 'Save changes' : `Add to Day ${pendingDay + 1}`}
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
