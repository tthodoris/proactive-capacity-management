import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Gauge, MapPinned, Package, ShieldAlert } from 'lucide-react'
import { useApp } from '../context/AppContext'
import {
  computeCustomerCapacityRisk,
  getOpenConstraintsForCustomer,
  getQuotaActionsToReduceRisk,
  getRegionConcentrationSlices,
  getSkuConcentrationSlices,
  riskLevelPillClass,
  type ConcentrationSlice,
  type QuotaRiskAction,
} from '../lib/capacityRisk'

function ShareBarChart({
  title,
  caption,
  slices,
  accentClass,
}: {
  title: string
  caption: string
  slices: ConcentrationSlice[]
  accentClass?: string
}) {
  const max = Math.max(...slices.map((s) => s.sharePct), 1)
  if (slices.length === 0) {
    return (
      <div className="panel risk-chart-panel">
        <h4>{title}</h4>
        <p className="muted">{caption}</p>
        <div className="empty">No inventory to chart.</div>
      </div>
    )
  }
  return (
    <div className="panel risk-chart-panel">
      <h4>{title}</h4>
      <p className="muted">{caption}</p>
      <div className="risk-share-chart" role="img" aria-label={title}>
        {slices.map((slice) => (
          <div key={slice.label} className="risk-share-row">
            <div className="risk-share-label" title={slice.label}>
              {slice.label}
            </div>
            <div className="risk-share-track">
              <div
                className={`risk-share-fill ${accentClass || ''}`.trim()}
                style={{ width: `${Math.max((slice.sharePct / max) * 100, slice.sharePct > 0 ? 3 : 0)}%` }}
              />
            </div>
            <div className="risk-share-meta">
              {slice.sharePct}% · {slice.count}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DriverScoreChart({
  factors,
}: {
  factors: Array<{ id: string; label: string; points: number }>
}) {
  const total = Math.max(
    factors.reduce((sum, f) => sum + f.points, 0),
    1,
  )
  if (factors.length === 0) {
    return <div className="empty">No scored drivers for this customer.</div>
  }
  return (
    <div className="risk-driver-chart" role="img" aria-label="Score contribution by driver">
      {factors.map((f, index) => (
        <div key={f.id} className="risk-driver-row">
          <div className="risk-driver-label">{f.label}</div>
          <div className="risk-share-track">
            <div
              className={`risk-share-fill tone-${index % 5}`}
              style={{ width: `${Math.max((f.points / total) * 100, f.points > 0 ? 4 : 0)}%` }}
            />
          </div>
          <div className="risk-share-meta">+{f.points} pts</div>
        </div>
      ))}
    </div>
  )
}

function QuotaUsageChart({ actions }: { actions: QuotaRiskAction[] }) {
  if (actions.length === 0) {
    return <div className="empty">No quotas above the action threshold.</div>
  }
  const top = actions.slice(0, 12)
  return (
    <div className="risk-quota-chart" role="img" aria-label="Quota usage percent for action items">
      {top.map((action) => {
        const tone =
          action.priority === 'critical'
            ? 'tone-critical'
            : action.priority === 'high'
              ? 'tone-high'
              : 'tone-medium'
        return (
          <div key={action.quota.id} className="risk-share-row">
            <div className="risk-share-label" title={action.quota.name}>
              {action.quota.name}
              <div className="muted">
                {action.quota.region}
                {action.quota.subscriptionName ? ` · ${action.quota.subscriptionName}` : ''}
              </div>
            </div>
            <div className="risk-share-track">
              <div
                className={`risk-share-fill ${tone}`}
                style={{ width: `${Math.min(action.usagePct, 100)}%` }}
              />
            </div>
            <div className="risk-share-meta">{action.usagePct}%</div>
          </div>
        )
      })}
    </div>
  )
}

export function CustomerRiskDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const {
    customers,
    users,
    inventory,
    quotas,
    impactResults,
    constraints,
    portfolioCustomerIds,
    canSeeAllPortfolios,
  } = useApp()

  const customer = customers.find((c) => c.id === id)
  const allowed =
    customer && (canSeeAllPortfolios || portfolioCustomerIds.includes(customer.id))

  const risk = useMemo(() => {
    if (!customer || !allowed) return null
    return computeCustomerCapacityRisk({
      customer,
      inventory,
      quotas,
      impacts: impactResults,
      constraints,
    })
  }, [customer, allowed, inventory, quotas, impactResults, constraints])

  const skuSlices = useMemo(
    () => (customer && allowed ? getSkuConcentrationSlices(inventory, customer.id) : []),
    [customer, allowed, inventory],
  )
  const regionSlices = useMemo(
    () => (customer && allowed ? getRegionConcentrationSlices(inventory, customer.id) : []),
    [customer, allowed, inventory],
  )
  const quotaActions = useMemo(
    () => (customer && allowed ? getQuotaActionsToReduceRisk(quotas, customer.id) : []),
    [customer, allowed, quotas],
  )
  const openConstraints = useMemo(
    () =>
      customer && allowed
        ? getOpenConstraintsForCustomer(customer.id, impactResults, constraints)
        : [],
    [customer, allowed, impactResults, constraints],
  )

  if (!customer || !allowed || !risk) {
    return (
      <div className="stack">
        <div className="empty">Customer not found in your portfolio.</div>
        <Link className="btn btn-secondary" to="/customers/risk">
          Back to risk scores
        </Link>
      </div>
    )
  }

  const owner = users.find((u) => u.id === customer.csaOwnerId)
  const regionWarnings = risk.warnings.filter((w) => w.category === 'region')
  const skuWarnings = risk.warnings.filter((w) => w.category === 'sku')

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <div className="filters" style={{ marginBottom: '0.65rem', padding: 0 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => navigate('/customers/risk')}
            >
              <ArrowLeft size={16} /> Risk scores
            </button>
            <Link className="btn btn-ghost" to={`/customers/${customer.id}`}>
              Customer portfolio
            </Link>
          </div>
          <h3>{customer.name}</h3>
          <p>
            How the capacity risk decision was formed, concentration warnings, and quota changes that
            reduce headroom pressure.
          </p>
        </div>
        <div className="risk-hero-badge">
          <span className={riskLevelPillClass(risk.level)}>{risk.level}</span>
          <div className="value">{risk.score}</div>
          <div className="muted">composite score</div>
        </div>
      </div>

      <div className="metrics">
        <div className="metric-card">
          <div className="label">Why</div>
          <div className="value" style={{ fontSize: '1.05rem', lineHeight: 1.35 }}>
            {risk.summary}
          </div>
          <div className="hint">{owner?.name || 'Unassigned'} · {customer.segment}</div>
        </div>
        <div className="metric-card">
          <div className="label">Open constraints</div>
          <div className="value">{risk.metrics.openConstraintCount}</div>
          <div className="hint">
            {risk.metrics.criticalConstraintCount} critical · {risk.metrics.highConstraintCount} high
          </div>
        </div>
        <div className="metric-card">
          <div className="label">Peak quota usage</div>
          <div className="value">
            {risk.metrics.maxQuotaUsagePct != null ? `${risk.metrics.maxQuotaUsagePct}%` : '—'}
          </div>
          <div className="hint">Network Watchers excluded</div>
        </div>
        <div className="metric-card">
          <div className="label">Quotas to raise</div>
          <div className="value">{quotaActions.length}</div>
          <div className="hint">At or above 60% used</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>
              <ShieldAlert size={18} /> Score drivers
            </h4>
            <p className="muted">
              Points from open constraints, quota headroom, and SKU concentration. Region
              concentration does not add to the score.
            </p>
          </div>
        </div>
        <DriverScoreChart factors={risk.factors} />
        {risk.factors.length > 0 ? (
          <div className="risk-factor-list" style={{ marginTop: '1rem' }}>
            {risk.factors.map((f) => (
              <div key={f.id} className="risk-factor-item">
                <ShieldAlert size={14} />
                <div>
                  <strong>{f.label}</strong>
                  <div className="muted">{f.detail}</div>
                </div>
                <span className="muted">+{f.points}</span>
              </div>
            ))}
          </div>
        ) : null}
        {openConstraints.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Open constraint</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Regions</th>
                </tr>
              </thead>
              <tbody>
                {openConstraints.map((c) => (
                  <tr
                    key={c.id}
                    className="clickable"
                    onClick={() => navigate(`/constraints/${c.id}`)}
                  >
                    <td>
                      <strong>{c.sku}</strong>
                      <div className="muted">{c.resourceType}</div>
                    </td>
                    <td>
                      <span
                        className={`pill pill-${c.severity === 'Critical' ? 'critical' : c.severity === 'High' ? 'high' : 'medium'}`}
                      >
                        {c.severity}
                      </span>
                    </td>
                    <td>{c.status}</td>
                    <td>{c.regions.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="grid-2 risk-detail-grid">
        <ShareBarChart
          title="SKU concentration"
          caption="Share of inventory by SKU / size / type. High concentration raises scored risk and is also surfaced as a warning."
          slices={skuSlices}
          accentClass="tone-1"
        />
        <ShareBarChart
          title="Region concentration"
          caption="Share of inventory by region. Advisory only — does not change the Red/Amber/Green score."
          slices={regionSlices}
          accentClass="tone-2"
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>
              <Package size={18} /> Concentration warnings
            </h4>
            <p className="muted">
              Region warnings never affect the score. SKU warnings flag diversification risk and may
              also appear in scored drivers when concentration is high enough.
            </p>
          </div>
        </div>
        {regionWarnings.length === 0 && skuWarnings.length === 0 ? (
          <div className="empty">No elevated region or SKU concentration warnings.</div>
        ) : (
          <div className="risk-factor-list">
            {[...skuWarnings, ...regionWarnings].map((w) => (
              <div key={w.id} className="risk-factor-item risk-warning-item">
                {w.category === 'region' ? <MapPinned size={14} /> : <Package size={14} />}
                <div>
                  <strong>{w.label}</strong>
                  <div className="muted">{w.detail}</div>
                </div>
                <span className="pill pill-high">Warning</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>
              <Gauge size={18} /> Quotas to modify
            </h4>
            <p className="muted">
              Raise these limits so current usage sits near 70% of capacity. Network Watcher quotas
              are excluded. Chart shows today&apos;s usage %.
            </p>
          </div>
        </div>
        <QuotaUsageChart actions={quotaActions} />
        {quotaActions.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Quota</th>
                  <th>Region</th>
                  <th>Usage / limit</th>
                  <th>Usage %</th>
                  <th>Suggested limit</th>
                  <th>Increase by</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {quotaActions.map((action) => (
                  <tr key={action.quota.id}>
                    <td>
                      <strong>{action.quota.name}</strong>
                      <div className="muted">
                        {action.quota.subscriptionName || action.quota.azureSubscriptionId || '—'}
                      </div>
                    </td>
                    <td>{action.quota.region}</td>
                    <td>
                      {action.quota.usage} / {action.quota.limit} {action.quota.unit}
                    </td>
                    <td>
                      <span
                        className={`pill ${
                          action.priority === 'critical'
                            ? 'pill-critical'
                            : action.priority === 'high'
                              ? 'pill-high'
                              : 'pill-medium'
                        }`}
                      >
                        {action.usagePct}%
                      </span>
                    </td>
                    <td>
                      <strong>{action.suggestedLimit}</strong> {action.quota.unit}
                    </td>
                    <td>{action.increaseBy > 0 ? `+${action.increaseBy}` : '—'}</td>
                    <td className="muted">{action.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  )
}
