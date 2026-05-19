import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated } from './services/auth';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import TripsPage from './pages/TripsPage';
import TripPage from './pages/TripPage';

function PrivateRoute({ children }) {
  const [auth, setAuth] = useState(null);
  const location = useLocation();

  useEffect(() => {
    if (location.state?.justSignedIn) {
      setAuth(true);
      return;
    }
    isAuthenticated().then(setAuth);
  }, [location.state?.justSignedIn]);

  if (auth === null) return <div className="loading">Loading…</div>;
  return auth ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/trips"
          element={
            <PrivateRoute>
              <TripsPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/trips/:tripId"
          element={
            <PrivateRoute>
              <TripPage />
            </PrivateRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
