import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Lock } from 'lucide-react';
import { signIn, signOut } from '../services/auth';
import { isCurrentUserAdmin } from '../services/admin';

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email, password);
      const isAdmin = await isCurrentUserAdmin();
      if (!isAdmin) {
        signOut();
        setError('This account does not have admin access.');
        return;
      }
      navigate('/admin', { replace: true });
    } catch (err) {
      if (err.code === 'NotAuthorizedException') setError('Incorrect email or password.');
      else if (err.code === 'UserNotFoundException') setError('No account found with that email.');
      else if (err.code === 'UserNotConfirmedException') setError('Email not verified. Sign in to TripWiz first to confirm.');
      else setError(err.message || 'Sign-in failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <button className="admin-login-back" onClick={() => navigate('/')}>← Back to TripWiz</button>

        <div className="admin-login-brand">
          <Shield size={36} strokeWidth={2} />
          <h1>TripWiz Admin</h1>
          <p>Restricted area — authorized personnel only.</p>
        </div>

        {error && (
          <div className="admin-login-error">
            <Lock size={14} /> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="admin-login-form">
          <label>Email</label>
          <input
            type="email"
            placeholder="admin@tripwiz.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="email"
          />
          <label>Password</label>
          <input
            type="password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
          <button type="submit" disabled={loading} className="admin-login-submit">
            {loading ? 'Authenticating…' : 'Sign In to Admin Portal'}
          </button>
        </form>

        <p className="admin-login-footnote">
          Need an admin account? Contact the platform owner.
        </p>
      </div>
    </div>
  );
}
