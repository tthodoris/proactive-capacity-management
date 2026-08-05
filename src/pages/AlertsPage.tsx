import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { formatRelative } from '../lib/format'

export function AlertsPage() {
  const {
    alerts,
    engagements,
    customers,
    users,
    constraints,
    markAlertRead,
    canSeeAllPortfolios,
    user,
  } = useApp()

  const visibleAlerts = alerts.filter((a) => canSeeAllPortfolios || a.csaOwnerId === user.id)
  const visibleEngagements = engagements.filter((e) => {
    if (canSeeAllPortfolios) return true
    const customer = customers.find((c) => c.id === e.customerId)
    return customer?.csaOwnerId === user.id
  })

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Alerts & Capacity engagement</h3>
          <p>
            Alerts route to CSA owners when a constraint hits their customers. Engage Capacity
            directly from the affected-customer context.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Alert inbox</h4>
              <p>In-app, Teams, and email notifications</p>
            </div>
          </div>
          <div className="panel-body stack">
            {visibleAlerts.map((alert) => {
              const customer = customers.find((c) => c.id === alert.customerId)
              const constraint = constraints.find((c) => c.id === alert.constraintId)
              return (
                <div key={alert.id} className={`alert-row${alert.read ? '' : ' unread'}`}>
                  <div style={{ flex: 1 }}>
                    <strong>{alert.title}</strong>
                    <div style={{ marginTop: '0.3rem' }}>{alert.message}</div>
                    <div className="muted" style={{ marginTop: '0.35rem' }}>
                      {customer?.name} · {alert.channel} · {formatRelative(alert.createdAt)}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.7rem' }}>
                      <Link className="btn btn-secondary" to={`/constraints/${alert.constraintId}`}>
                        Open {constraint?.sku ?? 'constraint'}
                      </Link>
                      {!alert.read ? (
                        <button className="btn btn-ghost" onClick={() => markAlertRead(alert.id)}>
                          Mark read
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {!alert.read ? <span className="pill pill-ok">Unread</span> : null}
                </div>
              )
            })}
            {visibleAlerts.length === 0 ? <div className="empty">No alerts.</div> : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Capacity-team engagements</h4>
              <p>Structured follow-ups initiated by CSAs</p>
            </div>
          </div>
          <div className="panel-body stack">
            {visibleEngagements.map((eng) => {
              const customer = customers.find((c) => c.id === eng.customerId)
              const constraint = constraints.find((c) => c.id === eng.constraintId)
              const initiator = users.find((u) => u.id === eng.initiatedBy)
              return (
                <div key={eng.id} className="list-row">
                  <div style={{ flex: 1 }}>
                    <strong>
                      {customer?.name} · {constraint?.sku}
                    </strong>
                    <div className="muted" style={{ marginTop: '0.25rem' }}>
                      {initiator?.name} · {eng.status} · {formatRelative(eng.createdAt)}
                    </div>
                    <div style={{ marginTop: '0.45rem' }}>{eng.notes}</div>
                  </div>
                  <span
                    className={`pill ${
                      eng.status === 'In progress'
                        ? 'pill-investigation'
                        : eng.status === 'Closed'
                          ? 'pill-resolved'
                          : 'pill-medium'
                    }`}
                  >
                    {eng.status}
                  </span>
                </div>
              )
            })}
            {visibleEngagements.length === 0 ? (
              <div className="empty">No engagements yet. Start one from a constraint impact row.</div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
