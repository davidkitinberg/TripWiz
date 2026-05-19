import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAuthenticated } from '../services/auth';

const BG_IMAGES = [
  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80',
  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=1920&q=80',
  'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1920&q=80',
  'https://images.unsplash.com/photo-1488085061387-422e29b40080?w=1920&q=80',
];

const STEPS = [
  { num: '01', icon: '🗺️', title: 'Choose Your Vibe', desc: 'Pick your destination, dates, and budget or travel style.' },
  { num: '02', icon: '📅', title: 'Customize Itinerary', desc: 'Add activities and attractions on a visual timeline and interactive map.' },
  { num: '03', icon: '👥', title: 'Collaborate', desc: 'Invite friends to edit the plan together in real-time — like Google Docs for travel.' },
  { num: '04', icon: '✈️', title: 'Go & Explore', desc: 'Get smart weather alerts and instant fallback suggestions before you set off.' },
];

const FEATURES = [
  { icon: '🌦️', title: 'Smart Weather Checks', desc: 'Automatic alerts when rain threatens an outdoor activity.' },
  { icon: '🗺️', title: 'Dynamic Route Map', desc: 'All your waypoints plotted and connected, in order, on one map.' },
  { icon: '⚡', title: 'Real-Time Collab', desc: 'Multiple people editing the same itinerary simultaneously.' },
  { icon: '🔄', title: 'Instant Fallbacks', desc: 'One-click indoor alternatives when the weather turns bad.' },
];

// Debounce helper
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function LocationAutocomplete({ value, onChange }) {
  const [query, setQuery] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef(null);
  const debouncedQuery = useDebounce(query, 350);

  // Fetch suggestions from Nominatim (OpenStreetMap, free, no key)
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
        })));
        setOpen(true);
        setActiveIdx(-1);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debouncedQuery]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => { if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function selectSuggestion(s) {
    setQuery(s.short);
    setSuggestions([]);
    setOpen(false);
    onChange({ name: s.short, lat: s.lat, lng: s.lng });
  }

  function handleKeyDown(e) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); selectSuggestion(suggestions[activeIdx]); }
    if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div className="autocomplete-wrapper" ref={wrapperRef}>
      <div className="search-pill">
        <span className="search-pill-label">Where to?</span>
        <input
          type="text"
          placeholder="Paris, Tokyo, Santorini…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); onChange({ name: e.target.value }); setOpen(true); }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        {loading && <span className="autocomplete-spinner">⋯</span>}
      </div>
      {open && suggestions.length > 0 && (
        <ul className="autocomplete-dropdown">
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

export default function HomePage() {
  const [destination, setDestination] = useState({ name: '' });
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [bgIndex, setBgIndex] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setInterval(() => setBgIndex((i) => (i + 1) % BG_IMAGES.length), 6000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  async function handleStartPlanning(e) {
    e.preventDefault();
    const auth = await isAuthenticated();
    if (auth) {
      navigate('/trips', { state: { destination, startDate, endDate } });
    } else {
      setShowAuthModal(true);
    }
  }

  return (
    <div className="home-page">

      {/* ── HERO ─────────────────────────────────────────────── */}
      <section className="hero">
        {BG_IMAGES.map((img, i) => (
          <div key={img} className="hero-bg" style={{ backgroundImage: `url(${img})`, opacity: i === bgIndex ? 1 : 0 }} />
        ))}
        <div className="hero-overlay" />

        <nav className={`home-nav ${scrolled ? 'home-nav--scrolled' : ''}`}>
          <span className="home-brand">TripWiz</span>
          <div className="home-nav-actions">
            <button className="nav-ghost-btn" onClick={() => navigate('/login')}>Sign In</button>
            <button className="nav-solid-btn" onClick={() => navigate('/login')}>Get Started</button>
          </div>
        </nav>

        <div className="hero-body">
          <h1 className="hero-headline">
            Plan your next adventure.<br />
            <span className="hero-accent">Smart. Together. Stress-free.</span>
          </h1>
          <p className="hero-sub">
            Real-time collaborative itineraries with live weather validation and dynamic routing.
          </p>

          <form className="hero-search-bar" onSubmit={handleStartPlanning}>
            <LocationAutocomplete value={destination.name} onChange={setDestination} />
            <div className="search-divider" />
            <div className="search-pill">
              <span className="search-pill-label">From</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="search-divider" />
            <div className="search-pill">
              <span className="search-pill-label">To</span>
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <button type="submit" className="search-cta-btn">Start Planning</button>
          </form>
        </div>

        <div className="hero-scroll-hint"><span>↓</span></div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────── */}
      <section className="section how-section">
        <div className="section-inner">
          <p className="section-eyebrow">Simple as 1-2-3-4</p>
          <h2 className="section-title">How TripWiz Works</h2>
          <p className="section-sub">From blank page to packed itinerary in minutes.</p>
          <div className="steps-grid">
            {STEPS.map((step) => (
              <div className="step-card" key={step.num}>
                <div className="step-num-badge">{step.num}</div>
                <div className="step-icon">{step.icon}</div>
                <h3 className="step-title">{step.title}</h3>
                <p className="step-desc">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES ─────────────────────────────────────────── */}
      <section className="section features-section">
        <div className="section-inner">
          <p className="section-eyebrow">Built-in intelligence</p>
          <h2 className="section-title">Everything your trip needs</h2>
          <div className="features-grid">
            {FEATURES.map((f) => (
              <div className="feature-card" key={f.title}>
                <div className="feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── BOTTOM CTA ───────────────────────────────────────── */}
      <section className="home-bottom-cta">
        <h2>Ready for your next adventure?</h2>
        <p>Create a free account and start planning smarter trips today.</p>
        <button className="cta-big-btn" onClick={() => navigate('/login')}>Create Free Account →</button>
      </section>

      <footer className="home-footer">
        <p>© 2026 TripWiz &nbsp;·&nbsp; Ariel University &nbsp;·&nbsp; David Kitinberg, Amit Bitton, Sagi Hassid</p>
      </footer>

      {/* ── AUTH CHOICE MODAL ─────────────────────────────────── */}
      {showAuthModal && (
        <div className="auth-choice-backdrop" onClick={() => setShowAuthModal(false)}>
          <div className="auth-choice-modal" onClick={(e) => e.stopPropagation()}>
            <button className="auth-choice-close" onClick={() => setShowAuthModal(false)}>×</button>

            <div className="auth-choice-icon">✈️</div>
            <h2 className="auth-choice-title">Ready to plan?</h2>

            {destination.name && (
              <p className="auth-choice-dest">📍 {destination.name}</p>
            )}
            {startDate && (
              <p className="auth-choice-dates">
                {startDate}{endDate ? ` → ${endDate}` : ''}
              </p>
            )}

            <p className="auth-choice-sub">Sign in to save your trip or create a free account to get started.</p>

            <div className="auth-choice-actions">
              <button
                className="auth-choice-primary"
                onClick={() => navigate('/login', { state: { mode: 'signin', destination, startDate, endDate } })}
              >
                Sign In
              </button>
              <button
                className="auth-choice-secondary"
                onClick={() => navigate('/login', { state: { mode: 'signup', destination, startDate, endDate } })}
              >
                Create Free Account
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
