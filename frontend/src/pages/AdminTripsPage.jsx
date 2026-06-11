import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoreHorizontal, Eye, Trash2, Search } from 'lucide-react';
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

export default function AdminTripsPage() {
  const navigate = useNavigate();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 350);
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
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

  // [Feature #49] Delete a trip from the platform (admin moderation)
  function handleDelete(t) {
    runAction(api.deleteAdminTrip(t.tripId), () =>
      setTrips((prev) => prev.filter((x) => x.tripId !== t.tripId))
    );
    setConfirmDelete(null);
  }

  function handleView(t) {
    setMenuOpenId(null);
    navigate(`/trips/${t.tripId}/overview`);
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
                  <div className="admin-trip-title">{t.title}</div>
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
                      aria-label="Actions"
                    >
                      <MoreHorizontal size={18} />
                    </button>
                    {menuOpenId === t.tripId && (
                      <div className="admin-action-menu">
                        <button onClick={() => handleView(t)}>
                          <Eye size={14}/> View Trip
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
