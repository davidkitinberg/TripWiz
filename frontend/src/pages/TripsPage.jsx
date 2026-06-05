import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, ImageIcon, Trash2, MoreHorizontal, Upload, Plane, Plus, Calendar, LogOut, Settings } from 'lucide-react';
import { api } from '../services/api';
import { signOut, getIdToken } from '../services/auth';

/* ─── Constants ─────────────────────────────────────────── */

const CARD_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 55%, #f093fb 100%)',
  'linear-gradient(135deg, #f5576c 0%, #f093fb 55%, #fda085 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 50%, #43e97b 100%)',
  'linear-gradient(135deg, #11998e 0%, #38ef7d 55%, #4facfe 100%)',
  'linear-gradient(135deg, #fa709a 0%, #f093fb 50%, #fee140 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #667eea 55%, #764ba2 100%)',
  'linear-gradient(135deg, #f7971e 0%, #ffd200 55%, #ff6b6b 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #764ba2 50%, #fbc2eb 100%)',
];

const INSPIRATION = [
  { city: 'Tokyo',     country: 'Japan',  tag: 'Culture & Food',   emoji: '🗾' },
  { city: 'New York',  country: 'USA',    tag: 'City Break',       emoji: '🗽' },
  { city: 'Santorini', country: 'Greece', tag: 'Beach & Sun',      emoji: '🏖️' },
  { city: 'Kyoto',     country: 'Japan',  tag: 'History & Nature', emoji: '⛩️' },
];

/* ─── Helpers ────────────────────────────────────────────── */

function hashGradient(str) {
  const idx = (str || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % CARD_GRADIENTS.length;
  return CARD_GRADIENTS[idx];
}

function getTripStatus(trip) {
  if (!trip.startDate) return { label: 'Draft', type: 'draft' };
  const now = new Date();
  const start = new Date(trip.startDate);
  const end = trip.endDate ? new Date(trip.endDate) : new Date(trip.startDate);
  end.setHours(23, 59, 59, 999);
  if (now < start) return { label: 'Upcoming', type: 'upcoming' };
  if (now > end) return { label: 'Past', type: 'past' };
  return { label: 'Active', type: 'active' };
}

function formatDateRange(start, end) {
  if (!start) return 'Dates not set';
  const fmt = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return end ? `${fmt(start)} – ${fmt(end)}` : `From ${fmt(start)}`;
}

// Persist user-uploaded images in localStorage (base64)
function loadLocalImages() {
  try { return JSON.parse(localStorage.getItem('tripwiz_images') || '{}'); } catch { return {}; }
}
function saveLocalImages(map) {
  try { localStorage.setItem('tripwiz_images', JSON.stringify(map)); } catch {}
}

// Fetch representative destination photo from Wikipedia (free, no key, CORS)
// [Feature #12] Auto cover image — representative destination photo from Wikipedia
async function fetchWikiImage(title) {
  const query = (title || '').split(/\s+/).slice(0, 2).join(' ');
  if (!query) return null;
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(query)}&prop=pageimages&format=json&pithumbsize=640&origin=*`;
  const res = await fetch(url);
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return null;
  return Object.values(pages)[0]?.thumbnail?.source || null;
}

/* ─── Image drop-zone component ─────────────────────────── */

// [Feature #12] Custom trip cover image — drag & drop / browse upload
function ImageDropZone({ onFile }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) onFile(file);
  }

  return (
    <div
      className={`img-dropzone ${dragging ? 'img-dropzone--active' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files[0]; if (f) onFile(f); }}
      />
      <Upload size={32} strokeWidth={1.5} className="img-dropzone-icon" />
      <div className="img-dropzone-title">Drag & drop an image here</div>
      <div className="img-dropzone-sub">or <span>click to browse files</span></div>
      <div className="img-dropzone-hint">JPG, PNG, WebP · Max 5 MB</div>
    </div>
  );
}

/* ─── Trip Card ──────────────────────────────────────────── */

function TripCard({ trip, localImage, isMenuOpen, onToggleMenu, onView, onDelete, onRename, onChangeImage }) {
  const [autoImage, setAutoImage] = useState(null);
  const menuRef = useRef(null);
  const status = getTripStatus(trip);
  const gradient = hashGradient(trip.title);
  const displayImage = localImage || autoImage;

  // Fetch Wikipedia photo when no local image is set
  useEffect(() => {
    if (localImage) { setAutoImage(null); return; }
    let cancelled = false;
    fetchWikiImage(trip.title).then((url) => { if (!cancelled) setAutoImage(url); }).catch(() => {});
    return () => { cancelled = true; };
  }, [trip.title, localImage]);

  // Close this menu on outside click
  useEffect(() => {
    if (!isMenuOpen) return;
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onToggleMenu(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isMenuOpen, onToggleMenu]);

  return (
    <div className="tc" onClick={onView}>

      {/* Banner — overflow:hidden on its own so zoom effect clips correctly */}
      <div className="tc-banner" style={displayImage ? undefined : { background: gradient }}>
        {displayImage && (
          <img src={displayImage} alt={trip.title} className="tc-banner-img" />
        )}
        <div className="tc-banner-overlay" />
      </div>

      {/* Status badge + menu — live on .tc (not inside banner) so dropdown escapes */}
      <div className="tc-top-row">
        <span className={`tc-status tc-status--${status.type}`}>{status.label}</span>
        <div className="tc-menu-wrap" ref={menuRef} onClick={(e) => e.stopPropagation()}>
          <button
            className="tc-menu-btn"
            onClick={() => onToggleMenu()}
            title="More options"
            aria-expanded={isMenuOpen}
          >
            <MoreHorizontal size={15} />
          </button>
          {isMenuOpen && (
            <div className="tc-menu-dropdown">
              <button className="tc-menu-item" onClick={() => { onToggleMenu(); onRename(); }}>
                <Pencil size={13} strokeWidth={2.2} /> Rename Trip
              </button>
              <button className="tc-menu-item" onClick={() => { onToggleMenu(); onChangeImage(); }}>
                <ImageIcon size={13} strokeWidth={2.2} /> Change Image
              </button>
              <div className="tc-menu-divider" />
              <button className="tc-menu-item tc-menu-item--danger" onClick={() => { onToggleMenu(); onDelete(trip.tripId); }}>
                <Trash2 size={13} strokeWidth={2.2} /> Delete Trip
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="tc-body">
        <div className="tc-title">{trip.title || 'Untitled Trip'}</div>
        <div className="tc-dates">
          <Calendar size={12} strokeWidth={2} />
          {formatDateRange(trip.startDate, trip.endDate)}
        </div>
        <button className="tc-view-btn" onClick={(e) => { e.stopPropagation(); onView(); }}>
          Open Overview →
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

  const [activeMenuId, setActiveMenuId] = useState(null);
  const [localImages, setLocalImages] = useState(loadLocalImages);

  const [renamingTrip, setRenamingTrip] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const [changingImageForId, setChangingImageForId] = useState(null);

  const [trending, setTrending] = useState(INSPIRATION);

  // [Feature #14] Load admin-curated trending destinations (with built-in fallback)
  useEffect(() => {
    api.getTrending()
      .then((res) => { if (Array.isArray(res.destinations) && res.destinations.length > 0) setTrending(res.destinations); })
      .catch(() => { /* keep fallback */ });
  }, []);

  // [Feature #10] Load the signed-in user's trips for the "My Trips" dashboard
  useEffect(() => {
    api.getTrips()
      .then((res) => setTrips(res.items || []))
      .catch((err) => {
        if (err.message === 'Failed to fetch' || err.status === 401 || err.status === 403) {
          signOut(); navigate('/login');
        } else { setError(err.message); }
      })
      .finally(() => setLoading(false));

    getIdToken().then((token) => {
      if (!token) return;
      try { setUserEmail(JSON.parse(atob(token.split('.')[1])).email || ''); } catch {}
    }).catch(() => {});
  }, [navigate]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const h = (e) => { if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [userMenuOpen]);

  function openCreate(prefill = '') {
    setForm({ title: prefill, startDate: '', endDate: '' });
    setShowCreate(true);
  }

  // [Feature #9] Create a new trip and open its planner
  async function createTrip(e) {
    e.preventDefault();
    setCreating(true); setError('');
    try {
      const res = await api.createTrip(form);
      navigate(`/trips/${res.tripId}`);
    } catch (err) { setError(err.message); setCreating(false); }
  }

  // [Feature #13] Delete a trip (backend soft-deletes; also drops its local cover image)
  async function deleteTrip(tripId) {
    if (!window.confirm('Delete this trip? This cannot be undone.')) return;
    try {
      await api.deleteTrip(tripId);
      setTrips((prev) => prev.filter((t) => t.tripId !== tripId));
      const next = { ...localImages };
      delete next[tripId];
      setLocalImages(next);
      saveLocalImages(next);
    } catch (err) { setError(err.message); }
  }

  function startRename(trip) { setRenamingTrip(trip); setRenameDraft(trip.title || ''); }

  // [Feature #11] Rename a trip (optimistic update + PUT /trips)
  async function submitRename(e) {
    e.preventDefault();
    if (!renamingTrip || !renameDraft.trim()) return;
    setRenaming(true);
    try {
      await api.updateTrip(renamingTrip.tripId, { title: renameDraft.trim() });
      setTrips((prev) => prev.map((t) => t.tripId === renamingTrip.tripId ? { ...t, title: renameDraft.trim() } : t));
      setRenamingTrip(null);
    } catch (err) { setError(err.message); }
    finally { setRenaming(false); }
  }

  function handleImageFile(tripId, file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const next = { ...localImages, [tripId]: dataUrl };
      setLocalImages(next);
      saveLocalImages(next);
      setChangingImageForId(null);
    };
    reader.readAsDataURL(file);
  }

  function handleSignOut() { signOut(); navigate('/login'); }

  const now = new Date();
  const upcomingCount = trips.filter((t) => t.startDate && new Date(t.startDate) > now).length;
  const pastCount = trips.filter((t) => {
    if (!t.startDate) return false;
    const end = t.endDate ? new Date(t.endDate) : new Date(t.startDate);
    end.setHours(23, 59, 59, 999);
    return now > end;
  }).length;

  return (
    <div className="trips-page">
      <div className="trips-bg" aria-hidden="true">
        <div className="aurora-orb aurora-orb--1" />
        <div className="aurora-orb aurora-orb--2" />
        <div className="aurora-orb aurora-orb--3" />
        <div className="aurora-orb aurora-orb--4" />
      </div>

      <header className="trips-header">
        <div className="trips-header-inner">
          <div className="trips-brand">
            <Plane size={18} strokeWidth={2.2} />
            TripWiz
          </div>
          <div className="trips-header-right">
            <button className="trips-new-btn" onClick={() => openCreate()}>+ New Trip</button>
            <div className="trips-user-wrap" ref={userMenuRef}>
              <button className="trips-avatar-btn" onClick={() => setUserMenuOpen((v) => !v)}>
                <div className="trips-avatar">{userEmail ? userEmail[0].toUpperCase() : 'U'}</div>
                <span className="trips-chevron">{userMenuOpen ? '▲' : '▾'}</span>
              </button>
              {userMenuOpen && (
                <div className="trips-user-dropdown">
                  {userEmail && <div className="trips-user-email">{userEmail}</div>}
                  <div className="trips-dropdown-divider" />
                  <button className="trips-dropdown-item" onClick={() => { setUserMenuOpen(false); navigate('/settings'); }}>
                    <Settings size={14} strokeWidth={2} /> Account Settings
                  </button>
                  <button className="trips-dropdown-item trips-dropdown-item--danger" onClick={handleSignOut}>
                    <LogOut size={14} strokeWidth={2} /> Sign Out
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
              {error}<button onClick={() => setError('')}>×</button>
            </div>
          )}

          <div className="trips-hero">
            <div className="trips-hero-text">
              <h1 className="trips-hero-title">My Trips</h1>
              <p className="trips-hero-sub">Plan, organize, and explore your adventures</p>
            </div>
            <div className="trips-stats">
              <div className="trips-stat"><div className="trips-stat-num">{trips.length}</div><div className="trips-stat-label">Total Trips</div></div>
              <div className="trips-stat-divider" />
              <div className="trips-stat"><div className="trips-stat-num">{upcomingCount}</div><div className="trips-stat-label">Upcoming</div></div>
              <div className="trips-stat-divider" />
              <div className="trips-stat"><div className="trips-stat-num">{pastCount}</div><div className="trips-stat-label">Completed</div></div>
            </div>
          </div>

          <div className="trips-section-header">
            <h2 className="trips-section-title">Your Trips</h2>
            <span className="trips-section-count">{trips.length} {trips.length === 1 ? 'trip' : 'trips'}</span>
          </div>

          {loading ? (
            <div className="trips-loading"><div className="trips-loading-spinner" />Loading your trips…</div>
          ) : (
            <div className="trips-grid">
              <div className="tc tc--new" onClick={() => openCreate()}>
                <div className="tc-new-icon"><Plus size={22} strokeWidth={2.5} /></div>
                <div className="tc-new-title">Plan a New Trip</div>
                <div className="tc-new-sub">Start your next adventure</div>
              </div>
              {trips.map((trip) => (
                <TripCard
                  key={trip.tripId}
                  trip={trip}
                  localImage={localImages[trip.tripId] || null}
                  isMenuOpen={activeMenuId === trip.tripId}
                  onToggleMenu={() => setActiveMenuId((v) => v === trip.tripId ? null : trip.tripId)}
                  onView={() => navigate(`/trips/${trip.tripId}/overview`)}
                  onDelete={deleteTrip}
                  onRename={() => startRename(trip)}
                  onChangeImage={() => setChangingImageForId(trip.tripId)}
                />
              ))}
            </div>
          )}

          <div className="trips-inspo">
            <div className="trips-section-header" style={{ marginTop: '2.5rem' }}>
              <h2 className="trips-section-title">Where to Next?</h2>
              <span className="trips-section-count">Trending destinations</span>
            </div>
            <div className="trips-inspo-grid">
              {trending.map((dest) => (
                <div key={dest.city} className="inspo-card" style={{ '--inspo-grad': hashGradient(dest.city) }} onClick={() => openCreate(dest.city)}>
                  <div className="inspo-emoji">{dest.emoji}</div>
                  <div className="inspo-glass">
                    <div className="inspo-city">{dest.city}</div>
                    <div className="inspo-country">{dest.country}</div>
                    <span className="inspo-tag">{dest.tag}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {/* ── Create Trip Modal ── */}
      {showCreate && (
        <div className="trips-modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="trips-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trips-modal-header">
              <div className="trips-modal-title">✈️ Plan a New Trip</div>
              <button className="trips-modal-close" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <form className="trips-modal-body" onSubmit={createTrip}>
              <label className="trips-modal-label">
                <span>Trip name</span>
                <input className="trips-modal-input" placeholder="e.g. Paris Summer 2026" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required autoFocus />
              </label>
              <div className="trips-modal-dates">
                <label className="trips-modal-label"><span>Start date</span><input className="trips-modal-input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
                <label className="trips-modal-label"><span>End date</span><input className="trips-modal-input" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} min={form.startDate} /></label>
              </div>
              <div className="trips-modal-actions">
                <button type="button" className="trips-modal-cancel" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="trips-modal-submit" disabled={creating || !form.title.trim()}>{creating ? 'Creating…' : 'Create Trip →'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Rename Modal ── */}
      {renamingTrip && (
        <div className="trips-modal-backdrop" onClick={() => setRenamingTrip(null)}>
          <div className="trips-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trips-modal-header">
              <div className="trips-modal-title">✏️ Rename Trip</div>
              <button className="trips-modal-close" onClick={() => setRenamingTrip(null)}>×</button>
            </div>
            <form className="trips-modal-body" onSubmit={submitRename}>
              <label className="trips-modal-label">
                <span>Trip name</span>
                <input className="trips-modal-input" value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} required autoFocus />
              </label>
              <div className="trips-modal-actions">
                <button type="button" className="trips-modal-cancel" onClick={() => setRenamingTrip(null)}>Cancel</button>
                <button type="submit" className="trips-modal-submit" disabled={renaming || !renameDraft.trim() || renameDraft.trim() === renamingTrip.title}>{renaming ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Change Image Modal ── */}
      {changingImageForId && (
        <div className="trips-modal-backdrop" onClick={() => setChangingImageForId(null)}>
          <div className="trips-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trips-modal-header">
              <div className="trips-modal-title">🖼️ Change Trip Image</div>
              <button className="trips-modal-close" onClick={() => setChangingImageForId(null)}>×</button>
            </div>
            <div className="trips-modal-body">
              <ImageDropZone onFile={(file) => handleImageFile(changingImageForId, file)} />
              {localImages[changingImageForId] && (
                <button
                  className="trips-modal-cancel"
                  style={{ width: '100%', marginTop: '0.5rem', color: '#dc2626' }}
                  onClick={() => {
                    const next = { ...localImages };
                    delete next[changingImageForId];
                    setLocalImages(next);
                    saveLocalImages(next);
                    setChangingImageForId(null);
                  }}
                >
                  Remove custom image
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
