import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Download, History, MapPinned, X } from 'lucide-react'
import { useApp } from '../context/AppContext'
import type {
  RegionEvalLineItem,
  RegionEvalRegionResult,
  RegionEvalStatus,
  SavedRegionEvaluation,
} from '../lib/azureApi'
import { fetchRegionEvaluation, fetchRegionEvaluations } from '../lib/dataApi'
import { exportSheetsToExcel } from '../lib/exportExcel'
import { formatDate } from '../lib/format'
import { formatRegionMoney, sumMonthly } from '../lib/regionCost'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'

type TotalsRow = {
  subscriptionId: string
  subscriptionName: string
  sourceMonthly: number | null
  byTarget: Record<string, number | null>
}

type DetailSortKey = string

function targetColumnKey(regionId: string) {
  return `target:${regionId}`
}

function isTargetAvailable(cell: RegionEvalRegionResult | undefined | null) {
  return (cell?.status || 'unknown') === 'available'
}

function targetMonthlyCost(cell: RegionEvalRegionResult | undefined | null) {
  if (!isTargetAvailable(cell)) return null
  return cell?.monthlyTotalPrice ?? cell?.monthlyUnitPrice ?? null
}

function sourceMonthlyCost(item: RegionEvalLineItem) {
  return item.sourceCost?.monthlyTotalPrice ?? item.sourceCost?.monthlyUnitPrice ?? null
}

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

function CostBarChart({
  rows,
  targetRegions,
}: {
  rows: TotalsRow[]
  targetRegions: Array<{ id: string; label: string }>
}) {
  const seriesKeys = [
    { id: '__source__', label: 'Source' },
    ...targetRegions.map((region) => ({ id: region.id, label: region.label })),
  ]

  const values = rows.flatMap((row) => [
    row.sourceMonthly ?? 0,
    ...targetRegions.map((region) => row.byTarget[region.id] ?? 0),
  ])
  const max = Math.max(...values, 1)

  if (rows.length === 0) {
    return <div className="empty">No subscription totals to chart.</div>
  }

  return (
    <div className="cost-bar-chart" role="img" aria-label="Total monthly cost per subscription">
      <div className="cost-bar-legend">
        {seriesKeys.map((series, index) => (
          <span key={series.id} className="cost-bar-legend-item">
            <span className={`cost-bar-swatch tone-${index % 5}`} />
            {series.label}
          </span>
        ))}
      </div>
      <div className="cost-bar-rows">
        {rows.map((row) => (
          <div key={row.subscriptionId} className="cost-bar-row">
            <div className="cost-bar-label" title={row.subscriptionName}>
              {row.subscriptionName}
            </div>
            <div className="cost-bar-tracks">
              {seriesKeys.map((series, index) => {
                const value =
                  series.id === '__source__'
                    ? row.sourceMonthly
                    : row.byTarget[series.id]
                const width = value != null ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0
                return (
                  <div key={series.id} className="cost-bar-track">
                    <div
                      className={`cost-bar-fill tone-${index % 5}`}
                      style={{ width: `${width}%` }}
                      title={`${series.label}: ${formatRegionMoney(value) || 'n/a'}`}
                    />
                    <span className="cost-bar-value">
                      {formatRegionMoney(value) || 'n/a'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function RegionCostAnalysisPage() {
  const { customers, portfolioCustomerIds, canSeeAllPortfolios } = useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const evaluationId = searchParams.get('evaluationId') || ''

  const [evaluations, setEvaluations] = useState<SavedRegionEvaluation[]>([])
  const [selected, setSelected] = useState<SavedRegionEvaluation | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { sortKey, sortDir, toggleSort } = useSortState<DetailSortKey>('subscription')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<DetailSortKey>()

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

  useEffect(() => {
    void (async () => {
      setLoadingList(true)
      setError(null)
      try {
        const data = await fetchRegionEvaluations()
        setEvaluations(
          data.evaluations.filter((evaluation) => visibleCustomerIds.has(evaluation.customerId)),
        )
      } catch (err) {
        setEvaluations([])
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingList(false)
      }
    })()
  }, [visibleCustomerIds])

  useEffect(() => {
    if (!evaluationId) {
      setSelected(null)
      return
    }
    void (async () => {
      setLoadingDetail(true)
      setError(null)
      try {
        const detail = await fetchRegionEvaluation(evaluationId)
        if (!visibleCustomerIds.has(detail.customerId)) {
          setSelected(null)
          setError('Evaluation is outside your portfolio.')
          return
        }
        setSelected(detail)
      } catch (err) {
        setSelected(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingDetail(false)
      }
    })()
  }, [evaluationId, visibleCustomerIds])

  const evaluationOptions = useMemo(() => {
    return evaluations.map((evaluation) => ({
      value: evaluation.id,
      label: `${evaluation.customerName} · ${formatDate(evaluation.createdAt)}`,
    }))
  }, [evaluations])

  const totals = useMemo(() => {
    if (!selected) return [] as TotalsRow[]
    const map = new Map<string, TotalsRow>()
    for (const item of selected.lineItems || []) {
      const existing =
        map.get(item.subscriptionId) ||
        ({
          subscriptionId: item.subscriptionId,
          subscriptionName: item.subscriptionName,
          sourceMonthly: null,
          byTarget: {},
        } as TotalsRow)

      const sourceValues = [
        existing.sourceMonthly,
        item.sourceCost?.monthlyTotalPrice ?? item.sourceCost?.monthlyUnitPrice,
      ]
      existing.sourceMonthly = sumMonthly(sourceValues)

      for (const region of selected.targetRegions || []) {
        const cell = item.byRegion?.[region.id]
        const next = targetMonthlyCost(cell)
        existing.byTarget[region.id] = sumMonthly([existing.byTarget[region.id], next])
      }
      map.set(item.subscriptionId, existing)
    }
    return [...map.values()].sort((a, b) => a.subscriptionName.localeCompare(b.subscriptionName))
  }, [selected])

  const grandTotals = useMemo(() => {
    if (!selected) return null
    return {
      source: sumMonthly(totals.map((row) => row.sourceMonthly)),
      byTarget: Object.fromEntries(
        (selected.targetRegions || []).map((region) => [
          region.id,
          sumMonthly(totals.map((row) => row.byTarget[region.id])),
        ]),
      ) as Record<string, number | null>,
    }
  }, [selected, totals])

  const detailColumns = useMemo(() => {
    if (!selected) return [] as Array<[DetailSortKey, string]>
    return [
      ['subscription', 'Subscription'],
      ['resource', 'Resource'],
      ['type', 'Type'],
      ['sku', 'SKU'],
      ['sourceRegion', 'Source region'],
      ['sourceMonthly', 'Source /mo'],
      ...(selected.targetRegions || []).map(
        (region) =>
          [targetColumnKey(region.id), `${region.label} /mo`] as [DetailSortKey, string],
      ),
    ]
  }, [selected])

  const getDetailValue = useCallback(
    (item: RegionEvalLineItem, key: string) => {
      if (key === 'subscription') return item.subscriptionName
      if (key === 'resource') return item.resourceName
      if (key === 'type') return item.resourceType
      if (key === 'sku') return item.sku
      if (key === 'sourceRegion') return item.sourceRegion || '—'
      if (key === 'sourceMonthly') {
        return (
          formatRegionMoney(sourceMonthlyCost(item), item.sourceCost?.currencyCode) || '—'
        )
      }
      if (key.startsWith('target:')) {
        const regionId = key.slice('target:'.length)
        const cell = item.byRegion?.[regionId]
        if (!isTargetAvailable(cell)) {
          return statusLabel((cell?.status || 'unknown') as RegionEvalStatus)
        }
        return (
          formatRegionMoney(
            cell?.monthlyTotalPrice ?? cell?.monthlyUnitPrice,
            cell?.currencyCode,
          ) || '—'
        )
      }
      return ''
    },
    [],
  )

  const getDetailSortValue = useCallback(
    (item: RegionEvalLineItem, key: string) => {
      if (key === 'sourceMonthly') return sourceMonthlyCost(item) ?? Number.POSITIVE_INFINITY
      if (key.startsWith('target:')) {
        const regionId = key.slice('target:'.length)
        const cell = item.byRegion?.[regionId]
        if (!isTargetAvailable(cell)) {
          const status = (cell?.status || 'unknown') as RegionEvalStatus
          const rank: Record<RegionEvalStatus, number> = {
            available: 0,
            restricted: 1_000_000_001,
            unavailable: 1_000_000_002,
            unknown: 1_000_000_003,
          }
          return rank[status] ?? 1_000_000_009
        }
        return targetMonthlyCost(cell) ?? Number.POSITIVE_INFINITY
      }
      return getDetailValue(item, key)
    },
    [getDetailValue],
  )

  const lineItems = selected?.lineItems || []

  const filteredLineItems = useMemo(() => {
    return lineItems.filter((item) =>
      matchesColumnFilters((column) => String(getDetailValue(item, column) ?? '')),
    )
  }, [lineItems, matchesColumnFilters, getDetailValue])

  const detailRows = useSortedRows(
    filteredLineItems,
    sortKey,
    sortDir,
    getDetailSortValue,
  )

  const detailColumnKeys = useMemo(
    () => detailColumns.map(([key]) => key),
    [detailColumns],
  )

  const detailColumnOptions = useMemo(
    () => collectCascadingOptions(lineItems, detailColumnKeys, filters, getDetailValue),
    [lineItems, detailColumnKeys, filters, getDetailValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(detailColumnOptions)
  }, [detailColumnOptions, pruneFiltersToOptions])

  useEffect(() => {
    clearAllFilters()
  }, [evaluationId, clearAllFilters])

  function onExportExcel() {
    if (!selected) return
    const safeCustomer = selected.customerName
      .replace(/[^\w\-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40)
    const stamp = selected.createdAt.slice(0, 10)
    const filename = `cost-analysis_${safeCustomer}_${stamp}`

    const targetCols = (selected.targetRegions || []).map((region) => ({
      key: targetColumnKey(region.id),
      label: `${region.label} /mo`,
    }))

    const totalsColumns = [
      { key: 'subscription', label: 'Subscription' },
      { key: 'sourceMonthly', label: 'Source total /mo' },
      ...targetCols,
    ]
    const totalsRows = [
      ...totals.map((row) => {
        const obj: Record<string, unknown> = {
          subscription: row.subscriptionName,
          sourceMonthly: formatRegionMoney(row.sourceMonthly) || '',
        }
        for (const region of selected.targetRegions || []) {
          obj[targetColumnKey(region.id)] =
            formatRegionMoney(row.byTarget[region.id]) || ''
        }
        return obj
      }),
      {
        subscription: 'Grand total',
        sourceMonthly: formatRegionMoney(grandTotals?.source) || '',
        ...Object.fromEntries(
          (selected.targetRegions || []).map((region) => [
            targetColumnKey(region.id),
            formatRegionMoney(grandTotals?.byTarget[region.id]) || '',
          ]),
        ),
      },
    ]

    const detailExportColumns = detailColumns.map(([key, label]) => ({ key, label }))
    const detailExportRows = detailRows.map((item) => {
      const obj: Record<string, unknown> = {}
      for (const [key] of detailColumns) obj[key] = getDetailValue(item, key)
      return obj
    })

    exportSheetsToExcel(filename, [
      {
        name: 'Summary',
        columns: [
          { key: 'field', label: 'Field' },
          { key: 'value', label: 'Value' },
        ],
        rows: [
          { field: 'Customer', value: selected.customerName },
          { field: 'Evaluation ID', value: selected.id },
          { field: 'Run at', value: formatDate(selected.createdAt) },
          {
            field: 'Subscriptions',
            value:
              (selected.subscriptionNames || []).join(', ') ||
              `${selected.subscriptionIds.length} subscription(s)`,
          },
          {
            field: 'Target regions',
            value: (selected.targetRegions || []).map((r) => r.label || r.id).join(', '),
          },
          { field: 'Resources', value: selected.lineItems?.length || 0 },
          {
            field: 'Source monthly total',
            value: formatRegionMoney(grandTotals?.source) || 'n/a',
          },
          {
            field: 'Exported detail rows',
            value: `${detailRows.length} of ${lineItems.length} (after filters)`,
          },
        ],
      },
      {
        name: 'Totals by subscription',
        columns: totalsColumns,
        rows: totalsRows,
      },
      {
        name: 'Detailed resource costs',
        columns: detailExportColumns,
        rows: detailExportRows,
      },
    ])
  }

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Cost analysis</h3>
          <p>
            Compare source vs target region retail costs for a saved evaluation — detail rows,
            subscription totals, and a bar chart.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {selected && !loadingDetail ? (
            <button className="btn btn-secondary" type="button" onClick={onExportExcel}>
              <Download size={16} /> Export to Excel
            </button>
          ) : null}
          <Link className="btn btn-secondary" to="/region-evaluation">
            <MapPinned size={16} /> Run evaluation
          </Link>
          <Link className="btn btn-ghost" to="/region-evaluation/history">
            <History size={16} /> Evaluations
          </Link>
        </div>
      </div>

      <section className="panel">
        <div className="panel-body">
          <label className="field">
            <span>Saved evaluation</span>
            <select
              value={evaluationId}
              disabled={loadingList}
              onChange={(e) => {
                const value = e.target.value
                if (value) setSearchParams({ evaluationId: value })
                else setSearchParams({})
              }}
            >
              <option value="">Select an evaluation</option>
              {evaluationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {error ? <div className="banner banner-error">{error}</div> : null}
      {loadingDetail ? <div className="empty">Loading evaluation…</div> : null}

      {selected && !loadingDetail ? (
        <>
          <div className="grid-3">
            <div className="metric-card">
              <div className="label">Customer</div>
              <div className="value" style={{ fontSize: '1.15rem' }}>
                {selected.customerName}
              </div>
              <div className="hint">{formatDate(selected.createdAt)}</div>
            </div>
            <div className="metric-card">
              <div className="label">Source monthly total</div>
              <div className="value" style={{ fontSize: '1.25rem' }}>
                {formatRegionMoney(grandTotals?.source) || 'n/a'}
              </div>
              <div className="hint">Retail estimate across selected subscriptions</div>
            </div>
            <div className="metric-card">
              <div className="label">Resources priced</div>
              <div className="value">{selected.lineItems?.length || 0}</div>
              <div className="hint">
                {(selected.subscriptionNames || []).join(', ') ||
                  `${selected.subscriptionIds.length} subscription(s)`}
              </div>
            </div>
          </div>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Totals per subscription</h4>
                <p>Estimated monthly retail cost — source region vs each target region.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Subscription</th>
                    <th>Source total /mo</th>
                    {(selected.targetRegions || []).map((region) => (
                      <th key={region.id}>{region.label} /mo</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {totals.map((row) => (
                    <tr key={row.subscriptionId}>
                      <td>
                        <strong>{row.subscriptionName}</strong>
                      </td>
                      <td>{formatRegionMoney(row.sourceMonthly) || '—'}</td>
                      {(selected.targetRegions || []).map((region) => (
                        <td key={region.id}>
                          {formatRegionMoney(row.byTarget[region.id]) || '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Grand total</strong>
                    </td>
                    <td>
                      <strong>{formatRegionMoney(grandTotals?.source) || '—'}</strong>
                    </td>
                    {(selected.targetRegions || []).map((region) => (
                      <td key={region.id}>
                        <strong>
                          {formatRegionMoney(grandTotals?.byTarget[region.id]) || '—'}
                        </strong>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Cost per subscription</h4>
                <p>Bar length is relative to the highest monthly total in this evaluation.</p>
              </div>
            </div>
            <div className="panel-body">
              <CostBarChart rows={totals} targetRegions={selected.targetRegions || []} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Detailed resource costs</h4>
                <p>
                  {detailRows.length} of {lineItems.length} resources · click a column to filter or
                  sort. Unavailable target regions show status instead of price.
                </p>
              </div>
              {activeFilterCount > 0 ? (
                <button className="btn btn-ghost" type="button" onClick={clearAllFilters}>
                  <X size={16} /> Clear filters ({activeFilterCount})
                </button>
              ) : null}
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {detailColumns.map(([column, label]) => (
                      <FilterableTh
                        key={column}
                        label={label}
                        column={column}
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={(c) => toggleSort(c as DetailSortKey)}
                        options={detailColumnOptions[column] || []}
                        selected={filters[column]}
                        onFilterChange={(values) => setColumnFilter(column, values)}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((item, index) => (
                    <tr key={`${item.subscriptionId}-${item.resourceName}-${index}`}>
                      <td>{item.subscriptionName}</td>
                      <td>
                        <strong>{item.resourceName}</strong>
                      </td>
                      <td>{item.resourceType}</td>
                      <td>
                        {item.sku}
                        {item.size ? <div className="muted">{item.size}</div> : null}
                      </td>
                      <td>{item.sourceRegion || '—'}</td>
                      <td>
                        {formatRegionMoney(
                          sourceMonthlyCost(item),
                          item.sourceCost?.currencyCode,
                        ) || '—'}
                      </td>
                      {(selected?.targetRegions || []).map((region) => {
                        const cell = item.byRegion?.[region.id]
                        const status = (cell?.status || 'unknown') as RegionEvalStatus
                        if (!isTargetAvailable(cell)) {
                          return (
                            <td
                              key={region.id}
                              className="cost-unavailable"
                              title={cell?.reason || statusLabel(status)}
                            >
                              <span className={`pill ${statusTone(status)}`}>
                                {statusLabel(status)}
                              </span>
                            </td>
                          )
                        }
                        return (
                          <td key={region.id}>
                            {formatRegionMoney(
                              cell?.monthlyTotalPrice ?? cell?.monthlyUnitPrice,
                              cell?.currencyCode,
                            ) || '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  {detailRows.length === 0 ? (
                    <tr>
                      <td colSpan={Math.max(detailColumns.length, 1)}>
                        <div className="empty">
                          {lineItems.length === 0
                            ? 'No line items stored for this evaluation.'
                            : 'No resources match the current column filters.'}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {!evaluationId && !loadingList && !loadingDetail ? (
        <div className="empty">
          Select a saved evaluation, or run a new one from{' '}
          <Link to="/region-evaluation">Region evaluation</Link>.
        </div>
      ) : null}
    </div>
  )
}
