import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { RefreshCw, Send } from 'lucide-react'
import { SeverityBadge, StatusBadge } from '../components/Badges'
import { useApp } from '../context/AppContext'
import { formatDate, formatRelative } from '../lib/format'
import type { ConstraintStatus } from '../types'

export function ConstraintDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const {
    constraints,
    impactResults,
    customers,
    subscriptions,
    users,
    engagements,
    updateConstraintStatus,
    rerunImpact,
    createEngagement,
    portfolioCustomerIds,
    canSeeAllPortfolios,
  } = useApp()

  const constraint = constraints.find((c) => c.id === id)
  const [status, setStatus] = useState<ConstraintStatus>(constraint?.status ?? 'Open')
  const [note, setNote] = useState('')
  const [engageCustomerId, setEngageCustomerId] = useState('')
  const [engageNotes, setEngageNotes] = useState('Request Capacity team review for workaround options.')

  const impacts = useMemo(() => {
    return impactResults.filter((i) => {
      if (i.constraintId !== id) return false
      if (canSeeAllPortfolios) return true
      return portfolioCustomerIds.includes(i.customerId)
    })
  }, [impactResults, id, canSeeAllPortfolios, portfolioCustomerIds])

  const relatedEngagements = engagements.filter((e) => e.constraintId === id)

  if (!constraint) {
    return (
      <div className="panel panel-body">
        <div className="empty">
          Constraint not found.{' '}
          <button className="btn btn-ghost" onClick={() => navigate('/constraints')}>
            Back to list
          </button>
        </div>
      </div>
    )
  }

  async function onStatusSubmit(e: FormEvent) {
    e.preventDefault()
    await updateConstraintStatus(constraint!.id, status, note || `Status set to ${status}.`)
    setNote('')
  }

  async function onEngage(e: FormEvent) {
    e.preventDefault()
    if (!engageCustomerId) return
    await createEngagement(constraint!.id, engageCustomerId, engageNotes)
    setEngageNotes('Request Capacity team review for workaround options.')
  }

  const affectedCount = new Set(impacts.map((i) => i.customerId)).size

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>{constraint.sku}</h3>
          <p>
            {constraint.resourceType} · {constraint.regions.join(', ')} · reported{' '}
            {formatDate(constraint.reportedDate)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <SeverityBadge severity={constraint.severity} />
          <StatusBadge status={constraint.status} />
          <button
            className="btn btn-secondary"
            onClick={() => {
              void rerunImpact(constraint.id)
            }}
          >
            <RefreshCw size={16} /> Re-run impact
          </button>
        </div>
      </div>

      <div className="metrics">
        <div className="metric-card">
          <div className="label">Affected customers</div>
          <div className="value">{affectedCount}</div>
        </div>
        <div className="metric-card">
          <div className="label">Matching resources</div>
          <div className="value">{impacts.reduce((sum, i) => sum + i.matchingResourceCount, 0)}</div>
        </div>
        <div className="metric-card">
          <div className="label">Scope</div>
          <div className="value" style={{ fontSize: '1.3rem' }}>
            {constraint.scope}
          </div>
        </div>
        <div className="metric-card">
          <div className="label">Source</div>
          <div className="value" style={{ fontSize: '1.05rem' }}>
            {constraint.source}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Impact analysis</h4>
              <p>Customers using this SKU in the affected region(s)</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Subscription</th>
                  <th>Region</th>
                  <th>Resources</th>
                  <th>CSA</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {impacts.map((imp) => {
                  const customer = customers.find((c) => c.id === imp.customerId)
                  const sub = subscriptions.find((s) => s.id === imp.subscriptionId)
                  const owner = users.find((u) => u.id === customer?.csaOwnerId)
                  return (
                    <tr key={imp.id}>
                      <td>
                        <Link to={`/customers/${customer?.id}`}>
                          <strong>{customer?.name}</strong>
                        </Link>
                        <div className="muted">{imp.skus.join(', ')}</div>
                      </td>
                      <td>{sub?.name}</td>
                      <td>{imp.region}</td>
                      <td>
                        <strong>{imp.matchingResourceCount}</strong>
                      </td>
                      <td className="muted">{owner?.name}</td>
                      <td>
                        <button
                          className="btn btn-ghost"
                          onClick={() => setEngageCustomerId(imp.customerId)}
                        >
                          Engage
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {impacts.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty">No matching customers in the current portfolio view.</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <div className="stack">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Description</h4>
                <p>Latest known situation</p>
              </div>
            </div>
            <div className="panel-body">
              <p style={{ marginTop: 0 }}>{constraint.description}</p>
              <form className="stack" onSubmit={onStatusSubmit}>
                <div className="field">
                  <label htmlFor="status">Update status</label>
                  <select
                    id="status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as ConstraintStatus)}
                  >
                    <option>Open</option>
                    <option>Under investigation</option>
                    <option>Mitigating</option>
                    <option>Resolved</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="note">Audit note</label>
                  <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <button className="btn btn-primary" type="submit">
                  Save status
                </button>
              </form>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Engage Capacity team</h4>
                <p>Log a structured engagement from the affected-customer view</p>
              </div>
            </div>
            <div className="panel-body">
              <form className="stack" onSubmit={onEngage}>
                <div className="field">
                  <label htmlFor="customer">Customer</label>
                  <select
                    id="customer"
                    value={engageCustomerId}
                    onChange={(e) => setEngageCustomerId(e.target.value)}
                    required
                  >
                    <option value="">Select customer</option>
                    {[...new Set(impacts.map((i) => i.customerId))].map((cid) => {
                      const customer = customers.find((c) => c.id === cid)
                      return (
                        <option key={cid} value={cid}>
                          {customer?.name}
                        </option>
                      )
                    })}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="engageNotes">Notes</label>
                  <textarea
                    id="engageNotes"
                    value={engageNotes}
                    onChange={(e) => setEngageNotes(e.target.value)}
                  />
                </div>
                <button className="btn btn-secondary" type="submit">
                  <Send size={16} /> Initiate engagement
                </button>
              </form>

              {relatedEngagements.length > 0 ? (
                <div className="stack" style={{ marginTop: '1rem' }}>
                  {relatedEngagements.map((eng) => {
                    const customer = customers.find((c) => c.id === eng.customerId)
                    const initiator = users.find((u) => u.id === eng.initiatedBy)
                    return (
                      <div key={eng.id} className="list-row">
                        <div>
                          <strong>
                            {customer?.name} · {eng.status}
                          </strong>
                          <div className="muted">
                            {initiator?.name} · {formatRelative(eng.createdAt)}
                          </div>
                          <div style={{ marginTop: '0.35rem' }}>{eng.notes}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Audit trail</h4>
                <p>History of changes to this record</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="timeline">
                {[...constraint.history].reverse().map((entry) => {
                  const actor =
                    entry.by === 'system'
                      ? 'System'
                      : users.find((u) => u.id === entry.by)?.name ?? entry.by
                  return (
                    <div key={entry.id} className="timeline-item">
                      <div className="timeline-dot" />
                      <div>
                        <strong>
                          {entry.action} · {actor}
                        </strong>
                        <span>{formatDate(entry.at)}</span>
                        <div style={{ marginTop: '0.2rem' }}>{entry.detail}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
