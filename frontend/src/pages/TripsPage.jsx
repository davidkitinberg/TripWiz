import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { signOut, getIdToken } from '../services/auth';

/* ─── Constants ─────────────────────────────────────────── */

const CARD_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #667eea 100%)',
  'linear-gradient(135deg, #f7971e 0%, #ffd200 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
];

const INSPIRATION = [
  { city: 'Tokyo',     country: 'Japan',  tag: 'Culture & Food',    emoji: '🗾' },
  { city: 'New York',  country: 'USA',    tag: 'City Break',        emoji: '🗽' },
  { city: 'Santorini', country: 'Greece', tag: 'Beach & Sun',       emoji: '🏖️' },
  { city: 'Kyoto',     country: 'Japan',  tag: 'History & Nature',  emoji: '⛩️' },
];

/* ─── Helpers ────────────────────────────────────────────── */

function hashGradient(str) {
  const idx = (str || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % CARD_GRADIENTS.length;
  return CARD_GRADIENTS[idx];
}

function getInitials(title) {
  if (!title) return '?';
  return title.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function getTripStatus(trip) {
  if (!trip.startDate) return { label: 'Draft', type: 'draft' };
  const now = new Date();
  const start = new Date(trip.startDate);
  const end = trip.endDate ? new Date(trip.endDate) : new Date(trip.startDate);
  end.setHours(23, 59, 59, 999);
  if (now < start) return { label: 'Upcoming', type: 'upcoming' };
  if (now > end) return { label: 'Past', type: 'past' };
  return { label: '● Active', type: 'active' };
}

function formatDateRange(start, end) {
  if (!start) return 'Dates not set';
  const fmt = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return end ? `${fmt(start)} – ${fmt(end)}` : `From ${fmt(start)}`;
}

/* ─── Trip Card ──────────────────────────────────────────── */

function TripCard({ trip, onView, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const status = getTripStatus(trip);
  const gradient = hashGradient(trip.title);
  const initials = getInitials(trip.title);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="tc" onClick={onView}>
      <div className="tc-banner" style={{ background: gradient }}>
        <div className="tc-initials">{initials}</div>
        <span className={`tc-status tc-status--${status.type}`}>{status.label}</span>
        <div className="tc-menu-wrap" ref={menuRef}>
          <button
            className="tc-menu-btn"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            title="More options"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="tc-menu-dropdown">
              <button
                className="tc-menu-item tc-menu-item--danger"
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(trip.tripId); }}
              >
                🗑 Delete trip
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="tc-body">
        <div className="tc-title">{trip.title || 'Untitled Trip'}</div>
        <div className="tc-dates">
          <span className="tc-dates-icon">📅</span>
          {formatDateRange(trip.startDate, trip.endDate)}
        </div>
        <button className="tc-view-btn" onClick={(e) => { e.stopPropagation(); onView(); }}>
          View Itinerary →
        </button>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export default function TripsPage() {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ title: '', startDate: '', endDate: '' });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.getTrips()
      .then((res) => setTrips(res.items || []))
      .catch((err) => {
        if (err.message === 'Failed to fetch' || err.status === 401 || err.status === 403) {
          signOut();
          navigate('/login');
        } else {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));

    getIdToken().then((token) => {
      if (!token) return;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setUserEmail(payload.email || '');
      } catch {}
    }).catch(() => {});
  }, [navigate]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  function openCreate(prefill = '') {
    setForm({ title: prefill, startDate: '', endDate: '' });
    setShowCreate(true);
  }

  function closeCreate() {
    setShowCreate(false);
    setForm({ title: '', startDate: '', endDate: '' });
    setError('');
  }

  async function createTrip(e) {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      const res = await api.createTrip(form);
      navigate(`/trips/${res.tripId}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  async function deleteTrip(tripId) {
    if (!window.confirm('Delete this trip? This cannot be undone.')) return;
    try {
      await api.deleteTrip(tripId);
      setTrips((prev) => prev.filter((t) => t.tripId !== tripId));
    } catch (err) {
      setError(err.message);
    }
  }

  function handleSignOut() {
    signOut();
    navigate('/login');
  }

  const now = new Date();
  const upcomingCount = trips.filter((t) => t.startDate && new Date(t.startDate) > now).length;
  const pastCount = trips.filter((t) => {
    if (!t.startDate) return false;
    const end = t.endDate ? new Date(t.endDate) : new Date(t.startDate);
    end.setHours(23, 59, 59, 999);
    return now > end;
  }).length;
  const avatarLetter = userEmail ? userEmail[0].toUpperCase() : 'U';

  return (
    <div className="trips-page">

      {/* ── Header ── */}
      <header className="trips-header">
        <div className="trips-header-inner">
          <div className="trips-brand">✈️ TripWiz</div>
          <div className="trips-header-right">
            <button className="trips-new-btn" onClick={() => openCreate()}>
              + New Trip
            </button>
            <div className="trips-user-wrap" ref={userMenuRef}>
              <button className="trips-avatar-btn" onClick={() => setUserMenuOpen((v) => !v)}>
                <div className="trips-avatar">{avatarLetter}</div>
                <span className="trips-chevron">{userMenuOpen ? '▲' : '▾'}</span>
              </button>
              {userMenuOpen && (
                <div className="trips-user-dropdown">
                  {userEmail && <div className="trips-user-email">{userEmail}</div>}
                  <button className="trips-dropdown-item" onClick={handleSignOut}>
                    🚪 Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="trips-main">
        <div className="trips-container">

          {error && (
            <div className="error-banner" style={{ marginBottom: '1.25rem' }}>
              {error}
              <button onClick={() => setError('')}>×</button>
            </div>
          )}

          {/* ── Hero / Stats ── */}
          <div className="trips-hero">
            <div className="trips-hero-text">
              <h1 className="trips-hero-title">My Trips ✈️</h1>
              <p className="trips-hero-sub">Plan, organize, and explore your adventures</p>
            </div>
            <div className="trips-stats">
              <div className="trips-stat">
                <div className="trips-stat-num">{trips.length}</div>
                <div className="trips-stat-label">Total Trips</div>
              </div>
              <div className="trips-stat-divider" />
              <div className="trips-stat">
                <div className="trips-stat-num">{upcomingCount}</div>
                <div className="trips-stat-label">Upcoming</div>
              </div>
              <div className="trips-stat-divider" />
              <div className="trips-stat">
                <div className="trips-stat-num">{pastCount}</div>
                <div className="trips-stat-label">Completed</div>
              </div>
            </div>
          </div>

          {/* ── Trips Grid ── */}
          <div className="trips-section-header">
            <h2 className="trips-section-title">Your Trips</h2>
            <span className="trips-section-count">
              {trips.length} {trips.length === 1 ? 'trip' : 'trips'}
            </span>
          </div>

          {loading ? (
            <div className="trips-loading">
              <div className="trips-loading-spinner" />
              Loading your trips…
            </div>
          ) : (
            <div className="trips-grid">
              <div className="tc tc--new" onClick={() => openCreate()}>
                <div className="tc-new-icon">+</div>
                <div className="tc-new-title">Plan a New Trip</div>
                <div className="tc-new-sub">Start your next adventure</div>
              </div>
              {trips.map((trip) => (
                <TripCard
                  key={trip.tripId}
                  trip={trip}
                  onView={() => navigate(`/trips/${trip.tripId}`)}
                  onDelete={deleteTrip}
                />
              ))}
            </div>
          )}

          {/* ── Inspiration ── */}
          <div className="trips-inspo">
            <div className="trips-section-header" style={{ marginTop: '2.5rem' }}>
              <h2 className="trips-section-title">Where to Next?</h2>
              <span className="trips-section-count">Trending destinations</span>
            </div>
            <div className="trips-inspo-grid">
              {INSPIRATION.map((dest) => (
                <div
                  key={dest.city}
                  className="inspo-card"
                  style={{ background: hashGradient(dest.city) }}
                  onClick={() => openCreate(dest.city)}
                >
                  <div className="inspo-emoji">{dest.emoji}</div>
                  <div className="inspo-city">{dest.city}</div>
                  <div className="inspo-country">{dest.country}</div>
                  <span className="inspo-tag">{dest.tag}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </main>

      {/* ── Create Trip Modal ── */}
      {showCreate && (
        <div className="trips-modal-backdrop" onClick={closeCreate}>
          <div className="trips-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trips-modal-header">
              <div className="trips-modal-title">✈️ Plan a New Trip</div>
              <button className="trips-modal-close" onClick={closeCreate}>×</button>
            </div>
            <form className="trips-modal-body" onSubmit={createTrip}>
              <label className="trips-modal-label">
                <span>Trip name</span>
                <input
                  className="trips-modal-input"
                  placeholder="e.g. Paris Summer 2026"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                  autoFocus
                />
              </label>
              <div className="trips-modal-dates">
                <label className="trips-modal-label">
                  <span>Start date</span>
                  <input
                    className="trips-modal-input"
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </label>
                <label className="trips-modal-label">
                  <span>End date</span>
                  <input
                    className="trips-modal-input"
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    min={form.startDate}
                  />
                </label>
              </div>
              <div className="trips-modal-actions">
                <button type="button" className="trips-modal-cancel" onClick={closeCreate}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="trips-modal-submit"
                  disabled={creating || !form.title.trim()}
                >
                  {creating ? 'Creating…' : 'Create Trip →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
