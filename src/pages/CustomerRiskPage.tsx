import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  Download,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react'
import { useApp } from '../context/AppContext'
import {
  CAPACITY_RISK_RAG_THRESHOLDS,
  CAPACITY_RISK_WEIGHT_META,
  DEFAULT_CAPACITY_RISK_WEIGHTS,
  adjustCapacityRiskWeight,
  capacityRiskWeightsEqual,
  computeCustomerSubscriptionRisks,
  computePortfolioCapacityRisks,
  computePortfolioSubscriptionRisks,
  loadCapacityRiskWeights,
  riskLevelPillClass,
  riskScopeKey,
  saveCapacityRiskWeights,
  sortRisksForTriage,
  type CapacityRiskLevel,
  type CapacityRiskWeightKey,
  type CapacityRiskWeights,
  type CustomerCapacityRisk,
} from '../lib/capacityRisk'
import { exportToExcel } from '../lib/exportExcel'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'

type RiskSortKey = 'name' | 'owner' | 'level' | 'score' | 'why' | 'callFirst' | 'scope'

const LEVEL_ORDER: Record<CapacityRiskLevel, number> = { Red: 0, Amber: 1, Green: 2 }

type RiskViewMode = 'customer' | 'subscription'

type RiskTableRow = {
  id: string
  customerId: string
  customerName: string
  segment: string
  ownerName: string
  scopeLabel: string
  isSubscription: boolean
  subscriptionId?: string | null
  risk: CustomerCapacityRisk
  callFirst: number
  childRisks?: CustomerCapacityRisk[]
}

function RiskDriversCell({ risk }: { risk: CustomerCapacityRisk }) {
  const factors = risk.factors || []
  const warnings = risk.warnings || []
  if (factors.length === 0 && warnings.length === 0) {
    return <span className="muted">No elevated factors</span>
  }
  const tags: string[] = []
  for (const f of factors) {
    if (f.category === 'constraints') tags.push('Open Constraints')
    else if (f.category === 'quotas') tags.push('Quota Headroom')
    else if (f.category === 'sku') tags.push('SKU Concentration')
  }
  for (const w of warnings) {
    if (w.category === 'region' && !tags.includes('Region Concentration'))
      tags.push('Region Concentration')
    if (w.category === 'sku' && !tags.includes('SKU Concentration'))
      tags.push('SKU Concentration')
    if (w.category === 'quota' && !tags.includes('Quota Warnings'))
      tags.push('Quota Warnings')
  }
  return <span className="muted">{tags.join(' · ')}</span>
}

function clampWeightInput(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function RiskWeightPanel({
  draft,
  applied,
  onChange,
  onRecalculate,
  onReset,
}: {
  draft: CapacityRiskWeights
  applied: CapacityRiskWeights
  onChange: (key: CapacityRiskWeightKey, value: number) => void
  onRecalculate: () => void
  onReset: () => void
}) {
  const dirty = !capacityRiskWeightsEqual(draft, applied)

  return (
    <section className="panel risk-weight-panel">
      <div className="panel-header">
        <div>
          <h4>
            <ShieldAlert size={18} /> Scoring factor weights
          </h4>
          <p>
            Adjust how much each scored factor contributes to the 0–100 risk score (weights always
            total 100%). Red / Amber / Green follows the score: ≥{CAPACITY_RISK_RAG_THRESHOLDS.red}{' '}
            Red, ≥{CAPACITY_RISK_RAG_THRESHOLDS.amber} Amber.
          </p>
        </div>
        <div className="risk-weight-actions">
          <button className="btn btn-ghost" type="button" onClick={onReset}>
            <RotateCcw size={16} /> Reset defaults
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={onRecalculate}
            disabled={!dirty}
            title={dirty ? 'Apply weights and recalculate' : 'Weights already applied'}
          >
            <RefreshCw size={16} /> Recalculate risk
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div
          className="risk-weight-stack"
          role="img"
          aria-label="Relative weight of each scoring factor"
        >
          {CAPACITY_RISK_WEIGHT_META.map((meta) => {
            const share = draft[meta.key]
            return (
              <div
                key={meta.key}
                className={`risk-weight-stack-segment ${meta.toneClass}`}
                style={{ width: `${Math.max(share, share > 0 ? 2 : 0)}%` }}
                title={`${meta.label}: ${share}%`}
              />
            )
          })}
        </div>
        <div className="risk-weight-legend">
          {CAPACITY_RISK_WEIGHT_META.map((meta) => (
            <div key={meta.key} className="risk-weight-legend-item">
              <span className={`risk-weight-swatch ${meta.toneClass}`} />
              <span>
                {meta.label} · <strong>{draft[meta.key]}%</strong>
              </span>
            </div>
          ))}
        </div>

        <div className="risk-weight-sliders">
          {CAPACITY_RISK_WEIGHT_META.map((meta) => (
            <label key={meta.key} className="risk-weight-slider">
              <div className="risk-weight-slider-head">
                <div>
                  <strong>{meta.label}</strong>
                  <div className="muted">{meta.description}</div>
                </div>
                <div className="risk-weight-slider-value">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={draft[meta.key]}
                    onChange={(e) => onChange(meta.key, Number(e.target.value))}
                  />
                  <span>%</span>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={draft[meta.key]}
                onChange={(e) => onChange(meta.key, Number(e.target.value))}
                aria-label={`${meta.label} weight`}
              />
              <div className="risk-bar-item" style={{ marginTop: '0.35rem' }}>
                <div className="risk-share-track">
                  <div
                    className={`risk-share-fill ${meta.toneClass}`}
                    style={{ width: `${draft[meta.key]}%` }}
                  />
                </div>
              </div>
            </label>
          ))}
        </div>

        <p className="muted risk-weight-hint">
          {dirty
            ? 'Weights changed — click Recalculate risk to refresh scores and colors.'
            : `Applied: constraints ${applied.constraints}%, quotas ${applied.quotas}%, SKU ${applied.sku}%. Moving one slider redistributes the rest equally.`}
        </p>
      </div>
    </section>
  )
}

export function CustomerRiskPage() {
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
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<RiskViewMode>('customer')
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(() => new Set())
  const [draftWeights, setDraftWeights] = useState<CapacityRiskWeights>(() =>
    loadCapacityRiskWeights(),
  )
  const [appliedWeights, setAppliedWeights] = useState<CapacityRiskWeights>(() =>
    loadCapacityRiskWeights(),
  )
  const { sortKey, sortDir, toggleSort } = useSortState<RiskSortKey>('level')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<RiskSortKey>()

  const portfolioCustomers = useMemo(
    () =>
      customers.filter((c) => canSeeAllPortfolios || portfolioCustomerIds.includes(c.id)),
    [customers, canSeeAllPortfolios, portfolioCustomerIds],
  )

  const riskByCustomer = useMemo(() => {
    const list = computePortfolioCapacityRisks({
      customers: portfolioCustomers,
      inventory,
      quotas,
      impacts: impactResults,
      constraints,
      weights: appliedWeights,
      subscriptions,
    })
    return new Map(list.map((r) => [r.customerId, r]))
  }, [portfolioCustomers, inventory, quotas, impactResults, constraints, appliedWeights, subscriptions])

  const subscriptionRisksByCustomer = useMemo(() => {
    const map = new Map<string, CustomerCapacityRisk[]>()
    for (const customer of portfolioCustomers) {
      const subs = subscriptions.filter((s) => s.customerId === customer.id)
      const risks = computeCustomerSubscriptionRisks({
        customer,
        subscriptions: subs,
        inventory,
        quotas,
        impacts: impactResults,
        constraints,
        weights: appliedWeights,
      })
      map.set(customer.id, sortRisksForTriage(risks))
    }
    return map
  }, [
    portfolioCustomers,
    subscriptions,
    inventory,
    quotas,
    impactResults,
    constraints,
    appliedWeights,
  ])

  const allSubscriptionRisks = useMemo(
    () =>
      sortRisksForTriage(
        computePortfolioSubscriptionRisks({
          customers: portfolioCustomers,
          subscriptions: subscriptions.filter((s) =>
            portfolioCustomers.some((c) => c.id === s.customerId),
          ),
          inventory,
          quotas,
          impacts: impactResults,
          constraints,
          weights: appliedWeights,
        }),
      ),
    [
      portfolioCustomers,
      subscriptions,
      inventory,
      quotas,
      impactResults,
      constraints,
      appliedWeights,
    ],
  )

  const customerTriageOrder = useMemo(() => {
    const risks = sortRisksForTriage([...riskByCustomer.values()])
    const order = new Map<string, number>()
    risks.forEach((r, index) => order.set(r.customerId, index + 1))
    return order
  }, [riskByCustomer])

  const subscriptionTriageOrder = useMemo(() => {
    const order = new Map<string, number>()
    allSubscriptionRisks.forEach((r, index) => {
      if (r.subscriptionId) order.set(riskScopeKey(r), index + 1)
    })
    return order
  }, [allSubscriptionRisks])

  const tableRows = useMemo((): RiskTableRow[] => {
    if (viewMode === 'subscription') {
      return allSubscriptionRisks.map((risk) => {
        const customer = portfolioCustomers.find((c) => c.id === risk.customerId)!
        const owner = users.find((u) => u.id === customer.csaOwnerId)
        return {
          id: riskScopeKey(risk),
          customerId: risk.customerId,
          customerName: customer.name,
          segment: customer.segment,
          ownerName: owner?.name || '',
          scopeLabel: risk.subscriptionName || 'Subscription',
          isSubscription: true,
          subscriptionId: risk.subscriptionId,
          risk,
          callFirst: subscriptionTriageOrder.get(riskScopeKey(risk)) ?? 9999,
        }
      })
    }

    return portfolioCustomers.map((customer) => {
      const owner = users.find((u) => u.id === customer.csaOwnerId)
      const risk = riskByCustomer.get(customer.id)!
      const childRisks = subscriptionRisksByCustomer.get(customer.id) || []
      return {
        id: customer.id,
        customerId: customer.id,
        customerName: customer.name,
        segment: customer.segment,
        ownerName: owner?.name || '',
        scopeLabel: 'Customer rollup',
        isSubscription: false,
        risk,
        callFirst: customerTriageOrder.get(customer.id) ?? 9999,
        childRisks,
      }
    })
  }, [
    viewMode,
    allSubscriptionRisks,
    portfolioCustomers,
    users,
    riskByCustomer,
    subscriptionRisksByCustomer,
    customerTriageOrder,
    subscriptionTriageOrder,
  ])

  const baseRows = useMemo(() => {
    return tableRows.filter((row) => {
      if (!query) return true
      const q = query.toLowerCase()
      return (
        row.customerName.toLowerCase().includes(q) ||
        row.segment.toLowerCase().includes(q) ||
        row.ownerName.toLowerCase().includes(q) ||
        row.scopeLabel.toLowerCase().includes(q) ||
        row.risk.level.toLowerCase().includes(q) ||
        row.risk.summary.toLowerCase().includes(q)
      )
    })
  }, [tableRows, query])

  const getValue = useCallback((row: RiskTableRow, key: string) => {
    switch (key) {
      case 'owner':
        return row.ownerName
      case 'level':
        return row.risk.level
      case 'score':
        return row.risk.score
      case 'why':
        return row.risk.summary
      case 'callFirst':
        return row.callFirst
      case 'scope':
        return row.scopeLabel
      case 'name':
        return row.customerName
      default:
        return ''
    }
  }, [])

  const filtered = useMemo(() => {
    return baseRows.filter((row) =>
      matchesColumnFilters((column) => String(getValue(row, column) ?? '')),
    )
  }, [baseRows, matchesColumnFilters, getValue])

  const rows = useSortedRows(filtered, sortKey, sortDir, (row, key) => {
    if (key === 'level') return LEVEL_ORDER[row.risk.level]
    return getValue(row, key)
  })

  const columnKeys: RiskSortKey[] = [
    'name',
    'scope',
    'owner',
    'level',
    'score',
    'why',
    'callFirst',
  ]
  const columnOptions = useMemo(
    () => collectCascadingOptions(baseRows, columnKeys, filters, getValue),
    [baseRows, filters, getValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(columnOptions)
  }, [columnOptions, pruneFiltersToOptions])

  const counts = useMemo(() => {
    const source = viewMode === 'subscription' ? allSubscriptionRisks : [...riskByCustomer.values()]
    return {
      red: source.filter((r) => r.level === 'Red').length,
      amber: source.filter((r) => r.level === 'Amber').length,
      green: source.filter((r) => r.level === 'Green').length,
    }
  }, [viewMode, allSubscriptionRisks, riskByCustomer])

  const toggleExpanded = (customerId: string) => {
    setExpandedCustomers((prev) => {
      const next = new Set(prev)
      if (next.has(customerId)) next.delete(customerId)
      else next.add(customerId)
      return next
    })
  }

  const updateDraftWeight = (key: CapacityRiskWeightKey, value: number) => {
    setDraftWeights((prev) => adjustCapacityRiskWeight(prev, key, clampWeightInput(value)))
  }

  const recalculate = () => {
    const next = saveCapacityRiskWeights(draftWeights)
    setDraftWeights(next)
    setAppliedWeights(next)
  }

  const resetWeights = () => {
    setDraftWeights({ ...DEFAULT_CAPACITY_RISK_WEIGHTS })
  }

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Customer capacity risk</h3>
          <p>
            Red / Amber / Green posture per customer and per subscription from open constraints,
            quota headroom (excluding Network Watchers, Storage Accounts, and Total Regional vCPUs),
            and SKU concentration. Region concentration, Storage Accounts, and Total Regional vCPUs
            are shown as warnings only.
          </p>
        </div>
      </div>

      <RiskWeightPanel
        draft={draftWeights}
        applied={appliedWeights}
        onChange={updateDraftWeight}
        onRecalculate={recalculate}
        onReset={resetWeights}
      />

      <div className="metrics">
        <div className="metric-card">
          <div className="label">Red</div>
          <div className="value">{counts.red}</div>
          <div className="hint">
            {viewMode === 'subscription' ? 'Subscriptions' : 'Customers'} · call first
          </div>
        </div>
        <div className="metric-card">
          <div className="label">Amber</div>
          <div className="value">{counts.amber}</div>
          <div className="hint">Watch closely</div>
        </div>
        <div className="metric-card">
          <div className="label">Green</div>
          <div className="value">{counts.green}</div>
          <div className="hint">No material pressure</div>
        </div>
      </div>

      <div className="filters">
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customer, subscription, owner, level, or why"
          />
        </div>
        <div className="risk-view-toggle" role="tablist" aria-label="Risk view">
          <button
            type="button"
            className={`btn ${viewMode === 'customer' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setViewMode('customer')}
          >
            By customer
          </button>
          <button
            type="button"
            className={`btn ${viewMode === 'subscription' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setViewMode('subscription')}
          >
            By subscription
          </button>
        </div>
        {activeFilterCount > 0 ? (
          <button className="btn btn-ghost" type="button" onClick={clearAllFilters}>
            <X size={16} /> Clear column filters ({activeFilterCount})
          </button>
        ) : null}
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => {
            const columns = [
              { key: 'callFirst', label: 'Call-first rank' },
              { key: 'scope', label: 'Scope' },
              { key: 'name', label: 'Customer' },
              { key: 'owner', label: 'CSA owner' },
              { key: 'level', label: 'Risk' },
              { key: 'score', label: 'Score' },
              { key: 'why', label: 'Why' },
              { key: 'factors', label: 'Factor details' },
              { key: 'warnings', label: 'Warnings' },
            ]
            const exportRows =
              viewMode === 'subscription'
                ? rows
                : rows.flatMap((row) => [
                    row,
                    ...(row.childRisks || []).map((risk) => ({
                      id: riskScopeKey(risk),
                      customerId: row.customerId,
                      customerName: row.customerName,
                      segment: row.segment,
                      ownerName: row.ownerName,
                      scopeLabel: risk.subscriptionName || 'Subscription',
                      isSubscription: true,
                      subscriptionId: risk.subscriptionId,
                      risk,
                      callFirst: subscriptionTriageOrder.get(riskScopeKey(risk)) ?? 9999,
                    })),
                  ])
            exportToExcel(
              'customer-capacity-risk',
              'Capacity risk',
              columns,
              exportRows.map((row) => ({
                callFirst: row.callFirst,
                scope: row.scopeLabel,
                name: row.customerName,
                owner: row.ownerName,
                level: row.risk.level,
                score: row.risk.score,
                why: row.risk.summary,
                factors: row.risk.factors.map((f) => f.detail).join(' | '),
                warnings: row.risk.warnings.map((w) => w.detail).join(' | '),
              })),
            )
          }}
        >
          <Download size={16} /> Export to Excel
        </button>
        <Link className="btn btn-ghost" to="/customers">
          Portfolio list
        </Link>
      </div>

      <section className="panel">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {(
                  [
                    ['callFirst', 'Call first'],
                    ['scope', 'Scope'],
                    ['name', 'Customer'],
                    ['owner', 'CSA owner'],
                    ['level', 'Risk'],
                    ['score', 'Score'],
                    ['why', 'Why'],
                  ] as Array<[RiskSortKey, string]>
                ).map(([column, label]) => (
                  <FilterableTh
                    key={column}
                    label={label}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={(c) => toggleSort(c as RiskSortKey)}
                    options={columnOptions[column]}
                    selected={filters[column]}
                    onFilterChange={(values) => setColumnFilter(column, values)}
                  />
                ))}
                <th>Drivers</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => {
                const expanded =
                  viewMode === 'customer' &&
                  !row.isSubscription &&
                  expandedCustomers.has(row.customerId)
                const childRows =
                  viewMode === 'customer' && !row.isSubscription
                    ? (row.childRisks || []).map((subRisk) => ({
                        id: riskScopeKey(subRisk),
                        customerId: row.customerId,
                        customerName: row.customerName,
                        segment: row.segment,
                        ownerName: row.ownerName,
                        scopeLabel: subRisk.subscriptionName || 'Subscription',
                        isSubscription: true,
                        subscriptionId: subRisk.subscriptionId,
                        risk: subRisk,
                        callFirst: subscriptionTriageOrder.get(riskScopeKey(subRisk)) ?? 9999,
                      }))
                    : []

                const renderRow = (entry: RiskTableRow, nested = false) => (
                  <tr
                    key={entry.id}
                    className={`clickable${nested ? ' risk-sub-row' : ''}`}
                    onClick={() =>
                      navigate(
                        entry.subscriptionId
                          ? `/customers/risk/${entry.customerId}?subscription=${entry.subscriptionId}`
                          : `/customers/risk/${entry.customerId}`,
                      )
                    }
                  >
                    <td>
                      <strong>#{entry.callFirst}</strong>
                    </td>
                    <td>
                      <span className={entry.isSubscription ? 'pill pill-neutral' : 'pill pill-ok'}>
                        {entry.scopeLabel}
                      </span>
                    </td>
                    <td>
                      <div className="risk-name-cell">
                        {!entry.isSubscription &&
                        viewMode === 'customer' &&
                        (row.childRisks?.length || 0) > 0 ? (
                          <button
                            type="button"
                            className="risk-expand-btn"
                            aria-label={expanded ? 'Collapse subscriptions' : 'Expand subscriptions'}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleExpanded(row.customerId)
                            }}
                          >
                            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        ) : null}
                        {nested ? (
                          <span className="risk-sub-name">{entry.scopeLabel}</span>
                        ) : (
                          <>
                            <strong>{entry.customerName}</strong>
                            <div className="muted">{entry.segment}</div>
                          </>
                        )}
                      </div>
                    </td>
                    <td>{entry.ownerName}</td>
                    <td>
                      <span className={riskLevelPillClass(entry.risk.level)}>
                        {entry.risk.level}
                      </span>
                    </td>
                    <td>{entry.risk.score}</td>
                    <td>{entry.risk.summary || '—'}</td>
                    <td>
                      <RiskDriversCell risk={entry.risk} />
                    </td>
                  </tr>
                )

                if (viewMode === 'subscription') {
                  return [renderRow(row)]
                }

                return [renderRow(row), ...(expanded ? childRows.map((child) => renderRow(child, true)) : [])]
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">No rows match the current filters.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
