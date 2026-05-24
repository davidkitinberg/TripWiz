import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Map, Settings, LogOut, Shield } from 'lucide-react';
import { signOut } from '../services/auth';

const NAV = [
  { to: '/admin',          end: true,  icon: LayoutDashboard, label: 'Overview' },
  { to: '/admin/users',    end: false, icon: Users,           label: 'User Management' },
  { to: '/admin/trips',    end: false, icon: Map,             label: 'Trip Moderation' },
  { to: '/admin/trending', end: false, icon: Settings,        label: 'Platform Settings' },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  function handleSignOut() { signOut(); navigate('/admin-login', { replace: true }); }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">

        {/* Brand */}
        <div className="admin-sidebar-brand">
          <div className="admin-sidebar-brand-icon">
            <Shield size={18} strokeWidth={2.3} />
          </div>
          <div>
            <div className="admin-sidebar-brand-title">TripWiz</div>
            <div className="admin-sidebar-brand-sub">Admin Console</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="admin-sidebar-nav">
          <p className="admin-nav-section-label">Main Menu</p>
          {NAV.map(({ to, end, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `admin-sidebar-link${isActive ? ' admin-sidebar-link--active' : ''}`
              }
            >
              <span className="admin-link-icon"><Icon size={16} strokeWidth={2} /></span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer: system status + sign out */}
        <div className="admin-sidebar-footer">
          <div className="admin-sys-status">
            <span className="admin-sys-dot" />
            <span className="admin-sys-label">All systems online</span>
          </div>
          <button className="admin-sidebar-signout" onClick={handleSignOut}>
            <LogOut size={15} strokeWidth={2} />
            Sign Out
          </button>
        </div>

      </aside>

      <main className="admin-content">
        <Outlet />
      </main>
    </div>
  );
}
