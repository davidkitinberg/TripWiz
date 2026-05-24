import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

export default function UnauthorizedPage() {
  const navigate = useNavigate();
  return (
    <div className="unauthorized-page">
      <div className="unauthorized-card">
        <div className="unauthorized-icon">
          <ShieldAlert size={48} strokeWidth={1.8} />
        </div>
        <h1>403 — Access Denied</h1>
        <p>Your account does not have permission to access the TripWiz admin portal.</p>
        <div className="unauthorized-actions">
          <button className="btn-primary" onClick={() => navigate('/trips')}>Back to TripWiz</button>
          <button className="btn-ghost" onClick={() => navigate('/admin-login')}>Try a different account</button>
        </div>
      </div>
    </div>
  );
}
