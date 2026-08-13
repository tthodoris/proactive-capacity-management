import { useMemo } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Gauge, MapPinned, Package, ShieldAlert } from 'lucide-react'
import { useApp } from '../context/AppContext'
import {
  computeCustomerCapacityRisk,
  computeCustomerSubscriptionRisks,
  computeSubscriptionCapacityRisk,
  getOpenConstraintsForScope,
  getQuotaActionsToReduceRisk,
  getRegionConcentrationSlices,
  getSkuConcentrationSlices,
  loadCapacityRiskWeights,
  riskLevelPillClass,
  sortRisksForTriage,
  type ConcentrationSlice,
  type CustomerCapacityRisk,
  type QuotaRiskAction,
} from '../lib/capacityRisk'

function ShareBarChart({
  title,
  caption,
  slices,
  accentClass,
  useCapacityWeight,
}: {
  title: string
  caption: string
  slices: ConcentrationSlice[]
  accentClass?: string
  useCapacityWeight?: boolean
}) {
  const valueKey = useCapacityWeight ? 'capacitySharePct' : 'sharePct'
  const max = Math.max(...slices.map((s) => s[valueKey]), 1)
  if (slices.length === 0) {
    return (
      <div className="panel risk-chart-panel">
        <div className="panel-header">
          <div>
            <h4>{title}</h4>
            <p>{caption}</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="empty">No inventory to chart.</div>
        </div>
      </div>
    )
  }
  return (
    <div className="panel risk-chart-panel">
      <div className="panel-header">
        <div>
          <h4>{title}</h4>
          <p>{caption}</p>
        </div>
      </div>
      <div className="panel-body">
        <div className="risk-share-chart" role="img" aria-label={title}>
          {slices.map((slice) => (
            <div key={slice.label} className="risk-bar-item">
              <div className="risk-bar-heading">
                <span className="risk-bar-title" title={slice.label}>
                  {slice.label}
                </span>
                <span className="risk-bar-value">
                  {slice[valueKey]}%{useCapacityWeight ? ` (${slice.capacityWeight} vCPU)` : ''} · {slice.count}
                </span>
              </div>
              <div className="risk-share-track">
                <div
                  className={`risk-share-fill ${accentClass || ''}`.trim()}
                  style={{
                    width: `${Math.max((slice[valueKey] / max) * 100, slice[valueKey] > 0 ? 3 : 0)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
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
        <div key={f.id} className="risk-bar-item">
          <div className="risk-bar-heading">
            <span className="risk-bar-title" title={f.label}>
              {f.label}
            </span>
            <span className="risk-bar-value">+{f.points} pts</span>
          </div>
          <div className="risk-share-track">
            <div
              className={`risk-share-fill tone-${index % 5}`}
              style={{ width: `${Math.max((f.points / total) * 100, f.points > 0 ? 4 : 0)}%` }}
            />
          </div>
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
        const subtitle = [
          action.quota.region,
          action.quota.subscriptionName || action.quota.azureSubscriptionId,
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <div key={action.quota.id} className="risk-bar-item">
            <div className="risk-bar-heading">
              <div className="risk-bar-title-block">
                <span className="risk-bar-title" title={action.quota.name}>
                  {action.quota.name}
                </span>
                {subtitle ? <span className="muted risk-bar-subtitle">{subtitle}</span> : null}
              </div>
              <span className="risk-bar-value">{action.usagePct}%</span>
            </div>
            <div className="risk-share-track">
              <div
                className={`risk-share-fill ${tone}`}
                style={{ width: `${Math.min(Math.max(action.usagePct, 0), 100)}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function CustomerRiskDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedSubscriptionId = searchParams.get('subscription')
  const {
    customers,
    users,
    subscriptions,
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
  const customerSubscriptions = useMemo(
    () => (customer ? subscriptions.filter((s) => s.customerId === customer.id) : []),
    [customer, subscriptions],
  )
  const selectedSubscription = customerSubscriptions.find((s) => s.id === selectedSubscriptionId)

  const customerRisk = useMemo(() => {
    if (!customer || !allowed) return null
    return computeCustomerCapacityRisk({
      customer,
      inventory,
      quotas,
      impacts: impactResults,
      constraints,
      weights: loadCapacityRiskWeights(),
    })
  }, [customer, allowed, inventory, quotas, impactResults, constraints])

  const subscriptionRisks = useMemo(() => {
    if (!customer || !allowed) return []
    return sortRisksForTriage(
      computeCustomerSubscriptionRisks({
        customer,
        subscriptions: customerSubscriptions,
        inventory,
        quotas,
        impacts: impactResults,
        constraints,
        weights: loadCapacityRiskWeights(),
      }),
    )
  }, [
    customer,
    allowed,
    customerSubscriptions,
    inventory,
    quotas,
    impactResults,
    constraints,
  ])

  const risk = useMemo(() => {
    if (!customer || !allowed) return null
    if (selectedSubscription) {
      return computeSubscriptionCapacityRisk({
        customer,
        subscription: selectedSubscription,
        inventory,
        quotas,
        impacts: impactResults,
        constraints,
        weights: loadCapacityRiskWeights(),
      })
    }
    return customerRisk
  }, [
    customer,
    allowed,
    selectedSubscription,
    customerRisk,
    inventory,
    quotas,
    impactResults,
    constraints,
  ])

  const scopeSubscriptionId = selectedSubscription?.id ?? null

  const skuSlices = useMemo(
    () =>
      customer && allowed
        ? getSkuConcentrationSlices(inventory, customer.id, scopeSubscriptionId)
        : [],
    [customer, allowed, inventory, scopeSubscriptionId],
  )
  const regionSlices = useMemo(
    () =>
      customer && allowed
        ? getRegionConcentrationSlices(inventory, customer.id, scopeSubscriptionId)
        : [],
    [customer, allowed, inventory, scopeSubscriptionId],
  )
  const quotaActions = useMemo(
    () =>
      customer && allowed
        ? getQuotaActionsToReduceRisk(quotas, customer.id, {
            subscriptionId: scopeSubscriptionId,
          })
        : [],
    [customer, allowed, quotas, scopeSubscriptionId],
  )
  const openConstraints = useMemo(
    () =>
      customer && allowed
        ? getOpenConstraintsForScope(
            customer.id,
            scopeSubscriptionId,
            impactResults,
            constraints,
          )
        : [],
    [customer, allowed, scopeSubscriptionId, impactResults, constraints],
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
            {selectedSubscription
              ? `Subscription risk for “${selectedSubscription.name}”.`
              : 'Customer rollup across all subscriptions.'}{' '}
            Drivers, concentration warnings, and quotas to raise.
          </p>
        </div>
        <div className="risk-hero-badge">
          <span className={riskLevelPillClass(risk.level)}>{risk.level}</span>
          <div className="value">{risk.score}</div>
          <div className="muted">
            {selectedSubscription ? 'subscription score' : 'customer score'}
          </div>
        </div>
      </div>

      <section className="panel risk-detail-panel">
        <div className="panel-header">
          <div>
            <h4>Scope</h4>
            <p>Switch between customer rollup and per-subscription risk.</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="risk-scope-toggle">
            <button
              type="button"
              className={`btn ${!selectedSubscriptionId ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setSearchParams({})}
            >
              Customer rollup
            </button>
            {customerSubscriptions.map((sub) => {
              const subRisk = subscriptionRisks.find((r) => r.subscriptionId === sub.id)
              return (
                <button
                  key={sub.id}
                  type="button"
                  className={`btn ${selectedSubscriptionId === sub.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setSearchParams({ subscription: sub.id })}
                >
                  {sub.name}
                  {subRisk ? (
                    <span className={`pill ${riskLevelPillClass(subRisk.level)}`} style={{ marginLeft: '0.35rem' }}>
                      {subRisk.level} · {subRisk.score}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          {subscriptionRisks.length > 0 ? (
            <div className="table-wrap risk-detail-table">
              <table className="data">
                <thead>
                  <tr>
                    <th>Subscription</th>
                    <th>Risk</th>
                    <th>Score</th>
                    <th>Why</th>
                    <th>Inventory</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptionRisks.map((subRisk: CustomerCapacityRisk) => (
                    <tr
                      key={subRisk.subscriptionId}
                      className="clickable"
                      onClick={() =>
                        subRisk.subscriptionId &&
                        setSearchParams({ subscription: subRisk.subscriptionId })
                      }
                    >
                      <td>
                        <strong>{subRisk.subscriptionName}</strong>
                      </td>
                      <td>
                        <span className={riskLevelPillClass(subRisk.level)}>{subRisk.level}</span>
                      </td>
                      <td>{subRisk.score}</td>
                      <td>{subRisk.summary}</td>
                      <td>{subRisk.metrics.inventoryCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">No subscriptions on file for this customer.</div>
          )}
        </div>
      </section>

      <div className="metrics risk-detail-metrics">
        <div className="metric-card risk-why-card">
          <div className="label">Why</div>
          <p className="risk-why-text">{risk.summary}</p>
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

      <section className="panel risk-detail-panel">
        <div className="panel-header">
          <div>
            <h4>
              <ShieldAlert size={18} /> Score drivers
            </h4>
            <p>
              Points from open constraints, quota headroom, and SKU concentration. Region
              concentration does not add to the score.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <DriverScoreChart factors={risk.factors} />
          {risk.factors.length > 0 ? (
            <div className="risk-factor-list risk-detail-factors">
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
            <div className="table-wrap risk-detail-table">
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
        </div>
      </section>

      <div className="grid-2 risk-detail-grid">
        <ShareBarChart
          title="SKU concentration"
          caption="Top 10 SKUs by capacity share (weighted by vCPU)."
          slices={skuSlices}
          accentClass="tone-1"
          useCapacityWeight
        />
        <ShareBarChart
          title="Region concentration"
          caption="Share of capacity by region (weighted by vCPU). Advisory only — does not change the Red/Amber/Green score."
          slices={regionSlices}
          accentClass="tone-2"
          useCapacityWeight
        />
      </div>

      <section className="panel risk-detail-panel">
        <div className="panel-header">
          <div>
            <h4>
              <Package size={18} /> Concentration warnings
            </h4>
            <p>
              Region warnings never affect the score. SKU warnings flag diversification risk and may
              also appear in scored drivers when concentration is high enough.
            </p>
          </div>
        </div>
        <div className="panel-body">
          {regionWarnings.length === 0 && skuWarnings.length === 0 ? (
            <div className="empty">No elevated region or SKU concentration warnings.</div>
          ) : (
            <div className="risk-factor-list risk-detail-factors">
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
        </div>
      </section>

      <section className="panel risk-detail-panel">
        <div className="panel-header">
          <div>
            <h4>
              <Gauge size={18} /> Quotas to modify
            </h4>
            <p>
              Raise these limits so current usage sits near 70% of capacity. Network Watcher quotas
              are excluded. Chart shows today&apos;s usage %.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <QuotaUsageChart actions={quotaActions} />
          {quotaActions.length > 0 ? (
            <div className="table-wrap risk-detail-table">
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
        </div>
      </section>
    </div>
  )
}
