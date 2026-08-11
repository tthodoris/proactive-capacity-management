import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity,
  BarChart3,
  Bell,
  Boxes,
  ChevronDown,
  ChevronRight,
  Gauge,
  History,
  Layers,
  LayoutDashboard,
  MapPinned,
  PlugZap,
  Settings2,
  ShieldAlert,
  Trophy,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useApp } from '../context/AppContext'
import { RewardToast } from './RewardToast'
import type { UserRole } from '../types'

type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  children?: Array<{ to: string; label: string; icon: typeof LayoutDashboard }>
}

const nav: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/connect', label: 'Azure Connect', icon: PlugZap },
  { to: '/constraints', label: 'Constraints', icon: ShieldAlert },
  {
    to: '/customers',
    label: 'Customers',
    icon: Users,
    children: [
      { to: '/customers', label: 'Portfolio', icon: Users },
      { to: '/customers/risk', label: 'Risk scores', icon: ShieldAlert },
    ],
  },
  { to: '/inventory', label: 'Inventory', icon: Boxes },
  { to: '/quotas', label: 'Quotas', icon: Gauge },
  { to: '/quota-groups', label: 'Quota groups', icon: Layers },
  {
    to: '/region-evaluation',
    label: 'Region Evaluation',
    icon: MapPinned,
    children: [
      { to: '/region-evaluation', label: 'Run evaluation', icon: MapPinned },
      { to: '/region-evaluation/history', label: 'Evaluations', icon: History },
      { to: '/region-evaluation/cost-analysis', label: 'Cost analysis', icon: BarChart3 },
    ],
  },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/alerts', label: 'Alerts & Engagement', icon: Bell },
  { to: '/rewards', label: 'Rewards', icon: Trophy },
  { to: '/admin', label: 'Admin', icon: Settings2 },
]

const titles: Record<string, { title: string; subtitle: string }> = {
  '/': {
    title: 'Capacity overview',
    subtitle: 'Active constraints, exposure, and proactive engagement across your portfolio.',
  },
  '/connect': {
    title: 'Azure Connect',
    subtitle: 'Connect a tenant, select subscriptions, and persist inventory and quota datasets.',
  },
  '/constraints': {
    title: 'Capacity constraints',
    subtitle: 'Record constrained SKUs and track investigation status.',
  },
  '/constraints/new': {
    title: 'Record a constraint',
    subtitle: 'Capture a constrained SKU and trigger automated impact analysis.',
  },
  '/customers': {
    title: 'Customers',
    subtitle: 'Managed customer portfolio with CSA ownership and sync freshness.',
  },
  '/customers/risk': {
    title: 'Customer capacity risk',
    subtitle:
      'Red / Amber / Green triage from open constraints, quota headroom (excl. Network Watchers), and SKU concentration; region concentration is advisory only.',
  },
  '/inventory': {
    title: 'Resource inventory',
    subtitle: 'Compute inventory from internal systems and consent-based tenant sync.',
  },
  '/quotas': {
    title: 'Quotas',
    subtitle: 'Individual quota line items by subscription and region.',
  },
  '/quota-groups': {
    title: 'Quota groups',
    subtitle:
      'Azure Quota Groups that pool and allocate quota across subscriptions in a management group.',
  },
  '/region-evaluation': {
    title: 'Region evaluation',
    subtitle:
      'Compare current inventory SKUs and services against preferred target regions for potential deployment.',
  },
  '/region-evaluation/history': {
    title: 'Evaluations',
    subtitle: 'Saved region evaluations by customer, with links to cost analysis.',
  },
  '/region-evaluation/cost-analysis': {
    title: 'Cost analysis',
    subtitle:
      'Detailed source vs target retail cost comparison, subscription totals, and bar charts.',
  },
  '/reports': {
    title: 'Reports',
    subtitle: 'Build detailed or aggregated views across inventory, quotas, quota groups, and constraints.',
  },
  '/alerts': {
    title: 'Alerts & engagement',
    subtitle: 'CSA notifications and Capacity team engagement tracking.',
  },
  '/rewards': {
    title: 'Rewards',
    subtitle: 'Bonus points for proactive constraint recording, engagement, and resolution.',
  },
  '/admin': {
    title: 'Administration',
    subtitle: 'Roles, data-source connections, and sync schedule.',
  },
}

function resolveTitle(pathname: string) {
  if (pathname.startsWith('/constraints/') && pathname !== '/constraints/new') {
    return {
      title: 'Constraint detail',
      subtitle: 'Impact analysis, status history, and customer exposure.',
    }
  }
  if (pathname === '/customers/risk') {
    return titles['/customers/risk']
  }
  if (pathname.startsWith('/customers/risk/')) {
    return {
      title: 'Capacity risk detail',
      subtitle:
        'Drivers, concentration warnings, charts, and quotas to raise to reduce risk.',
    }
  }
  if (pathname.startsWith('/customers/')) {
    return {
      title: 'Customer detail',
      subtitle: 'Subscriptions, inventory, quotas, and active exposure.',
    }
  }
  return titles[pathname] ?? { title: 'PCM', subtitle: 'Proactive Capacity Management' }
}

function isRegionEvalPath(pathname: string) {
  return pathname === '/region-evaluation' || pathname.startsWith('/region-evaluation/')
}

function isCustomersPath(pathname: string) {
  return pathname === '/customers' || pathname.startsWith('/customers/')
}

function isGroupPath(item: NavItem, pathname: string) {
  if (item.to === '/region-evaluation') return isRegionEvalPath(pathname)
  if (item.to === '/customers') return isCustomersPath(pathname)
  return false
}

export function AppLayout() {
  const { user, setRole, alerts, getUserPoints } = useApp()
  const location = useLocation()
  const meta = resolveTitle(location.pathname)
  const unread = alerts.filter((a) => !a.read && a.csaOwnerId === user.id).length
  const points = getUserPoints(user.id)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => ({
    '/region-evaluation': isRegionEvalPath(location.pathname),
    '/customers': isCustomersPath(location.pathname),
  }))

  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev }
      if (isRegionEvalPath(location.pathname)) next['/region-evaluation'] = true
      if (isCustomersPath(location.pathname)) next['/customers'] = true
      return next
    })
  }, [location.pathname])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">PCM</div>
          <div>
            <h1>Proactive Capacity</h1>
            <p>Microsoft internal · Entra ID</p>
          </div>
        </div>

        <nav className="nav-section">
          <div className="nav-label">Workspace</div>
          {nav.map((item) => {
            const Icon = item.icon
            if (item.children?.length) {
              const sectionActive = isGroupPath(item, location.pathname)
              const menuOpen = Boolean(openGroups[item.to])
              return (
                <div key={item.to} className="nav-group">
                  <button
                    type="button"
                    className={`nav-link nav-group-trigger${sectionActive ? ' active' : ''}`}
                    aria-expanded={menuOpen}
                    onClick={() =>
                      setOpenGroups((prev) => ({ ...prev, [item.to]: !prev[item.to] }))
                    }
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {menuOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  {menuOpen ? (
                    <div className="nav-sub">
                      {item.children.map((child) => {
                        const ChildIcon = child.icon
                        return (
                          <NavLink
                            key={child.to}
                            to={child.to}
                            end={
                              child.to === '/region-evaluation' || child.to === '/customers'
                            }
                            className={({ isActive }) =>
                              `nav-link nav-sub-link${isActive ? ' active' : ''}`
                            }
                          >
                            <ChildIcon size={16} />
                            <span>{child.label}</span>
                          </NavLink>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            }

            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.to === '/alerts' && unread > 0 ? <span className="badge">{unread}</span> : null}
                {item.to === '/rewards' ? <span className="badge">{points}</span> : null}
              </NavLink>
            )
          })}
        </nav>

        <div className="sidebar-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
            <Activity size={16} />
            <strong style={{ fontSize: '0.86rem' }}>Demo identity</strong>
          </div>
          <p className="muted" style={{ margin: '0.35rem 0 0', color: '#9fb4c6' }}>
            Switch role to preview RBAC views.
          </p>
          <select
            className="role-select"
            value={user.role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            <option>CSA</option>
            <option>Capacity Manager</option>
            <option>Administrator</option>
          </select>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h2>{meta.title}</h2>
            <p>{meta.subtitle}</p>
          </div>
          <div className="topbar-actions">
            <NavLink to="/rewards" className="points-chip">
              <Trophy size={16} />
              <span>{points} pts</span>
            </NavLink>
            <div className="user-chip">
              <div className="avatar">{user.avatarInitials}</div>
              <div>
                <strong>{user.name}</strong>
                <span>
                  {user.role} · signed in via Entra ID
                </span>
              </div>
            </div>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <RewardToast />
    </div>
  )
}
