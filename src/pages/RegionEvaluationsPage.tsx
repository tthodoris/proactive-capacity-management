import { useEffect, useMemo, useState, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, ChevronDown, ChevronRight, MapPinned, Trash2 } from 'lucide-react'
import { useApp } from '../context/AppContext'
import type { RegionEvalStatus, SavedRegionEvaluation } from '../lib/azureApi'
import { deleteRegionEvaluation, fetchRegionEvaluations } from '../lib/dataApi'
import { formatDate } from '../lib/format'

function statusTone(status: RegionEvalStatus) {
  if (status === 'available') return 'pill-ok'
  if (status === 'restricted') return 'pill-high'
  if (status === 'unavailable') return 'pill-critical'
  return 'pill-neutral'
}

function statusLabel(status: RegionEvalStatus) {
  if (status === 'available') return 'Available'
  if (status === 'restricted') return 'Restricted'
  if (status === 'unavailable') return 'Unavailable'
  return 'Unknown'
}

type AvailabilityGap = {
  regionId: string
  regionLabel: string
  resourceType: string
  sku: string
  size: string | null
  resourceCount: number
  sourceRegions: string[]
  status: RegionEvalStatus
  reason: string
}

function collectAvailabilityGaps(evaluation: SavedRegionEvaluation): AvailabilityGap[] {
  const gaps: AvailabilityGap[] = []
  for (const row of evaluation.results || []) {
    for (const region of evaluation.targetRegions || []) {
      const cell = row.byRegion?.[region.id]
      const status = (cell?.status || 'unknown') as RegionEvalStatus
      if (status === 'available') continue
      gaps.push({
        regionId: region.id,
        regionLabel: region.label || region.id,
        resourceType: row.resourceType,
        sku: row.sku,
        size: row.size,
        resourceCount: row.resourceCount,
        sourceRegions: row.sourceRegions || [],
        status,
        reason: cell?.reason || 'No availability reason recorded',
      })
    }
  }
  return gaps.sort(
    (a, b) =>
      a.regionLabel.localeCompare(b.regionLabel) ||
      a.resourceType.localeCompare(b.resourceType) ||
      a.sku.localeCompare(b.sku),
  )
}

function EvaluationGapsPanel({ evaluation }: { evaluation: SavedRegionEvaluation }) {
  const gaps = useMemo(() => collectAvailabilityGaps(evaluation), [evaluation])
  const byRegion = useMemo(() => {
    const map = new Map<string, AvailabilityGap[]>()
    for (const gap of gaps) {
      const list = map.get(gap.regionId) || []
      list.push(gap)
      map.set(gap.regionId, list)
    }
    return [...map.entries()].map(([regionId, items]) => ({
      regionId,
      regionLabel: items[0]?.regionLabel || regionId,
      items,
    }))
  }, [gaps])

  if (gaps.length === 0) {
    return (
      <div className="empty" style={{ margin: '0.75rem 0' }}>
        All evaluated SKUs/services are available in every selected target region.
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: '0.85rem', padding: '0.85rem 0 0.25rem' }}>
      <div className="banner banner-error" style={{ margin: 0 }}>
        {gaps.length} resource gap{gaps.length === 1 ? '' : 's'} across {byRegion.length} target
        region{byRegion.length === 1 ? '' : 's'} (unavailable, restricted, or unknown).
      </div>
      {byRegion.map((group) => (
        <div key={group.regionId} className="quota-provider-block">
          <div className="quota-provider-title">
            <h5>{group.regionLabel}</h5>
            <span className="muted">{group.items.length} not available</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Resource type</th>
                  <th>SKU / service</th>
                  <th>Count</th>
                  <th>Source region</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((gap) => (
                  <tr key={`${gap.regionId}-${gap.resourceType}-${gap.sku}-${gap.size || ''}`}>
                    <td>{gap.resourceType}</td>
                    <td>
                      <strong>{gap.sku}</strong>
                      {gap.size ? <div className="muted">{gap.size}</div> : null}
                    </td>
                    <td>{gap.resourceCount}</td>
                    <td className="muted">{gap.sourceRegions.join(', ') || '—'}</td>
                    <td>
                      <span className={`pill ${statusTone(gap.status)}`}>
                        {statusLabel(gap.status)}
                      </span>
                    </td>
                    <td className="muted">{gap.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

export function RegionEvaluationsPage() {
  const { customers, portfolioCustomerIds, canSeeAllPortfolios } = useApp()
  const [customerFilter, setCustomerFilter] = useState('')
  const [evaluations, setEvaluations] = useState<SavedRegionEvaluation[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const visibleCustomers = useMemo(
    () =>
      customers
        .filter((c) => canSeeAllPortfolios || portfolioCustomerIds.includes(c.id))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [customers, canSeeAllPortfolios, portfolioCustomerIds],
  )

  const visibleCustomerIds = useMemo(
    () => new Set(visibleCustomers.map((c) => c.id)),
    [visibleCustomers],
  )

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchRegionEvaluations(customerFilter || undefined)
      setEvaluations(
        data.evaluations.filter((evaluation) => visibleCustomerIds.has(evaluation.customerId)),
      )
    } catch (err) {
      setEvaluations([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerFilter, visibleCustomerIds])

  const grouped = useMemo(() => {
    const map = new Map<string, SavedRegionEvaluation[]>()
    for (const evaluation of evaluations) {
      const list = map.get(evaluation.customerId) || []
      list.push(evaluation)
      map.set(evaluation.customerId, list)
    }
    return [...map.entries()]
      .map(([customerId, items]) => ({
        customerId,
        customerName: items[0]?.customerName || customerId,
        items,
      }))
      .sort((a, b) => a.customerName.localeCompare(b.customerName))
  }, [evaluations])

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function onDelete(id: string) {
    if (!window.confirm('Delete this saved region evaluation?')) return
    try {
      await deleteRegionEvaluation(id)
      setEvaluations((prev) => prev.filter((evaluation) => evaluation.id !== id))
      setExpandedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Evaluations</h3>
          <p>
            Saved region evaluations grouped by customer. Expand a run to see which resources are
            not available in each target region.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link className="btn btn-secondary" to="/region-evaluation">
            <MapPinned size={16} /> Run evaluation
          </Link>
          <Link className="btn btn-ghost" to="/region-evaluation/cost-analysis">
            <BarChart3 size={16} /> Cost analysis
          </Link>
        </div>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <label className="field" style={{ margin: 0, minWidth: 240 }}>
          <span>Customer</span>
          <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)}>
            <option value="">All customers</option>
            {visibleCustomers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <div className="banner banner-error">{error}</div> : null}

      {loading ? (
        <div className="empty">Loading evaluations…</div>
      ) : grouped.length === 0 ? (
        <div className="empty">
          No saved evaluations yet. Run an evaluation from{' '}
          <Link to="/region-evaluation">Region evaluation</Link>.
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.customerId} className="panel">
            <div className="panel-header">
              <div>
                <h4>{group.customerName}</h4>
                <p>
                  {group.items.length} evaluation{group.items.length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: '2.5rem' }} />
                    <th>Run at</th>
                    <th>Subscriptions</th>
                    <th>Target regions</th>
                    <th>SKU/services</th>
                    <th>Availability</th>
                    <th>Not available</th>
                    <th>By</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((evaluation) => {
                    const gaps = collectAvailabilityGaps(evaluation)
                    const expanded = expandedIds.has(evaluation.id)
                    const gapRegions = new Set(gaps.map((gap) => gap.regionId)).size
                    return (
                      <Fragment key={evaluation.id}>
                        <tr>
                          <td>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              aria-expanded={expanded}
                              title={
                                expanded
                                  ? 'Hide unavailable resources'
                                  : 'Show unavailable resources'
                              }
                              onClick={() => toggleExpanded(evaluation.id)}
                            >
                              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </button>
                          </td>
                          <td>{formatDate(evaluation.createdAt)}</td>
                          <td>
                            {(evaluation.subscriptionNames || []).join(', ') ||
                              `${evaluation.subscriptionIds.length} subscription(s)`}
                          </td>
                          <td>
                            {(evaluation.targetRegions || [])
                              .map((r) => r.label || r.id)
                              .join(', ') || '—'}
                          </td>
                          <td>
                            {evaluation.summary?.itemCount ?? evaluation.results?.length ?? 0}
                          </td>
                          <td className="muted">
                            {evaluation.summary?.fullyAvailable ?? 0} full ·{' '}
                            {evaluation.summary?.partiallyAvailable ?? 0} partial ·{' '}
                            {(evaluation.summary?.unavailable ?? 0) +
                              (evaluation.summary?.unknown ?? 0)}{' '}
                            unavailable/unknown
                          </td>
                          <td>
                            {gaps.length === 0 ? (
                              <span className="pill pill-ok">None</span>
                            ) : (
                              <button
                                type="button"
                                className="pill pill-critical"
                                style={{ cursor: 'pointer', border: 'none' }}
                                onClick={() => toggleExpanded(evaluation.id)}
                              >
                                {gaps.length} gap{gaps.length === 1 ? '' : 's'} · {gapRegions}{' '}
                                region{gapRegions === 1 ? '' : 's'}
                              </button>
                            )}
                          </td>
                          <td className="muted">{evaluation.createdByName || '—'}</td>
                          <td>
                            <div
                              style={{
                                display: 'flex',
                                gap: '0.35rem',
                                justifyContent: 'flex-end',
                              }}
                            >
                              <Link
                                className="btn btn-secondary"
                                to={`/region-evaluation/cost-analysis?evaluationId=${evaluation.id}`}
                              >
                                Cost analysis
                              </Link>
                              <button
                                className="btn btn-ghost"
                                type="button"
                                title="Delete evaluation"
                                onClick={() => void onDelete(evaluation.id)}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr>
                            <td colSpan={9}>
                              <EvaluationGapsPanel evaluation={evaluation} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  )
}
