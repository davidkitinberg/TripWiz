import React, { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, Save } from 'lucide-react';
import { api } from '../services/api';

const EMPTY = { city: '', country: '', tag: '', emoji: '🌍' };

export default function AdminTrendingPage() {
  const [destinations, setDestinations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // { index, draft } or { index: 'new', draft }
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    api.getTrending()
      .then((res) => setDestinations(res.destinations || []))
      .catch((err) => setError(err.message || 'Failed to load trending destinations'))
      .finally(() => setLoading(false));
  }, []);

  function openEdit(index) {
    setEditing({ index, draft: { ...destinations[index] } });
  }

  function openAdd() {
    setEditing({ index: 'new', draft: { ...EMPTY } });
  }

  async function saveEdit() {
    const { index, draft } = editing;
    let next;
    if (index === 'new') next = [...destinations, draft];
    else next = destinations.map((d, i) => i === index ? draft : d);
    setEditing(null);
    setDestinations(next);
    await persist(next);
  }

  async function removeAt(i) {
    const next = destinations.filter((_, idx) => idx !== i);
    setDestinations(next);
    await persist(next);
  }

  async function persist(next) {
    setSaving(true);
    setError('');
    try {
      const res = await api.updateTrending(next);
      setDestinations(res.destinations || next);
      setSavedAt(new Date());
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <header className="admin-page-header">
        <div>
          <h1>Platform Settings</h1>
          <p>Trending destinations shown on every user's dashboard.</p>
        </div>
        <div className="admin-page-header-aside">
          {saving && <span className="admin-muted">Saving…</span>}
          {!saving && savedAt && <span className="admin-muted">Saved {savedAt.toLocaleTimeString()}</span>}
          <button className="btn-primary" onClick={openAdd}>
            <Plus size={16} /> Add Destination
          </button>
        </div>
      </header>

      {error && <div className="admin-error-banner" onClick={() => setError('')}>{error} (click to dismiss)</div>}

      {loading && <p className="admin-muted">Loading…</p>}

      <div className="admin-trending-grid">
        {destinations.map((d, i) => (
          <div key={i} className="admin-trending-card">
            <div className="admin-trending-emoji">{d.emoji || '🌍'}</div>
            <div className="admin-trending-city">{d.city}</div>
            <div className="admin-trending-country">{d.country}</div>
            <div className="admin-trending-tag">{d.tag}</div>
            <div className="admin-trending-actions">
              <button className="btn-ghost" onClick={() => openEdit(i)}>
                <Pencil size={14}/> Edit
              </button>
              <button className="btn-ghost btn-ghost--danger" onClick={() => removeAt(i)} disabled={saving}>
                <Trash2 size={14}/> Remove
              </button>
            </div>
          </div>
        ))}
        {!loading && destinations.length === 0 && (
          <div className="admin-muted">No trending destinations set. Add one to populate the user dashboard.</div>
        )}
      </div>

      {editing && (
        <div className="admin-modal-backdrop" onClick={() => setEditing(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing.index === 'new' ? 'Add destination' : 'Edit destination'}</h2>
            <label>Emoji</label>
            <input
              type="text"
              maxLength={4}
              value={editing.draft.emoji}
              onChange={(e) => setEditing((s) => ({ ...s, draft: { ...s.draft, emoji: e.target.value } }))}
            />
            <label>City</label>
            <input
              type="text"
              placeholder="Tokyo"
              value={editing.draft.city}
              onChange={(e) => setEditing((s) => ({ ...s, draft: { ...s.draft, city: e.target.value } }))}
            />
            <label>Country</label>
            <input
              type="text"
              placeholder="Japan"
              value={editing.draft.country}
              onChange={(e) => setEditing((s) => ({ ...s, draft: { ...s.draft, country: e.target.value } }))}
            />
            <label>Tagline</label>
            <input
              type="text"
              placeholder="Culture & Food"
              value={editing.draft.tag}
              onChange={(e) => setEditing((s) => ({ ...s, draft: { ...s.draft, tag: e.target.value } }))}
            />
            <div className="admin-modal-actions">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveEdit} disabled={!editing.draft.city.trim()}>
                <Save size={14}/> Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
