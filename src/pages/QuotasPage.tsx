import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Search, X } from 'lucide-react'
import { exportToExcel } from '../lib/exportExcel'
import { useApp } from '../context/AppContext'
import { formatDate, usageTone } from '../lib/format'
import { groupQuotasByProvider, resolveQuotaProvider } from '../lib/quotaProviders'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'

type QuotaSortKey =
  | 'name'
  | 'customer'
  | 'subscription'
  | 'region'
  | 'usage'
  | 'source'
  | 'provider'
  | 'retrieved'

const QUOTA_FILTER_COLUMNS: Array<[QuotaSortKey, string]> = [
  ['name', 'Quota'],
  ['provider', 'Provider'],
  ['customer', 'Customer'],
  ['subscription', 'Subscription'],
  ['region', 'Region'],
  ['usage', 'Usage'],
  ['source', 'Source'],
  ['retrieved', 'Retrieved'],
]

export function QuotasPage() {
  const { quotas, customers, subscriptions, portfolioCustomerIds, canSeeAllPortfolios } = useApp()
  const [query, setQuery] = useState('')
  const [hideUnused, setHideUnused] = useState(true)
  const { sortKey, sortDir, toggleSort } = useSortState<QuotaSortKey>('usage', 'desc')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<QuotaSortKey>()

  const getValue = useCallback(
    (q: (typeof quotas)[number], key: string) => {
      const customer = customers.find((c) => c.id === q.customerId)
      const sub = subscriptions.find((s) => s.id === q.subscriptionId)
      switch (key) {
        case 'customer':
          return customer?.name || '—'
        case 'subscription':
          return q.subscriptionName || sub?.name || '—'
        case 'provider':
          return resolveQuotaProvider(q)
        case 'usage':
          return `${q.usage}/${q.limit} ${q.unit}`
        case 'source':
          return q.source || 'Stored'
        case 'retrieved':
          return q.collectedAt ? formatDate(q.collectedAt) : '—'
        default:
          return q[key as keyof typeof q]
      }
    },
    [customers, subscriptions],
  )

  const getSortValue = useCallback(
    (q: (typeof quotas)[number], key: string) => {
      if (key === 'usage') return q.usage
      if (key === 'retrieved') return q.collectedAt || ''
      return getValue(q, key)
    },
    [getValue],
  )

  const baseRows = useMemo(() => {
    return quotas.filter((q) => {
      if (
        !canSeeAllPortfolios &&
        q.customerId &&
        !portfolioCustomerIds.includes(q.customerId)
      ) {
        return false
      }
      if (hideUnused && (!q.usage || q.usage <= 0)) return false
      const customer = customers.find((c) => c.id === q.customerId)
      const provider = resolveQuotaProvider(q)
      const hay =
        `${q.name} ${q.region} ${provider} ${customer?.name ?? ''} ${q.subscriptionName ?? ''}`.toLowerCase()
      return !query || hay.includes(query.toLowerCase())
    })
  }, [quotas, customers, portfolioCustomerIds, canSeeAllPortfolios, query, hideUnused])

  const filtered = useMemo(() => {
    return baseRows.filter((q) =>
      matchesColumnFilters((column) => String(getValue(q, column) ?? '')),
    )
  }, [baseRows, matchesColumnFilters, getValue])

  const rows = useSortedRows(filtered, sortKey, sortDir, getSortValue)
  const grouped = useMemo(() => groupQuotasByProvider(rows), [rows])

  const columnKeys = QUOTA_FILTER_COLUMNS.map(([key]) => key)

  const columnOptions = useMemo(
    () => collectCascadingOptions(baseRows, columnKeys, filters, getValue),
    [baseRows, filters, getValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(columnOptions)
  }, [columnOptions, pruneFiltersToOptions])

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Quotas</h3>
          <p>
            Individual quota line items from PostgreSQL, grouped under Azure providers. Click a column
            name to filter values.
          </p>
        </div>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search quota, provider, customer, or region"
          />
        </div>
        <label className="switch-field" title="Toggle quotas with zero usage">
          <span className="switch">
            <input
              type="checkbox"
              checked={hideUnused}
              onChange={(e) => setHideUnused(e.target.checked)}
            />
            <span className="switch-track" aria-hidden />
          </span>
          <span className="switch-label">Hide unused quotas</span>
        </label>
        {activeFilterCount > 0 ? (
          <button className="btn btn-ghost" type="button" onClick={clearAllFilters}>
            <X size={16} /> Clear column filters ({activeFilterCount})
          </button>
        ) : null}
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() =>
            exportToExcel('quotas', 'Quotas', QUOTA_FILTER_COLUMNS.map(([key, label]) => ({ key, label })), rows.map((q) => {
              const obj: Record<string, unknown> = {}
              for (const [key] of QUOTA_FILTER_COLUMNS) obj[key] = getValue(q, key)
              return obj
            }))
          }
        >
          <Download size={16} /> Export to Excel
        </button>
      </div>

      {/* Stable filter header — must stay mounted so Select/Deselect all does not close the menu */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Quotas</h4>
            <p>
              {rows.length} of {baseRows.length} matching
              {grouped.length > 0 ? ` · ${grouped.length} provider groups` : ''}
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {QUOTA_FILTER_COLUMNS.map(([column, label]) => (
                  <FilterableTh
                    key={column}
                    label={label}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={(c) => toggleSort(c as QuotaSortKey)}
                    options={columnOptions[column]}
                    selected={filters[column]}
                    onFilterChange={(values) => setColumnFilter(column, values)}
                  />
                ))}
              </tr>
            </thead>
            {grouped.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={QUOTA_FILTER_COLUMNS.length}>
                    <div className="empty">
                      No quota rows match the current filters. Adjust column filters, or use Clear
                      column filters above. Use Azure Connect to collect quotas if none are stored.
                    </div>
                  </td>
                </tr>
              </tbody>
            ) : null}
          </table>
        </div>
      </section>

      {grouped.map(({ provider, items }) => (
        <section key={provider} className="panel">
          <div className="panel-header">
            <div>
              <h4>{provider}</h4>
              <p>
                {items.length} quota{items.length === 1 ? '' : 's'} in this provider group
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {QUOTA_FILTER_COLUMNS.map(([column, label]) => (
                    <th key={column}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((q) => {
                  const customer = customers.find((c) => c.id === q.customerId)
                  const sub = subscriptions.find((s) => s.id === q.subscriptionId)
                  const pct = q.limit ? Math.round((q.usage / q.limit) * 100) : 0
                  const tone = usageTone(q.usage, Math.max(q.limit, 1))
                  return (
                    <tr key={q.id}>
                      <td>
                        <strong>{q.name}</strong>
                      </td>
                      <td>{resolveQuotaProvider(q)}</td>
                      <td>{customer?.name || '—'}</td>
                      <td>{q.subscriptionName || sub?.name || '—'}</td>
                      <td>{q.region}</td>
                      <td style={{ minWidth: 180 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>
                            {q.usage}/{q.limit} {q.unit}
                          </span>
                          <span className="muted">{pct}%</span>
                        </div>
                        <div className={`progress ${tone}`} style={{ marginTop: '0.4rem' }}>
                          <span style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                      </td>
                      <td>
                        <span className="pill pill-neutral">{q.source || 'Stored'}</span>
                      </td>
                      <td className="muted">
                        {q.collectedAt ? formatDate(q.collectedAt) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
