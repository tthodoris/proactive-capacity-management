import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Boxes, ChevronDown, ChevronRight, Gauge, Plus } from 'lucide-react'
import { MetricCard, SeverityBadge, StatusBadge } from '../components/Badges'
import { RetrievalLogEntryView } from '../components/RetrievalLogEntryView'
import { useApp } from '../context/AppContext'
import { formatRelative } from '../lib/format'

export function DashboardPage() {
  const navigate = useNavigate()
  const {
    constraints,
    impactResults,
    alerts,
    engagements,
    customers,
    users,
    portfolioCustomerIds,
    canSeeAllPortfolios,
    user,
    retrievalJobs,
    retrievalLog,
    activeRetrievalCount,
  } = useApp()

  const [activityExpanded, setActivityExpanded] = useState(false)

  const active = constraints.filter((c) => c.status !== 'Resolved')
  const portfolioImpacts = impactResults.filter((i) => portfolioCustomerIds.includes(i.customerId))
  const affectedCustomers = new Set(portfolioImpacts.map((i) => i.customerId)).size
  const unread = alerts.filter((a) => !a.read && (canSeeAllPortfolios || a.csaOwnerId === user.id)).length
  const openEngagements = engagements.filter((e) => e.status !== 'Closed').length

  const topConstraints = active.slice(0, 4)
  const recentAlerts = alerts
    .filter((a) => canSeeAllPortfolios || a.csaOwnerId === user.id)
    .slice(0, 4)

  const runningJobs = retrievalJobs.filter(
    (job) => job.status === 'running' || job.status === 'queued',
  )
  const recentFailedJobs = retrievalJobs
    .filter((job) => job.error && (job.status === 'failed' || job.status === 'partial'))
    .slice(0, 5)

  useEffect(() => {
    if (activeRetrievalCount > 0) setActivityExpanded(true)
  }, [activeRetrievalCount])

  return (
    <div className="stack">
      <div className="scenario-banner">
        <div>
          <h4>Illustrative scenario active</h4>
          <p>
            Dsv5 VM series constrained in West Europe and North Europe — impact analysis has flagged{' '}
            {new Set(impactResults.filter((i) => i.constraintId === 'cc-dsv5-eu').map((i) => i.customerId)).size}{' '}
            customers. Engage Capacity early before deployments fail.
          </p>
        </div>
        <Link className="btn btn-secondary" to="/constraints/cc-dsv5-eu">
          Review impact <ArrowRight size={16} />
        </Link>
      </div>

      <div className="page-hero">
        <div>
          <h3>{canSeeAllPortfolios ? 'Cross-portfolio pulse' : 'Your portfolio pulse'}</h3>
          <p>
            A single place to see constrained SKUs, exposed customers, and the path to Capacity-team
            engagement.
          </p>
        </div>
        <Link className="btn btn-primary" to="/constraints/new">
          <Plus size={16} /> Record constraint
        </Link>
      </div>

      <div className="metrics">
        <MetricCard label="Active constraints" value={active.length} hint="Must-track SKUs" delay={0} />
        <MetricCard
          label="Affected customers"
          value={affectedCustomers}
          hint={canSeeAllPortfolios ? 'All portfolios' : 'Your CSA portfolio'}
          delay={60}
        />
        <MetricCard label="Unread alerts" value={unread} hint="Teams / email / in-app" delay={120} />
        <MetricCard
          label="Open engagements"
          value={openEngagements}
          hint="Capacity team follow-ups"
          delay={180}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <button
            type="button"
            className="collapsible-trigger panel-header-trigger"
            aria-expanded={activityExpanded}
            onClick={() => setActivityExpanded((prev) => !prev)}
          >
            <span className="collapsible-trigger-main">
              {activityExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span>
                <h4>Azure retrieval activity</h4>
                <p>
                  Background inventory and quota collections by customer and subscription —
                  {activityExpanded ? ' click to collapse' : ' click to expand'}
                </p>
              </span>
            </span>
            {activeRetrievalCount > 0 ? (
              <span className="pill pill-investigation">{activeRetrievalCount} running</span>
            ) : (
              <span className="pill pill-neutral">
                {activityExpanded ? 'Hide log' : `Show log${retrievalLog.length ? ` (${retrievalLog.length})` : ''}`}
              </span>
            )}
          </button>
        </div>
        {activityExpanded ? (
          <div className="panel-body stack">
            {recentFailedJobs.length > 0 ? (
              <div className="stack" style={{ gap: '0.45rem' }}>
                {recentFailedJobs.map((job) => (
                  <div key={`fail-${job.id}`} className="inline-error">
                    <strong>
                      {job.kind === 'inventory' ? 'Inventory' : 'Quotas'} · {job.customerName} ·{' '}
                      {job.status}
                    </strong>
                    <div>{job.error}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {runningJobs.length > 0 ? (
              <div className="retrieval-active-grid">
                {runningJobs.map((job) => {
                  const pct = job.progressTotal
                    ? Math.round((job.progressCurrent / job.progressTotal) * 100)
                    : 0
                  return (
                    <div key={job.id} className="retrieval-active-card">
                      <div className="retrieval-active-card-head">
                        <strong>
                          {job.kind === 'inventory' ? (
                            <>
                              <Boxes size={14} /> Inventory
                            </>
                          ) : (
                            <>
                              <Gauge size={14} /> Quotas
                            </>
                          )}
                        </strong>
                        <span className="pill pill-investigation">{job.status}</span>
                      </div>
                      <div className="muted">
                        {job.customerName} · {job.progressCurrent}/{job.progressTotal} subscriptions
                      </div>
                      <div className="muted">
                        Started by {job.initiatedByName} · {formatRelative(job.startedAt)}
                      </div>
                      <div className="progress" style={{ marginTop: '0.55rem' }}>
                        <span style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}

            <div className="retrieval-log" aria-live="polite" aria-relevant="additions">
              {retrievalLog.length === 0 ? (
                <div className="empty">
                  No retrieval activity yet. Start inventory or quota collection from{' '}
                  <Link to="/connect">Azure Connect</Link>.
                </div>
              ) : (
                retrievalLog.map((entry) => (
                  <RetrievalLogEntryView key={entry.id} entry={entry} showUser />
                ))
              )}
            </div>
          </div>
        ) : null}
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Active capacity constraints</h4>
              <p>Severity, scope, and investigation status</p>
            </div>
            <Link className="btn btn-ghost" to="/constraints">
              View all
            </Link>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Regions</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {topConstraints.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/constraints/${c.id}`)}>
                    <td>
                      <strong>{c.sku}</strong>
                      <div className="muted">{c.resourceType}</div>
                    </td>
                    <td>{c.regions.join(', ')}</td>
                    <td>
                      <SeverityBadge severity={c.severity} />
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="muted">{formatRelative(c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Recent alerts</h4>
              <p>Routed by customer → CSA ownership</p>
            </div>
            <Link className="btn btn-ghost" to="/alerts">
              Open inbox
            </Link>
          </div>
          <div className="panel-body stack">
            {recentAlerts.length === 0 ? (
              <div className="empty">No alerts in your current view.</div>
            ) : (
              recentAlerts.map((alert) => {
                const customer = customers.find((c) => c.id === alert.customerId)
                const owner = users.find((u) => u.id === alert.csaOwnerId)
                return (
                  <div key={alert.id} className={`alert-row${alert.read ? '' : ' unread'}`}>
                    <div style={{ flex: 1 }}>
                      <strong>{alert.title}</strong>
                      <div className="muted" style={{ marginTop: '0.25rem' }}>
                        {customer?.name} · CSA {owner?.name} · {alert.channel} ·{' '}
                        {formatRelative(alert.createdAt)}
                      </div>
                    </div>
                    {!alert.read ? <span className="pill pill-ok">New</span> : null}
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
