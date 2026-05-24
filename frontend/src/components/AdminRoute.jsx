import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated } from '../services/auth';
import { isCurrentUserAdmin } from '../services/admin';

export default function AdminRoute({ children }) {
  const [state, setState] = useState({ checked: false, signedIn: false, isAdmin: false });
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const signedIn = await isAuthenticated();
      if (!signedIn) {
        if (!cancelled) setState({ checked: true, signedIn: false, isAdmin: false });
        return;
      }
      const admin = await isCurrentUserAdmin();
      if (!cancelled) setState({ checked: true, signedIn: true, isAdmin: admin });
    })();
    return () => { cancelled = true; };
  }, [location.pathname]);

  if (!state.checked) return <div className="loading">Checking access…</div>;
  if (!state.signedIn) return <Navigate to="/admin-login" replace />;
  if (!state.isAdmin)  return <Navigate to="/unauthorized" replace />;
  return children;
}
