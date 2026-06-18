/**
 * @fileoverview Admin user management: list, suspend, promote, and delete users.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical, ShieldCheck, ShieldOff, UserX, UserCheck, Trash2, Eye } from 'lucide-react';
import { api } from '../services/api';

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmBlock, setConfirmBlock] = useState(null);
  const [acting, setActing] = useState(false);
  const tableRef = useRef(null);

  const load = () => {
    setLoading(true);
    api.getAdminUsers()
      .then((res) => setUsers(res.items || []))
      .catch((err) => setError(err.message || 'Failed to load users'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

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
      load();
    } catch (err) {
      setError(err.message || 'Action failed');
      load();
    } finally {
      setActing(false);
      setMenuOpenId(null);
    }
  }

  // [Feature #44] Block / unblock a user (disable/enable their Cognito account)
  function handleBlock(u) {
    runAction(
      u.enabled ? api.suspendUser(u.userId) : api.unsuspendUser(u.userId),
      () => setUsers((prev) => prev.map((x) => x.userId === u.userId ? { ...x, enabled: !x.enabled } : x))
    );
    setConfirmBlock(null);
  }

  // [Feature #46] Permanently delete a user account and purge all their data
  function handleDelete(u) {
    runAction(api.deleteUserAccount(u.userId), () =>
      setUsers((prev) => prev.filter((x) => x.userId !== u.userId))
    );
    setConfirmDelete(null);
  }

  return (
    <div>
      <header className="admin-page-header">
        <h1>User Management</h1>
        <p>{users.length} registered user{users.length === 1 ? '' : 's'}</p>
      </header>

      {error && <div className="admin-error-banner" onClick={() => setError('')}>{error} (click to dismiss)</div>}

      <div className="admin-table-wrap" ref={tableRef}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>User ID</th>
              <th>Email</th>
              <th>Registered</th>
              <th>Trips</th>
              <th>Status</th>
              <th>Role</th>
              <th className="admin-table-actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan="7" className="admin-muted" style={{ padding: '2rem', textAlign: 'center' }}>Loading users…</td></tr>
            )}
            {!loading && users.length === 0 && (
              <tr><td colSpan="7" className="admin-muted" style={{ padding: '2rem', textAlign: 'center' }}>No users yet.</td></tr>
            )}
            {users.map((u) => (
              <tr key={u.userId}>
                <td className="admin-mono admin-truncate" title={u.userId}>{(u.userId || '').slice(0, 8)}…</td>
                <td>{u.email}</td>
                <td>{fmtDate(u.createdAt)}</td>
                <td>{u.tripsCount}</td>
                <td>
                  {u.enabled
                    ? <span className="admin-status-badge admin-status-badge--active">Active</span>
                    : <span className="admin-status-badge admin-status-badge--suspended">Blocked</span>}
                </td>
                <td>
                  {u.isAdmin
                    ? <span className="admin-status-badge admin-status-badge--admin">Admin</span>
                    : <span className="admin-status-badge admin-status-badge--user">User</span>}
                </td>
                <td className="admin-table-actions-col">
                  <div className="admin-action-wrap">
                    <button
                      className="admin-icon-btn"
                      onClick={() => setMenuOpenId(menuOpenId === u.userId ? null : u.userId)}
                      aria-label="User actions"
                      title="User actions"
                    >
                      <MoreVertical size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    {menuOpenId === u.userId && (
                      <div className="admin-action-menu">
                        <button onClick={() => { setConfirmBlock(u); setMenuOpenId(null); }} disabled={acting}>
                          {u.enabled ? <><UserX size={14}/> Block User</> : <><UserCheck size={14}/> Unblock User</>}
                        </button>
                        <button className="admin-action-menu-danger" onClick={() => { setConfirmDelete(u); setMenuOpenId(null); }} disabled={acting}>
                          <Trash2 size={14}/> Delete Account
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
            <h2>Delete user account?</h2>
            <p>This will permanently delete <strong>{confirmDelete.email}</strong>, all their trips, and all related data. This cannot be undone.</p>
            <div className="admin-modal-actions">
              <button className="btn-ghost" onClick={() => setConfirmDelete(null)} disabled={acting}>Cancel</button>
              <button className="btn-danger" onClick={() => handleDelete(confirmDelete)} disabled={acting}>
                {acting ? 'Deleting…' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmBlock && (
        <div className="admin-modal-backdrop" onClick={() => setConfirmBlock(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h2>{confirmBlock.enabled ? 'Block this user?' : 'Unblock this user?'}</h2>
            <p>
              {confirmBlock.enabled
                ? <>Blocked users cannot sign in or access TripWiz until they are unblocked.</>
                : <>This will restore access for <strong>{confirmBlock.email}</strong>.</>}
            </p>
            <div className="admin-modal-actions">
              <button className="btn-ghost" onClick={() => setConfirmBlock(null)} disabled={acting}>Cancel</button>
              <button
                className={confirmBlock.enabled ? 'btn-danger' : 'btn-primary'}
                onClick={() => handleBlock(confirmBlock)}
                disabled={acting}
              >
                {acting
                  ? (confirmBlock.enabled ? 'Blocking...' : 'Unblocking...')
                  : (confirmBlock.enabled ? 'Block User' : 'Unblock User')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
