/**
 * @fileoverview Admin trip moderation: list, hide, and delete trips.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical, EyeOff, Eye, Trash2, Search, X, MapPin, Calendar } from 'lucide-react';
import { api } from '../services/api';

function useDebounce(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// [Feature #47] Trip moderation — preview a trip's itinerary in a modal
function TripPreviewModal({ trip, onClose, onDelete, acting }) {
  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal admin-trip-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-trip-preview-header">
          <div>
            <h2>{trip.title || 'Untitled Trip'}</h2>
            <div className="admin-trip-preview-meta">
              <span className="admin-trip-preview-owner">{trip.ownerEmail || 'Unknown owner'}</span>
              {trip.startDate && (
                <span className="admin-trip-preview-dates">
                  <Calendar size={13} strokeWidth={2} />
                  {fmtDate(trip.startDate)}{trip.endDate ? ` – ${fmtDate(trip.endDate)}` : ''}
                </span>
              )}
            </div>
          </div>
          <button className="admin-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="admin-trip-preview-body">
          {trip.itinerary && trip.itinerary.length > 0 ? (
            <ol className="admin-trip-itinerary">
              {trip.itinerary.map((stop, i) => (
                <li key={i} className="admin-trip-itinerary-item">
                  <div className="admin-itinerary-num">{i + 1}</div>
                  <div className="admin-itinerary-content">
                    <div className="admin-itinerary-location">
                      <MapPin size={13} strokeWidth={2} />
                      {stop.location || stop.city || stop.name || 'Unknown location'}
                    </div>
                    {stop.startDate && (
                      <div className="admin-itinerary-date">{fmtDate(stop.startDate)}{stop.endDate ? ` – ${fmtDate(stop.endDate)}` : ''}</div>
                    )}
                    {stop.activities && stop.activities.length > 0 && (
                      <ul className="admin-itinerary-activities">
                        {stop.activities.slice(0, 4).map((a, j) => (
                          <li key={j}>{a.title || a.name || a}</li>
                        ))}
                        {stop.activities.length > 4 && (
                          <li className="admin-muted">+{stop.activities.length - 4} more</li>
                        )}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="admin-muted">No itinerary stops recorded.</p>
          )}
        </div>

        <div className="admin-modal-actions">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-danger" onClick={() => onDelete(trip)} disabled={acting}>
            <Trash2 size={14} />
            {acting ? 'Deleting…' : 'Delete Trip'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminTripsPage() {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 350);
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [previewTrip, setPreviewTrip] = useState(null);
  const [acting, setActing] = useState(false);
  const tableRef = useRef(null);

  const load = (q) => {
    setLoading(true);
    api.getAdminTrips(q || undefined)
      .then((res) => setTrips(res.items || []))
      .catch((err) => setError(err.message || 'Failed to load trips'))
      .finally(() => setLoading(false));
  };

  // [Feature #47] Trip moderation — list & debounced search by title/owner email
  useEffect(() => { load(debouncedQuery); }, [debouncedQuery]);

  useEffect(() => {
    const onClick = (e) => {
      if (tableRef.current && !tableRef.current.contains(e.target)) setMenuOpenId(null);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function runAction(promise, optimistic) {
    setActing(true);
    try {
      if (optimistic) optimistic();
      await promise;
      load(debouncedQuery);
    } catch (err) {
      setError(err.message || 'Action failed');
      load(debouncedQuery);
    } finally {
      setActing(false);
      setMenuOpenId(null);
    }
  }

  // [Feature #48] Hide / unhide a trip for moderation
  function handleHide(t) {
    const next = !t.hidden;
    runAction(api.hideAdminTrip(t.tripId, next), () =>
      setTrips((prev) => prev.map((x) => x.tripId === t.tripId ? { ...x, hidden: next } : x))
    );
  }

  // [Feature #49] Delete a trip from the platform (admin moderation)
  function handleDelete(t) {
    runAction(api.deleteAdminTrip(t.tripId), () =>
      setTrips((prev) => prev.filter((x) => x.tripId !== t.tripId))
    );
    setConfirmDelete(null);
    setPreviewTrip(null);
  }

  return (
    <div>
      <header className="admin-page-header">
        <h1>Trip Moderation</h1>
        <p>{trips.length} trip{trips.length === 1 ? '' : 's'} across the platform</p>
      </header>

      {error && <div className="admin-error-banner" onClick={() => setError('')}>{error} (click to dismiss)</div>}

      <div className="admin-search-row">
        <div className="admin-search-input">
          <Search size={16} className="admin-search-icon" />
          <input
            type="text"
            placeholder="Search by trip title or owner email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="admin-table-wrap" ref={tableRef}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Trip</th>
              <th>Owner</th>
              <th>Dates</th>
              <th>Stops</th>
              <th>Created</th>
              <th>Status</th>
              <th className="admin-table-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan="7" className="admin-muted" style={{ padding: '2rem', textAlign: 'center' }}>Loading trips…</td></tr>
            )}
            {!loading && trips.length === 0 && (
              <tr><td colSpan="7" className="admin-muted" style={{ padding: '2rem', textAlign: 'center' }}>No trips match.</td></tr>
            )}
            {trips.map((t) => (
              <tr key={t.tripId} className={t.hidden ? 'admin-row--dim' : ''}>
                <td>
                  <button className="admin-trip-title-btn" onClick={() => setPreviewTrip(t)}>
                    {t.title}
                  </button>
                  <div className="admin-trip-id admin-mono">{(t.tripId || '').slice(0, 12)}…</div>
                </td>
                <td>{t.ownerEmail || <span className="admin-muted">unknown</span>}</td>
                <td>{t.startDate ? `${fmtDate(t.startDate)}${t.endDate ? ` – ${fmtDate(t.endDate)}` : ''}` : <span className="admin-muted">—</span>}</td>
                <td>{t.itineraryLength}</td>
                <td>{fmtDate(t.createdAt)}</td>
                <td>
                  {t.hidden
                    ? <span className="admin-status-badge admin-status-badge--hidden">Hidden</span>
                    : <span className="admin-status-badge admin-status-badge--active">Visible</span>}
                </td>
                <td className="admin-table-actions-col">
                  <div className="admin-action-wrap">
                    <button
                      className="admin-icon-btn"
                      onClick={() => setMenuOpenId(menuOpenId === t.tripId ? null : t.tripId)}
                      aria-label="Trip actions"
                      title="Trip actions"
                    >
                      <MoreVertical size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    {menuOpenId === t.tripId && (
                      <div className="admin-action-menu">
                        <button onClick={() => { setPreviewTrip(t); setMenuOpenId(null); }}>
                          <Eye size={14}/> Preview
                        </button>
                        <button onClick={() => handleHide(t)} disabled={acting}>
                          {t.hidden ? <><EyeOff size={14}/> Unhide</> : <><EyeOff size={14}/> Hide</>}
                        </button>
                        <button className="admin-action-menu-danger" onClick={() => { setConfirmDelete(t); setMenuOpenId(null); }} disabled={acting}>
                          <Trash2 size={14}/> Delete Trip
                        </button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {previewTrip && (
        <TripPreviewModal
          trip={previewTrip}
          onClose={() => setPreviewTrip(null)}
          onDelete={(t) => { setPreviewTrip(null); setConfirmDelete(t); }}
          acting={acting}
        />
      )}

      {confirmDelete && (
        <div className="admin-modal-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete this trip?</h2>
            <p>
              Trip <strong>"{confirmDelete.title}"</strong> belonging to <strong>{confirmDelete.ownerEmail || 'unknown owner'}</strong> will be deleted.
              The owner will no longer see it in their trips list.
            </p>
            <div className="admin-modal-actions">
              <button className="btn-ghost" onClick={() => setConfirmDelete(null)} disabled={acting}>Cancel</button>
              <button className="btn-danger" onClick={() => handleDelete(confirmDelete)} disabled={acting}>
                {acting ? 'Deleting…' : 'Delete Trip'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
