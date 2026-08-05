import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Download, Plus, Search, Trash2, X } from 'lucide-react'
import { exportToExcel } from '../lib/exportExcel'
import { deleteSavedReport, fetchSavedReports, persistSavedReport } from '../lib/dataApi'
import { useApp } from '../context/AppContext'
import {
  DATASOURCE_LABELS,
  DETAILED_COLUMNS,
  REPORT_SCHEMAS,
  aggregateReportRows,
  buildReportRows,
  defaultAggregations,
  defaultGroupBy,
  dimensionFields,
  getFieldLabel,
  measureFields,
  type AggregationFn,
  type AggregationSpec,
  type ReportDatasource,
  type ReportViewMode,
  type SavedReport,
  type SavedReportVisibility,
} from '../lib/reports'
import { SortableTh, useSortedRows } from '../lib/tableSort'

const AGGREGATION_OPTIONS: Array<{ value: AggregationFn; label: string }> = [
  { value: 'count', label: 'Count rows' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
]

function newAggregationId() {
  return `agg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function ReportsPage() {
  const {
    inventory,
    quotas,
    quotaGroupLimits,
    constraints,
    impactResults,
    customers,
    subscriptions,
    users,
    user,
    portfolioCustomerIds,
    canSeeAllPortfolios,
  } = useApp()

  const [datasource, setDatasource] = useState<ReportDatasource>('inventory')
  const [viewMode, setViewMode] = useState<ReportViewMode>('aggregated')
  const [groupBy, setGroupBy] = useState<string[]>(() => defaultGroupBy('inventory'))
  const [aggregations, setAggregations] = useState<AggregationSpec[]>(() =>
    defaultAggregations('inventory'),
  )
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<string>('customer')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [savedReports, setSavedReports] = useState<SavedReport[]>([])
  const [activeSavedReportId, setActiveSavedReportId] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')
  const [saveVisibility, setSaveVisibility] = useState<SavedReportVisibility>('private')
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [savedReportsError, setSavedReportsError] = useState<string | null>(null)
  const applyingSavedReportRef = useRef(false)

  const schema = REPORT_SCHEMAS[datasource]
  const dimensions = useMemo(() => dimensionFields(schema), [schema])
  const measures = useMemo(() => measureFields(schema), [schema])

  const loadSavedReports = useCallback(async () => {
    try {
      setSavedReportsError(null)
      const data = await fetchSavedReports(user.id)
      setSavedReports(data.reports)
    } catch (err) {
      setSavedReportsError(err instanceof Error ? err.message : 'Failed to load saved reports')
    }
  }, [user.id])

  useEffect(() => {
    void loadSavedReports()
  }, [loadSavedReports])

  useEffect(() => {
    if (applyingSavedReportRef.current) {
      applyingSavedReportRef.current = false
      return
    }
    setGroupBy(defaultGroupBy(datasource))
    setAggregations(defaultAggregations(datasource))
    setSortKey(defaultGroupBy(datasource)[0] || 'customer')
    setSortDir('asc')
    setActiveSavedReportId(null)
  }, [datasource])

  const ctx = useMemo(
    () => ({ customers, subscriptions, users, impactResults }),
    [customers, subscriptions, users, impactResults],
  )

  const sourceRows = useMemo(() => {
    const inventoryRows = inventory.filter(
      (item) => canSeeAllPortfolios || portfolioCustomerIds.includes(item.customerId),
    )
    const quotaRows = quotas.filter(
      (q) =>
        canSeeAllPortfolios ||
        !q.customerId ||
        portfolioCustomerIds.includes(q.customerId),
    )
    const quotaGroupRows = quotaGroupLimits.filter(
      (q) =>
        canSeeAllPortfolios ||
        !q.customerId ||
        portfolioCustomerIds.includes(q.customerId),
    )
    const constraintRows = constraints.filter((constraint) => {
      if (canSeeAllPortfolios) return true
      const touchesPortfolio = impactResults.some(
        (impact) =>
          impact.constraintId === constraint.id &&
          portfolioCustomerIds.includes(impact.customerId),
      )
      return touchesPortfolio || constraint.createdBy === user.id
    })

    return buildReportRows(
      datasource,
      {
        inventory: inventoryRows,
        quotas: quotaRows,
        quotaGroupLimits: quotaGroupRows,
        constraints: constraintRows,
      },
      ctx,
    )
  }, [
    datasource,
    inventory,
    quotas,
    quotaGroupLimits,
    constraints,
    impactResults,
    canSeeAllPortfolios,
    portfolioCustomerIds,
    user.id,
    ctx,
  ])

  const filteredRows = useMemo(() => {
    if (!query) return sourceRows
    const hay = query.toLowerCase()
    return sourceRows.filter((row) =>
      Object.values(row).some((value) => String(value).toLowerCase().includes(hay)),
    )
  }, [sourceRows, query])

  const report = useMemo(() => {
    if (viewMode === 'detailed') {
      const columns = DETAILED_COLUMNS[datasource]
      const columnLabels = Object.fromEntries(
        columns.map((col) => [col, getFieldLabel(schema, col)]),
      )
      return { columns, columnLabels, rows: filteredRows }
    }
    if (groupBy.length === 0) {
      return { columns: [], columnLabels: {}, rows: [] }
    }
    return aggregateReportRows(filteredRows, groupBy, aggregations, schema)
  }, [viewMode, datasource, filteredRows, groupBy, aggregations, schema])

  useEffect(() => {
    if (report.columns.length > 0 && !report.columns.includes(sortKey)) {
      setSortKey(report.columns[0])
    }
  }, [report.columns, sortKey])

  const getSortValue = useCallback((row: (typeof report.rows)[number], key: string) => {
    const value = row[key]
    if (typeof value === 'number') return value
    const asNumber = Number(String(value).replace(/%$/, ''))
    if (Number.isFinite(asNumber) && String(value).match(/^-?\d/)) return asNumber
    return value
  }, [])

  const sortedRows = useSortedRows(report.rows, sortKey, sortDir, getSortValue)

  function toggleGroupBy(field: string) {
    setActiveSavedReportId(null)
    setGroupBy((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    )
  }

  function updateAggregation(id: string, patch: Partial<AggregationSpec>) {
    setActiveSavedReportId(null)
    setAggregations((prev) =>
      prev.map((spec) => (spec.id === id ? { ...spec, ...patch } : spec)),
    )
  }

  function addAggregation() {
    setActiveSavedReportId(null)
    const firstMeasure = measures[0]?.id
    setAggregations((prev) => [
      ...prev,
      { id: newAggregationId(), fn: 'sum', field: firstMeasure },
    ])
  }

  function removeAggregation(id: string) {
    setActiveSavedReportId(null)
    setAggregations((prev) => prev.filter((spec) => spec.id !== id))
  }

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function applySavedReport(report: SavedReport) {
    applyingSavedReportRef.current = true
    setDatasource(report.config.datasource)
    setViewMode(report.config.viewMode)
    setGroupBy(report.config.groupBy)
    setAggregations(
      report.config.aggregations.map((spec) => ({
        ...spec,
        id: spec.id || newAggregationId(),
      })),
    )
    setSortKey(report.config.groupBy[0] || DETAILED_COLUMNS[report.config.datasource][0] || 'customer')
    setSortDir('asc')
    setQuery('')
    setActiveSavedReportId(report.id)
    setSaveStatus(null)
  }

  async function onSaveReport() {
    const name = saveName.trim()
    if (!name) {
      setSaveStatus('Enter a name for this report.')
      return
    }
    try {
      setSaveStatus(null)
      const saved = await persistSavedReport({
        name,
        ownerUserId: user.id,
        visibility: saveVisibility,
        config: {
          datasource,
          viewMode,
          groupBy,
          aggregations,
        },
      })
      setSavedReports((prev) => [saved, ...prev.filter((report) => report.id !== saved.id)])
      setActiveSavedReportId(saved.id)
      setSaveName('')
      setSaveStatus(`Saved "${saved.name}" as ${saved.visibility}.`)
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : 'Failed to save report')
    }
  }

  async function onDeleteSavedReport(report: SavedReport) {
    if (report.ownerUserId !== user.id) return
    try {
      await deleteSavedReport(report.id, user.id)
      setSavedReports((prev) => prev.filter((item) => item.id !== report.id))
      if (activeSavedReportId === report.id) {
        setActiveSavedReportId(null)
      }
      setSaveStatus(`Deleted "${report.name}".`)
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : 'Failed to delete saved report')
    }
  }

  const activeSavedReport = savedReports.find((report) => report.id === activeSavedReportId) || null

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Reports</h3>
          <p>
            Build detailed or aggregated views across inventory, quotas, quota groups, and
            constraints. Group dimensions and choose how numeric fields are aggregated.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Report builder</h4>
            <p>Choose a datasource, view mode, and aggregation settings.</p>
          </div>
        </div>
        <div className="form-grid" style={{ padding: '0 1rem 1rem' }}>
          <div className="field full">
            <label>Saved reports</label>
            {savedReportsError ? <p className="field-hint" style={{ color: 'var(--danger)' }}>{savedReportsError}</p> : null}
            {savedReports.length === 0 ? (
              <div className="empty" style={{ padding: '0.85rem' }}>
                No saved reports yet. Configure a report below and save it for quick access.
              </div>
            ) : (
              <div className="stack" style={{ gap: '0.45rem' }}>
                {savedReports.map((report) => (
                  <div
                    key={report.id}
                    className={`list-row list-row-compact${activeSavedReportId === report.id ? ' selected' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => applySavedReport(report)}
                  >
                    <div className="exposure-line" style={{ flex: 1 }}>
                      <strong>{report.name}</strong>
                      <span className="muted">
                        · {DATASOURCE_LABELS[report.config.datasource]} ·{' '}
                        {report.config.viewMode === 'detailed' ? 'Detailed' : 'Aggregated'}
                      </span>
                      <span
                        className={`pill ${report.visibility === 'shared' ? 'pill-neutral' : 'pill-ok'}`}
                      >
                        {report.visibility === 'shared' ? 'Shared' : 'Private'}
                      </span>
                    </div>
                    {report.ownerUserId === user.id ? (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        aria-label={`Delete ${report.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          void onDeleteSavedReport(report)
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {activeSavedReport ? (
              <p className="field-hint">
                Loaded: <strong>{activeSavedReport.name}</strong>
              </p>
            ) : null}
          </div>

          <div className="field full">
            <label>Save current report</label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 0.8fr auto',
                gap: '0.55rem',
                alignItems: 'end',
              }}
            >
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="saved-report-name">Name</label>
                <input
                  id="saved-report-name"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="e.g. Quotas by customer and region"
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="saved-report-visibility">Visibility</label>
                <select
                  id="saved-report-visibility"
                  value={saveVisibility}
                  onChange={(e) => setSaveVisibility(e.target.value as SavedReportVisibility)}
                >
                  <option value="private">Private (only me)</option>
                  <option value="shared">Shared (all users)</option>
                </select>
              </div>
              <button className="btn btn-secondary" type="button" onClick={() => void onSaveReport()}>
                <Bookmark size={16} /> Save report
              </button>
            </div>
            {saveStatus ? <p className="field-hint">{saveStatus}</p> : null}
          </div>

          <div className="field">
            <label htmlFor="report-datasource">Data source</label>
            <select
              id="report-datasource"
              value={datasource}
              onChange={(e) => setDatasource(e.target.value as ReportDatasource)}
            >
              {(Object.keys(DATASOURCE_LABELS) as ReportDatasource[]).map((key) => (
                <option key={key} value={key}>
                  {DATASOURCE_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="report-view-mode">View</label>
            <select
              id="report-view-mode"
              value={viewMode}
              onChange={(e) => {
                setActiveSavedReportId(null)
                setViewMode(e.target.value as ReportViewMode)
              }}
            >
              <option value="detailed">Detailed rows</option>
              <option value="aggregated">Aggregated</option>
            </select>
          </div>

          {viewMode === 'aggregated' ? (
            <>
              <div className="field full">
                <label>Group by</label>
                <div className="chips">
                  {dimensions.map((field) => (
                    <button
                      key={field.id}
                      type="button"
                      className={`chip${groupBy.includes(field.id) ? ' active' : ''}`}
                      onClick={() => toggleGroupBy(field.id)}
                    >
                      {field.label}
                    </button>
                  ))}
                </div>
                <p className="field-hint">
                  Select one or more dimensions. Aggregations run within each group.
                </p>
              </div>

              <div className="field full">
                <label>Aggregations</label>
                <div className="stack" style={{ gap: '0.55rem' }}>
                  {aggregations.map((spec) => (
                    <div
                      key={spec.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1.2fr 1.2fr auto',
                        gap: '0.55rem',
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={spec.fn}
                        onChange={(e) =>
                          updateAggregation(spec.id, {
                            fn: e.target.value as AggregationFn,
                            field: e.target.value === 'count' ? undefined : spec.field,
                          })
                        }
                      >
                        {AGGREGATION_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={spec.field || ''}
                        disabled={spec.fn === 'count'}
                        onChange={(e) =>
                          updateAggregation(spec.id, { field: e.target.value || undefined })
                        }
                      >
                        <option value="">Select measure…</option>
                        {measures.map((field) => (
                          <option key={field.id} value={field.id}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => removeAggregation(spec.id)}
                        aria-label="Remove aggregation"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                  <button className="btn btn-secondary" type="button" onClick={addAggregation}>
                    <Plus size={16} /> Add aggregation
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search report results"
          />
        </div>
        {query ? (
          <button className="btn btn-ghost" type="button" onClick={() => setQuery('')}>
            <X size={16} /> Clear search
          </button>
        ) : null}
        <button
          className="btn btn-secondary"
          type="button"
          disabled={sortedRows.length === 0}
          onClick={() => {
            const columns = report.columns.map((col) => ({
              key: col,
              label: report.columnLabels[col] || col,
            }))
            exportToExcel(
              `report-${datasource}-${viewMode}`,
              DATASOURCE_LABELS[datasource],
              columns,
              sortedRows as Record<string, unknown>[],
            )
          }}
        >
          <Download size={16} /> Export to Excel
        </button>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>
              {DATASOURCE_LABELS[datasource]} ·{' '}
              {viewMode === 'detailed' ? 'Detailed view' : 'Aggregated view'}
            </h4>
            <p>
              {sortedRows.length} of {sourceRows.length} row{sourceRows.length === 1 ? '' : 's'}
              {viewMode === 'aggregated' && groupBy.length > 0
                ? ` · grouped by ${groupBy.map((f) => getFieldLabel(schema, f)).join(', ')}`
                : ''}
            </p>
          </div>
        </div>
        <div className="table-wrap">
          {report.columns.length === 0 ? (
            <div className="empty" style={{ padding: '1.5rem' }}>
              {viewMode === 'aggregated'
                ? 'Select at least one Group by dimension to build an aggregated report.'
                : 'No data available for this datasource.'}
            </div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  {report.columns.map((column) => (
                    <SortableTh
                      key={column}
                      label={report.columnLabels[column] || column}
                      column={column}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={report.columns.length}>
                      <div className="empty">No rows match the current search.</div>
                    </td>
                  </tr>
                ) : (
                  sortedRows.map((row, index) => (
                    <tr key={`${index}-${String(row[report.columns[0]])}`}>
                      {report.columns.map((column) => (
                        <td key={column}>
                          {column === report.columns[0] ? (
                            <strong>{String(row[column] ?? '—')}</strong>
                          ) : (
                            String(row[column] ?? '—')
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
