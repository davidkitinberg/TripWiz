import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated } from './services/auth';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import TripsPage from './pages/TripsPage';
import TripPage from './pages/TripPage';
import AccountSettings from './pages/AccountSettings';
import AdminLoginPage from './pages/AdminLoginPage';
import UnauthorizedPage from './pages/UnauthorizedPage';
import AdminLayout from './components/AdminLayout';
import AdminRoute from './components/AdminRoute';
import AdminOverviewPage from './pages/AdminOverviewPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminTripsPage from './pages/AdminTripsPage';
import AdminTrendingPage from './pages/AdminTrendingPage';

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
        <Route path="/admin-login" element={<AdminLoginPage />} />
        <Route path="/unauthorized" element={<UnauthorizedPage />} />
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
        <Route
          path="/settings"
          element={
            <PrivateRoute>
              <AccountSettings />
            </PrivateRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminLayout />
            </AdminRoute>
          }
        >
          <Route index element={<AdminOverviewPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="trips" element={<AdminTripsPage />} />
          <Route path="trending" element={<AdminTrendingPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
