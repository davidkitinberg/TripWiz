import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signIn, signUp, confirmSignUp } from '../services/auth';
import { api } from '../services/api';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();

  // Accept initial mode from navigation state (set by the home page modal)
  const [mode, setMode] = useState(location.state?.mode || 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function goAfterAuth() {
    const { destination, startDate, endDate } = location.state || {};
    if (destination?.name) {
      try {
        const res = await api.createTrip({
          title: destination.name,
          startDate: startDate || '',
          endDate: endDate || '',
        });
        navigate(`/trips/${res.tripId}`, { replace: true, state: { justSignedIn: true } });
        return;
      } catch {
        // fall through to trips list
      }
    }
    navigate('/trips', { replace: true, state: { justSignedIn: true } });
  }

  async function handleSignIn(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email, password);
      await goAfterAuth();
    } catch (err) {
      console.error('Sign-in error:', err);
      // If account exists but email not confirmed → go to confirm step
      if (err.code === 'UserNotConfirmedException') {
        setError('Your email is not verified yet. Enter the code we sent you.');
        setMode('confirm');
      } else if (err.code === 'NotAuthorizedException') {
        setError('Incorrect email or password. Please try again.');
      } else if (err.code === 'UserNotFoundException') {
        setError('No account found with that email. Create one below.');
      } else {
        setError(err.message || 'Sign in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signUp(email, password);
      setMode('confirm');
    } catch (err) {
      console.error('Sign-up error:', err);
      if (err.code === 'UsernameExistsException') {
        setError('An account with this email already exists. Sign in instead.');
      } else if (err.code === 'InvalidPasswordException') {
        setError('Password must be at least 8 characters and include uppercase, lowercase, and a number.');
      } else {
        setError(err.message || 'Sign up failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await confirmSignUp(email, code);
      // Auto-sign-in after confirmation if we have the password
      if (password) {
        try {
          await signIn(email, password);
          await goAfterAuth();
          return;
        } catch (_) {
          // If auto-sign-in fails, just go to sign-in form
        }
      }
      setError('');
      setMode('signin');
    } catch (err) {
      console.error('Confirm error:', err);
      if (err.code === 'CodeMismatchException') {
        setError('Incorrect code. Please check your email and try again.');
      } else if (err.code === 'ExpiredCodeException') {
        setError('Code expired. Please sign up again to receive a new code.');
      } else {
        setError(err.message || 'Confirmation failed.');
      }
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next) {
    setError('');
    setMode(next);
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <button
          className="link-btn"
          style={{ fontSize: '0.8125rem', marginBottom: '1rem' }}
          onClick={() => navigate('/')}
        >
          ← Back to home
        </button>
        <h1>TripWiz</h1>
        <p>Smart travel planning that adapts to reality</p>

        {error && (
          <div className="error-banner" style={{ marginTop: '0.75rem' }}>
            <span>{error}</span>
            <button onClick={() => setError('')} style={{ background: 'none', color: 'inherit', padding: '0 0.25rem' }}>×</button>
          </div>
        )}

        {mode === 'signin' && (
          <form onSubmit={handleSignIn} style={{ marginTop: '1.25rem' }}>
            <h2>Sign In</h2>
            <label>Email</label>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
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
            <button type="submit" disabled={loading} style={{ width: '100%', padding: '0.65rem', marginTop: '0.25rem' }}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
            <p className="switch-mode">
              New to TripWiz?{' '}
              <button type="button" className="link-btn" onClick={() => switchMode('signup')}>
                Create account
              </button>
            </p>
          </form>
        )}

        {mode === 'signup' && (
          <form onSubmit={handleSignUp} style={{ marginTop: '1.25rem' }}>
            <h2>Create Account</h2>
            <label>Email</label>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
            />
            <label>Password</label>
            <input
              type="password"
              placeholder="Min 8 chars, with uppercase + number"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <button type="submit" disabled={loading} style={{ width: '100%', padding: '0.65rem', marginTop: '0.25rem' }}>
              {loading ? 'Creating account…' : 'Create Account'}
            </button>
            <p className="switch-mode">
              Already have an account?{' '}
              <button type="button" className="link-btn" onClick={() => switchMode('signin')}>
                Sign in
              </button>
            </p>
          </form>
        )}

        {mode === 'confirm' && (
          <form onSubmit={handleConfirm} style={{ marginTop: '1.25rem' }}>
            <h2>Verify Your Email</h2>
            <p style={{ marginBottom: '1rem', fontSize: '0.875rem', color: 'var(--gray)' }}>
              We sent a 6-digit code to <strong>{email || 'your email'}</strong>.<br />
              Check your inbox (and spam folder).
            </p>
            <label>Verification code</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
              autoFocus
            />
            <button type="submit" disabled={loading} style={{ width: '100%', padding: '0.65rem', marginTop: '0.25rem' }}>
              {loading ? 'Verifying…' : 'Verify & Continue'}
            </button>
            <p className="switch-mode">
              <button type="button" className="link-btn" onClick={() => switchMode('signin')}>
                Back to sign in
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
