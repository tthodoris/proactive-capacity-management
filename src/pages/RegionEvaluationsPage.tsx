import { useEffect, useMemo, useState, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, ChevronDown, ChevronRight, MapPinned, Trash2 } from 'lucide-react'
import { ConstraintBriefModal } from '../components/ConstraintBriefModal'
import { useApp } from '../context/AppContext'
import type { RegionEvalStatus, SavedRegionEvaluation } from '../lib/azureApi'
import { findMatchingConstraintsForEval } from '../lib/constraints'
import { deleteRegionEvaluation, fetchRegionEvaluations } from '../lib/dataApi'
import { formatDate } from '../lib/format'
import type { CapacityConstraint } from '../types'

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
  family: string | null
  resourceCount: number
  sourceRegions: string[]
  status: RegionEvalStatus
  reason: string
  /** True when one or more open capacity constraints match this row/region. */
  constrained: boolean
}

function gapKey(gap: Pick<AvailabilityGap, 'regionId' | 'resourceType' | 'sku' | 'size'>) {
  return `${gap.regionId}|${gap.resourceType}|${gap.sku}|${gap.size || ''}`
}

/** Azure availability gaps plus open capacity-constraint gaps for target regions. */
function collectEvaluationGaps(
  evaluation: SavedRegionEvaluation,
  constraints: CapacityConstraint[],
): AvailabilityGap[] {
  const byKey = new Map<string, AvailabilityGap>()

  for (const row of evaluation.results || []) {
    for (const region of evaluation.targetRegions || []) {
      const cell = row.byRegion?.[region.id]
      const status = (cell?.status || 'unknown') as RegionEvalStatus
      const regionLabel = region.label || region.id
      const matchingConstraints = findMatchingConstraintsForEval({
        constraints,
        resourceType: row.resourceType,
        sku: row.sku,
        size: row.size,
        family: row.family,
        targetRegionId: region.id,
        targetRegionLabel: regionLabel,
      })
      const availabilityGap = status !== 'available'
      const constrained = matchingConstraints.length > 0
      if (!availabilityGap && !constrained) continue

      const reasonParts: string[] = []
      if (availabilityGap) {
        reasonParts.push(cell?.reason || 'No availability reason recorded')
      }
      if (constrained) {
        reasonParts.push(
          `${matchingConstraints.length} open capacity constraint${
            matchingConstraints.length === 1 ? '' : 's'
          }: ${matchingConstraints
            .map((c) => `${c.sku} (${c.severity})`)
            .join(', ')}`,
        )
      }

      const gap: AvailabilityGap = {
        regionId: region.id,
        regionLabel,
        resourceType: row.resourceType,
        sku: row.sku,
        size: row.size ?? null,
        family: row.family ?? null,
        resourceCount: row.resourceCount,
        sourceRegions: row.sourceRegions || [],
        status,
        reason: reasonParts.join(' · '),
        constrained,
      }
      byKey.set(gapKey(gap), gap)
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.regionLabel.localeCompare(b.regionLabel) ||
      a.resourceType.localeCompare(b.resourceType) ||
      a.sku.localeCompare(b.sku),
  )
}

function EvaluationGapsPanel({
  evaluation,
  constraints,
}: {
  evaluation: SavedRegionEvaluation
  constraints: CapacityConstraint[]
}) {
  const [constraintPopup, setConstraintPopup] = useState<{
    constraints: CapacityConstraint[]
    contextLabel: string
  } | null>(null)
  const gaps = useMemo(
    () => collectEvaluationGaps(evaluation, constraints),
    [evaluation, constraints],
  )
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

  const constrainedCount = gaps.filter((gap) => gap.constrained).length
  const availabilityCount = gaps.filter((gap) => gap.status !== 'available').length

  if (gaps.length === 0) {
    return (
      <div className="empty" style={{ margin: '0.75rem 0' }}>
        All evaluated SKUs/services are available in every selected target region, with no open
        capacity constraints matching those targets.
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: '0.85rem', padding: '0.85rem 0 0.25rem' }}>
      <div className="banner banner-error" style={{ margin: 0 }}>
        {gaps.length} resource gap{gaps.length === 1 ? '' : 's'} across {byRegion.length} target
        region{byRegion.length === 1 ? '' : 's'}
        {availabilityCount > 0
          ? ` · ${availabilityCount} availability`
          : ''}
        {constrainedCount > 0
          ? ` · ${constrainedCount} capacity-constrained`
          : ''}
        .
      </div>
      {byRegion.map((group) => (
        <div key={group.regionId} className="quota-provider-block">
          <div className="quota-provider-title">
            <h5>{group.regionLabel}</h5>
            <span className="muted">{group.items.length} gap{group.items.length === 1 ? '' : 's'}</span>
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
                {group.items.map((gap) => {
                  const matchingConstraints = gap.constrained
                    ? findMatchingConstraintsForEval({
                        constraints,
                        resourceType: gap.resourceType,
                        sku: gap.sku,
                        size: gap.size,
                        family: gap.family,
                        targetRegionId: gap.regionId,
                        targetRegionLabel: gap.regionLabel,
                      })
                    : []
                  return (
                    <tr key={gapKey(gap)}>
                      <td>{gap.resourceType}</td>
                      <td>
                        <strong>{gap.sku}</strong>
                        {gap.size ? <div className="muted">{gap.size}</div> : null}
                      </td>
                      <td>{gap.resourceCount}</td>
                      <td className="muted">{gap.sourceRegions.join(', ') || '—'}</td>
                      <td>
                        <div className="region-eval-status-stack">
                          <span className={`pill ${statusTone(gap.status)}`}>
                            {statusLabel(gap.status)}
                          </span>
                          {matchingConstraints.length > 0 ? (
                            <button
                              type="button"
                              className="pill pill-high region-eval-constraint-tag"
                              onClick={() =>
                                setConstraintPopup({
                                  constraints: matchingConstraints,
                                  contextLabel: `${gap.sku} · ${gap.regionLabel}`,
                                })
                              }
                            >
                              Constrained
                              {matchingConstraints.length > 1
                                ? ` (${matchingConstraints.length})`
                                : ''}
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="muted">{gap.reason}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {constraintPopup ? (
        <ConstraintBriefModal
          constraints={constraintPopup.constraints}
          contextLabel={constraintPopup.contextLabel}
          onClose={() => setConstraintPopup(null)}
        />
      ) : null}
    </div>
  )
}

export function RegionEvaluationsPage() {
  const { customers, constraints, portfolioCustomerIds, canSeeAllPortfolios } = useApp()
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
            Saved region evaluations grouped by customer. Expand a run to see availability gaps and
            matching open capacity constraints per target region.
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
                    <th>Gaps</th>
                    <th>By</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((evaluation) => {
                    const gaps = collectEvaluationGaps(evaluation, constraints)
                    const expanded = expandedIds.has(evaluation.id)
                    const gapRegions = new Set(gaps.map((gap) => gap.regionId)).size
                    const hasAvailabilityGap = gaps.some((gap) => gap.status !== 'available')
                    const constrainedOnly =
                      gaps.length > 0 && gaps.every((gap) => gap.status === 'available' && gap.constrained)
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
                                  ? 'Hide evaluation gaps'
                                  : 'Show availability and constraint gaps'
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
                                className={`pill ${
                                  constrainedOnly
                                    ? 'pill-high'
                                    : hasAvailabilityGap
                                      ? 'pill-critical'
                                      : 'pill-high'
                                }`}
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
                              <EvaluationGapsPanel
                                evaluation={evaluation}
                                constraints={constraints}
                              />
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
