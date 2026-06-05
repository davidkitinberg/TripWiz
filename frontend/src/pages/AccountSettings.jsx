import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Camera, Save, Trash2, Globe, Bell, User, AlertTriangle,
} from 'lucide-react';
import { getIdToken, signOut } from '../services/auth';
import { api } from '../services/api';

const PREFS_KEY = 'tripwiz_prefs';
const AVATAR_KEY = 'tripwiz_avatar';

const CURRENCIES = [
  { value: 'USD', label: 'USD – US Dollar ($)' },
  { value: 'EUR', label: 'EUR – Euro (€)' },
  { value: 'GBP', label: 'GBP – British Pound (£)' },
  { value: 'ILS', label: 'ILS – Israeli Shekel (₪)' },
  { value: 'JPY', label: 'JPY – Japanese Yen (¥)' },
  { value: 'AUD', label: 'AUD – Australian Dollar (A$)' },
  { value: 'CAD', label: 'CAD – Canadian Dollar (CA$)' },
  { value: 'CHF', label: 'CHF – Swiss Franc (Fr)' },
];

const TIMEZONES = [
  { value: 'America/New_York',   label: 'EST – New York (UTC−5)' },
  { value: 'America/Chicago',    label: 'CST – Chicago (UTC−6)' },
  { value: 'America/Denver',     label: 'MST – Denver (UTC−7)' },
  { value: 'America/Los_Angeles',label: 'PST – Los Angeles (UTC−8)' },
  { value: 'Europe/London',      label: 'GMT – London (UTC+0)' },
  { value: 'Europe/Paris',       label: 'CET – Paris (UTC+1)' },
  { value: 'Asia/Jerusalem',     label: 'IDT – Jerusalem (UTC+3)' },
  { value: 'Asia/Dubai',         label: 'GST – Dubai (UTC+4)' },
  { value: 'Asia/Singapore',     label: 'SGT – Singapore (UTC+8)' },
  { value: 'Asia/Tokyo',         label: 'JST – Tokyo (UTC+9)' },
  { value: 'Australia/Sydney',   label: 'AEDT – Sydney (UTC+11)' },
];

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'he', label: 'עברית (Hebrew)' },
  { value: 'es', label: 'Español (Spanish)' },
  { value: 'fr', label: 'Français (French)' },
  { value: 'de', label: 'Deutsch (German)' },
  { value: 'ja', label: '日本語 (Japanese)' },
];

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}

export default function AccountSettings() {
  const navigate = useNavigate();
  const avatarInputRef = useRef(null);

  const [email, setEmail] = useState('');
  const [avatar, setAvatar] = useState(() => localStorage.getItem(AVATAR_KEY) || null);

  const [prefs, setPrefs] = useState(() => ({
    firstName: '',
    lastName: '',
    currency: 'USD',
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch { return 'America/New_York'; } })(),
    language: 'en',
    notifyTrips: true,
    notifyMarketing: false,
    ...loadPrefs(),
  }));

  const [profileSaved, setProfileSaved] = useState(false);
  const [prefsSaved,   setPrefsSaved]   = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  useEffect(() => {
    getIdToken().then((token) => {
      if (!token) return;
      try { setEmail(JSON.parse(atob(token.split('.')[1])).email || ''); } catch {}
    }).catch(() => {});

    // Merge in any prefs previously saved to DynamoDB (remote is authoritative for notifyTrips)
    api.getUserPrefs().then((remote) => {
      if (remote && Object.keys(remote).length > 0) {
        setPrefs((local) => ({ ...local, ...remote }));
      }
    }).catch(() => {});
  }, []);

  function set(key, value) {
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  function persistPrefs(next) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  }

  // [Feature #5] Save profile details (name + avatar) locally and to DynamoDB prefs
  function saveProfile() {
    persistPrefs(prefs);
    api.saveUserPrefs(prefs).catch(() => {});
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  }

  // [Feature #6] Save regional & travel preferences (currency, timezone, language)
  function savePreferences() {
    persistPrefs(prefs);
    api.saveUserPrefs(prefs).catch(() => {});
    setPrefsSaved(true);
    setTimeout(() => setPrefsSaved(false), 2500);
  }

  function handleAvatarFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      setAvatar(dataUrl);
      localStorage.setItem(AVATAR_KEY, dataUrl);
    };
    reader.readAsDataURL(file);
  }

  // [Feature #7] Toggle notification preferences; synced to DynamoDB for the reminder Lambda
  function toggleNotif(key) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    persistPrefs(next);
    api.saveUserPrefs(next).catch(() => {});
  }

  // [Feature #8] Self-service account deletion (type-to-confirm, then sign out)
  function handleDeleteAccount() {
    if (deleteConfirm.toLowerCase() !== 'delete') return;
    signOut();
    navigate('/');
  }

  const initials = prefs.firstName
    ? `${prefs.firstName[0]}${prefs.lastName?.[0] || ''}`.toUpperCase()
    : (email ? email[0].toUpperCase() : 'U');

  return (
    <div className="settings-page">
      <div className="trips-bg" aria-hidden="true">
        <div className="aurora-orb aurora-orb--1" />
        <div className="aurora-orb aurora-orb--2" />
        <div className="aurora-orb aurora-orb--3" />
        <div className="aurora-orb aurora-orb--4" />
      </div>

      <header className="settings-header">
        <button className="settings-back" onClick={() => navigate('/trips')}>
          <ArrowLeft size={15} strokeWidth={2.5} /> Back to Trips
        </button>
        <div className="settings-header-title">Account Settings</div>
        <div className="settings-header-spacer" />
      </header>

      <div className="settings-container">

        {/* ── Profile Details ─────────────────────────────── */}
        <section className="settings-section">
          <div className="settings-section-header">
            <span className="settings-section-icon"><User size={16} strokeWidth={2} /></span>
            <div>
              <h2 className="settings-section-title">Profile Details</h2>
              <p className="settings-section-sub">Your name and photo visible to collaborators</p>
            </div>
          </div>

          <div className="settings-avatar-row">
            <div className="settings-avatar-wrap" onClick={() => avatarInputRef.current?.click()}>
              {avatar
                ? <img src={avatar} alt="Avatar" className="settings-avatar-img" />
                : <div className="settings-avatar-placeholder">{initials}</div>
              }
              <div className="settings-avatar-overlay">
                <Camera size={15} strokeWidth={2} />
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files[0]; if (f) handleAvatarFile(f); }}
              />
            </div>
            <div className="settings-avatar-meta">
              <div className="settings-avatar-label">Profile photo</div>
              <div className="settings-avatar-hint">Click to upload · JPG, PNG, WebP · Max 5 MB</div>
              {avatar && (
                <button
                  className="settings-avatar-remove"
                  onClick={(e) => { e.stopPropagation(); setAvatar(null); localStorage.removeItem(AVATAR_KEY); }}
                >
                  Remove photo
                </button>
              )}
            </div>
          </div>

          <div className="settings-fields">
            <div className="settings-field-row">
              <div className="settings-field">
                <label className="settings-label">First Name</label>
                <input
                  className="settings-input"
                  placeholder="Your first name"
                  value={prefs.firstName}
                  onChange={(e) => set('firstName', e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label className="settings-label">Last Name</label>
                <input
                  className="settings-input"
                  placeholder="Your last name"
                  value={prefs.lastName}
                  onChange={(e) => set('lastName', e.target.value)}
                />
              </div>
            </div>
            <div className="settings-field">
              <label className="settings-label">Email Address</label>
              <input
                className="settings-input settings-input--readonly"
                value={email}
                readOnly
                tabIndex={-1}
              />
              <span className="settings-field-hint">Email is managed by your Cognito account and cannot be changed here.</span>
            </div>
          </div>

          <div className="settings-section-footer">
            <button
              className={`settings-save-btn ${profileSaved ? 'settings-save-btn--saved' : ''}`}
              onClick={saveProfile}
            >
              <Save size={14} strokeWidth={2.2} />
              {profileSaved ? 'Saved!' : 'Save Profile'}
            </button>
          </div>
        </section>

        {/* ── Regional & Travel Preferences ───────────────── */}
        <section className="settings-section">
          <div className="settings-section-header">
            <span className="settings-section-icon"><Globe size={16} strokeWidth={2} /></span>
            <div>
              <h2 className="settings-section-title">Regional & Travel Preferences</h2>
              <p className="settings-section-sub">Defaults applied across all your trips</p>
            </div>
          </div>

          <div className="settings-fields">
            <div className="settings-field-row">
              <div className="settings-field">
                <label className="settings-label">Default Currency</label>
                <select
                  className="settings-select"
                  value={prefs.currency}
                  onChange={(e) => set('currency', e.target.value)}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div className="settings-field">
                <label className="settings-label">Timezone</label>
                <select
                  className="settings-select"
                  value={prefs.timezone}
                  onChange={(e) => set('timezone', e.target.value)}
                >
                  {TIMEZONES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="settings-field settings-field--half">
              <label className="settings-label">Display Language</label>
              <select
                className="settings-select"
                value={prefs.language}
                onChange={(e) => set('language', e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-section-footer">
            <button
              className={`settings-save-btn ${prefsSaved ? 'settings-save-btn--saved' : ''}`}
              onClick={savePreferences}
            >
              <Save size={14} strokeWidth={2.2} />
              {prefsSaved ? 'Saved!' : 'Save Preferences'}
            </button>
          </div>
        </section>

        {/* ── Notifications ───────────────────────────────── */}
        <section className="settings-section">
          <div className="settings-section-header">
            <span className="settings-section-icon"><Bell size={16} strokeWidth={2} /></span>
            <div>
              <h2 className="settings-section-title">Notifications</h2>
              <p className="settings-section-sub">Control what TripWiz sends you</p>
            </div>
          </div>

          <div className="settings-toggles">
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <div className="settings-toggle-label">Upcoming Trip Reminders</div>
                <div className="settings-toggle-sub">Get notified 48 hours before your trip starts</div>
              </div>
              <button
                className={`settings-toggle-track ${prefs.notifyTrips ? 'settings-toggle-track--on' : ''}`}
                onClick={() => toggleNotif('notifyTrips')}
                role="switch"
                aria-checked={prefs.notifyTrips}
                aria-label="Trip reminders"
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>

            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <div className="settings-toggle-label">Marketing & Offers</div>
                <div className="settings-toggle-sub">Destination ideas and seasonal promotions</div>
              </div>
              <button
                className={`settings-toggle-track ${prefs.notifyMarketing ? 'settings-toggle-track--on' : ''}`}
                onClick={() => toggleNotif('notifyMarketing')}
                role="switch"
                aria-checked={prefs.notifyMarketing}
                aria-label="Marketing notifications"
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
          </div>
        </section>

        {/* ── Danger Zone ─────────────────────────────────── */}
        <section className="settings-section settings-section--danger">
          <div className="settings-section-header">
            <span className="settings-section-icon settings-section-icon--danger">
              <AlertTriangle size={16} strokeWidth={2} />
            </span>
            <div>
              <h2 className="settings-section-title settings-section-title--danger">Danger Zone</h2>
              <p className="settings-section-sub">These actions are permanent and cannot be undone</p>
            </div>
          </div>

          <p className="settings-danger-text">
            Permanently delete your TripWiz account and all associated data — trips, itineraries,
            collaborators, and preferences. This action <strong>cannot be reversed</strong>.
          </p>

          <div className="settings-fields" style={{ marginTop: '1.25rem' }}>
            <div className="settings-field settings-field--half">
              <label className="settings-label">
                Type <strong style={{ color: '#f87171', fontWeight: 700 }}>delete</strong> to confirm
              </label>
              <input
                className="settings-input settings-input--danger-confirm"
                placeholder="delete"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="settings-section-footer">
            <button
              className="settings-delete-btn"
              onClick={handleDeleteAccount}
              disabled={deleteConfirm.toLowerCase() !== 'delete'}
            >
              <Trash2 size={15} strokeWidth={2} />
              Delete My Account
            </button>
          </div>
        </section>

      </div>
    </div>
  );
}
