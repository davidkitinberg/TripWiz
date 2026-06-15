import React, { useEffect, useState, useMemo } from 'react';
import { Users, Map, Plane, UserPlus, FileText, TrendingUp, Activity } from 'lucide-react';
import { api } from '../services/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(when) {
  if (!when) return '';
  const diff = Date.now() - new Date(when).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return d < 30 ? `${d}d ago` : new Date(when).toLocaleDateString();
}

function buildWeeklyData(activity = []) {
  const now = Date.now();
  const buckets = new Array(7).fill(0);
  for (const a of activity) {
    const ageDays = Math.floor((now - new Date(a.when).getTime()) / 86400000);
    if (ageDays >= 0 && ageDays < 7) buckets[6 - ageDays]++;
  }
  return buckets;
}

function getDayLabels() {
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    labels.push(i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }));
  }
  return labels;
}

// ─── SVG Area Chart ───────────────────────────────────────────────────────────

function AreaChart({ data, labels }) {
  const W = 460, H = 90, PX = 16, PY = 14;
  const n = data.length;
  const maxV = Math.max(...data, 1);
  const xStep = (W - 2 * PX) / (n - 1);

  const pts = data.map((v, i) => ({
    x: PX + i * xStep,
    y: PY + (1 - v / maxV) * (H - 2 * PY),
  }));

  // Smooth bezier — midpoint control points
  let linePath = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < n; i++) {
    const cpx = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1);
    linePath += ` C ${cpx} ${pts[i - 1].y.toFixed(1)} ${cpx} ${pts[i].y.toFixed(1)} ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  const areaPath = `${linePath} L ${pts[n - 1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z`;

  const total = data.reduce((a, b) => a + b, 0);

  return (
    <div className="admin-chart-card">
      <div className="admin-chart-card-header">
        <div>
          <div className="admin-chart-title">Activity — Last 7 Days</div>
          <div className="admin-chart-sub">
            {total} events tracked this week
          </div>
        </div>
        <div className="admin-chart-badge">
          <TrendingUp size={13} strokeWidth={2.2} />
          Live
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="admin-chart-svg">
        <defs>
          <linearGradient id="chartAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PX} y1={PY + f * (H - 2 * PY)}
            x2={W - PX} y2={PY + f * (H - 2 * PY)}
            stroke="rgba(255,255,255,0.05)" strokeWidth="1"
          />
        ))}
        {/* Area fill */}
        <path d={areaPath} fill="url(#chartAreaGrad)" />
        {/* Line */}
        <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" />
        {/* Data points */}
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="4" fill="#6366f1" opacity="0.25" />
            <circle cx={p.x} cy={p.y} r="2.5" fill="#818cf8" stroke="#020617" strokeWidth="1.5" />
          </g>
        ))}
      </svg>

      {/* Day labels */}
      <div className="admin-chart-days">
        {labels.map((l, i) => (
          <span key={i} className="admin-chart-day-label">{l}</span>
        ))}
      </div>
    </div>
  );
}

// ─── Destination Ring Charts ──────────────────────────────────────────────────

const RING_COLORS  = [
  ['#6366f1', '#8b5cf6'],
  ['#3b82f6', '#06b6d4'],
  ['#f59e0b', '#ef4444'],
  ['#10b981', '#06b6d4'],
];
const RING_PCTS = [0.87, 0.71, 0.58, 0.44];

function DestRing({ city, tag, pct, colors, index }) {
  const r = 28, cx = 40, cy = 40;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  const gradId = `rg${index}`;

  return (
    <div className="admin-ring-item">
      <div className="admin-ring-svg-wrap">
        <svg width="80" height="80" viewBox="0 0 80 80">
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={colors[0]} />
              <stop offset="100%" stopColor={colors[1]} />
            </linearGradient>
          </defs>
          {/* Track */}
          <circle cx={cx} cy={cy} r={r} fill="none"
            stroke="rgba(255,255,255,0.07)" strokeWidth="6" />
          {/* Progress */}
          <circle cx={cx} cy={cy} r={r} fill="none"
            stroke={`url(#${gradId})`} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={`${dash.toFixed(1)} ${(circ - dash).toFixed(1)}`}
            transform="rotate(-90 40 40)"
            style={{ filter: `drop-shadow(0 0 4px ${colors[0]}66)` }}
          />
        </svg>
        <div className="admin-ring-pct">{Math.round(pct * 100)}%</div>
      </div>
      <div className="admin-ring-city">{city}</div>
      <div className="admin-ring-tag">{tag}</div>
    </div>
  );
}

function TrendingRings({ destinations }) {
  const items = destinations.slice(0, 4);

  return (
    <div className="admin-chart-card">
      <div className="admin-chart-card-header">
        <div>
          <div className="admin-chart-title">Top Destinations</div>
          <div className="admin-chart-sub">Relative popularity</div>
        </div>
      </div>
      <div className="admin-rings-grid">
        {items.map((d, i) => (
          <DestRing
            key={d.city}
            city={d.city}
            tag={d.tag || d.country}
            pct={RING_PCTS[i] || 0.4}
            colors={RING_COLORS[i]}
            index={i}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Metric Card ─────────────────────────────────────────────────────────────

function MetricCard({ icon, label, value, trend, tone }) {
  return (
    <div className={`admin-metric-card admin-metric-card--${tone}`}>
      <div className="admin-metric-icon">{icon}</div>
      <div className="admin-metric-body">
        <div className="admin-metric-label">{label}</div>
        <div className="admin-metric-value">{value}</div>
        {trend && (
          <div className={`admin-metric-trend admin-metric-trend--${trend.dir}`}>
            {trend.dir === 'up' && '↑ '}
            {trend.dir === 'down' && '↓ '}
            {trend.label}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Activity Feed ────────────────────────────────────────────────────────────

function ActivityFeed({ activity, loading }) {
  return (
    <div className="admin-feed-section">
      <div className="admin-feed-header">
        <div className="admin-chart-title">Recent Activity</div>
        <div className="admin-feed-count-badge">
          <Activity size={12} strokeWidth={2} />
          Live feed
        </div>
      </div>

      {loading && (
        <div className="admin-feed-list">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="admin-feed-item admin-feed-item--skeleton">
              <div className="admin-feed-dot-skeleton" />
              <div className="admin-feed-lines">
                <div className="admin-skeleton-line" style={{ width: `${60 + i * 8}%` }} />
                <div className="admin-skeleton-line admin-skeleton-line--sm" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && activity.length === 0 && (
        <p className="admin-muted" style={{ padding: '1rem 0' }}>No recent activity yet.</p>
      )}

      {!loading && (
        <div className="admin-feed-list">
          {activity.slice(0, 10).map((a, i) => (
            <div key={i} className="admin-feed-item">
              <div className="admin-feed-dot-wrap">
                <span className={`admin-feed-dot admin-feed-dot--${a.type}`} />
                {i < activity.length - 1 && <span className="admin-feed-line" />}
              </div>
              <div className="admin-feed-content">
                <div className="admin-feed-msg">{a.message}</div>
                {a.type === 'trip' && a.ownerEmail && (
                  <div className="admin-feed-owner">{a.ownerEmail}</div>
                )}
                <div className="admin-feed-when">{relativeTime(a.when)}</div>
              </div>
              <div className={`admin-feed-type-pill admin-feed-type-pill--${a.type}`}>
                {a.type === 'user' ? <UserPlus size={11} strokeWidth={2} /> : <FileText size={11} strokeWidth={2} />}
                {a.type}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// [Feature #43] Admin metrics dashboard — totals, 7-day activity chart, rings, feed
export default function AdminOverviewPage() {
  const [metrics,   setMetrics]   = useState(null);
  const [trending,  setTrending]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getAdminMetrics(),
      api.getTrending().catch(() => ({ destinations: [] })),
    ]).then(([m, t]) => {
      if (cancelled) return;
      setMetrics(m);
      setTrending(Array.isArray(t) ? t : (t.destinations || []));
      setLoading(false);
    }).catch((err) => {
      if (!cancelled) { setError(err.message || 'Failed to load metrics'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  const dayLabels   = useMemo(getDayLabels, []);
  const weeklyData  = useMemo(() => buildWeeklyData(metrics?.recentActivity), [metrics]);

  const weekUsers = useMemo(() => (
    (metrics?.recentActivity || []).filter(
      (a) => a.type === 'user' && Date.now() - new Date(a.when).getTime() < 7 * 86400000
    ).length
  ), [metrics]);

  const weekTrips = useMemo(() => (
    (metrics?.recentActivity || []).filter(
      (a) => a.type === 'trip' && Date.now() - new Date(a.when).getTime() < 7 * 86400000
    ).length
  ), [metrics]);

  return (
    <div>
      {/* Page header */}
      <header className="admin-page-header">
        <div>
          <h1>Overview</h1>
          <p>Platform health at a glance</p>
        </div>
        <div className="admin-page-header-aside">
          <div className="admin-header-live">
            <span className="admin-header-live-dot" />
            Live
          </div>
        </div>
      </header>

      {error && <div className="admin-error-banner" onClick={() => setError('')}>{error}</div>}

      {/* Metric cards */}
      <div className="admin-metric-grid">
        <MetricCard
          icon={<Users size={20} strokeWidth={2} />}
          label="Total Users"
          value={loading ? '—' : (metrics?.totalUsers ?? 0).toLocaleString()}
          tone="indigo"
          trend={weekUsers > 0
            ? { dir: 'up',     label: `+${weekUsers} this week` }
            : { dir: 'neutral', label: 'No change this week' }}
        />
        <MetricCard
          icon={<Map size={20} strokeWidth={2} />}
          label="Total Trips"
          value={loading ? '—' : (metrics?.totalTrips ?? 0).toLocaleString()}
          tone="violet"
          trend={weekTrips > 0
            ? { dir: 'up',     label: `+${weekTrips} this week` }
            : { dir: 'neutral', label: 'No change this week' }}
        />
        <MetricCard
          icon={<Plane size={20} strokeWidth={2} />}
          label="Active Trips"
          value={loading ? '—' : (metrics?.activeTrips ?? 0).toLocaleString()}
          tone="emerald"
          trend={{ dir: 'neutral', label: 'Starting within 24h' }}
        />
      </div>

      {/* Charts row */}
      <div className="admin-charts-row">
        <AreaChart data={weeklyData} labels={dayLabels} />
        <TrendingRings destinations={trending} />
      </div>

      {/* Activity feed */}
      <ActivityFeed
        activity={metrics?.recentActivity || []}
        loading={loading}
      />
    </div>
  );
}
