import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Search, X } from 'lucide-react'
import { exportToExcel } from '../lib/exportExcel'
import { useApp } from '../context/AppContext'
import { formatDate, usageTone } from '../lib/format'
import { groupQuotaGroupLimitsByEntity } from '../lib/quotaProviders'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'
import type { QuotaGroupLimit, Subscription } from '../types'

type QuotaGroupSortKey =
  | 'name'
  | 'customer'
  | 'managementGroup'
  | 'region'
  | 'usage'
  | 'available'
  | 'subscriptions'
  | 'source'
  | 'retrieved'

const QUOTA_GROUP_COLUMNS: Array<[QuotaGroupSortKey, string]> = [
  ['name', 'Quota'],
  ['customer', 'Customer'],
  ['managementGroup', 'Management group'],
  ['region', 'Region'],
  ['usage', 'Allocated / limit'],
  ['available', 'Available'],
  ['subscriptions', 'Subscriptions'],
  ['source', 'Source'],
  ['retrieved', 'Retrieved'],
]

function formatSubscriptionSummary(subscriptionIds: string[], subscriptions: Subscription[]) {
  if (!subscriptionIds.length) return '—'
  const names = subscriptionIds
    .map((id) => subscriptions.find((s) => s.subscriptionId === id)?.name || id)
    .slice(0, 2)
  const suffix =
    subscriptionIds.length > names.length ? ` +${subscriptionIds.length - names.length}` : ''
  return `${names.join(', ')}${suffix}`
}

export function QuotaGroupsPage() {
  const {
    quotaGroupLimits,
    customers,
    subscriptions,
    portfolioCustomerIds,
    canSeeAllPortfolios,
  } = useApp()
  const [query, setQuery] = useState('')
  const [hideUnused, setHideUnused] = useState(true)
  const { sortKey, sortDir, toggleSort } = useSortState<QuotaGroupSortKey>('usage', 'desc')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<QuotaGroupSortKey>()

  const getValue = useCallback(
    (row: QuotaGroupLimit, key: string) => {
      const customer = customers.find((c) => c.id === row.customerId)
      switch (key) {
        case 'customer':
          return customer?.name || '—'
        case 'managementGroup':
          return row.managementGroupId
        case 'usage':
          return `${row.allocated}/${row.limit} ${row.unit}`
        case 'available':
          return `${row.availableLimit} ${row.unit}`
        case 'subscriptions':
          return formatSubscriptionSummary(row.subscriptionIds, subscriptions)
        case 'source':
          return row.source || 'Stored'
        case 'retrieved':
          return row.collectedAt ? formatDate(row.collectedAt) : '—'
        default:
          return row[key as keyof QuotaGroupLimit]
      }
    },
    [customers, subscriptions],
  )

  const getSortValue = useCallback(
    (row: QuotaGroupLimit, key: string) => {
      if (key === 'usage') return row.allocated
      if (key === 'available') return row.availableLimit
      if (key === 'subscriptions') return row.subscriptionIds.length
      if (key === 'retrieved') return row.collectedAt || ''
      return getValue(row, key)
    },
    [getValue],
  )

  const baseRows = useMemo(() => {
    return quotaGroupLimits.filter((row) => {
      if (
        !canSeeAllPortfolios &&
        row.customerId &&
        !portfolioCustomerIds.includes(row.customerId)
      ) {
        return false
      }
      if (
        hideUnused &&
        row.nameValue !== '__membership__' &&
        row.allocated <= 0 &&
        row.limit <= 0 &&
        row.availableLimit <= 0
      ) {
        return false
      }
      const customer = customers.find((c) => c.id === row.customerId)
      const groupLabel = row.groupDisplayName || row.groupQuotaName
      const subSummary = formatSubscriptionSummary(row.subscriptionIds, subscriptions)
      const hay =
        `${row.name} ${groupLabel} ${row.managementGroupId} ${row.region} ${customer?.name ?? ''} ${subSummary}`.toLowerCase()
      return !query || hay.includes(query.toLowerCase())
    })
  }, [
    quotaGroupLimits,
    customers,
    subscriptions,
    portfolioCustomerIds,
    canSeeAllPortfolios,
    query,
    hideUnused,
  ])

  const filtered = useMemo(() => {
    return baseRows.filter((row) =>
      matchesColumnFilters((column) => String(getValue(row, column) ?? '')),
    )
  }, [baseRows, matchesColumnFilters, getValue])

  const rows = useSortedRows(filtered, sortKey, sortDir, getSortValue)
  const grouped = useMemo(() => groupQuotaGroupLimitsByEntity(rows), [rows])

  const columnKeys = QUOTA_GROUP_COLUMNS.map(([key]) => key)

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
          <h3>Quota groups</h3>
          <p>
            Azure Quota Groups that share and manage quota across multiple subscriptions under a
            management group. Click a column name to filter values.
          </p>
        </div>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search quota, group, customer, or region"
          />
        </div>
        <label className="switch-field" title="Toggle quota group rows with zero allocated and limit">
          <span className="switch">
            <input
              type="checkbox"
              checked={hideUnused}
              onChange={(e) => setHideUnused(e.target.checked)}
            />
            <span className="switch-track" aria-hidden />
          </span>
          <span className="switch-label">Hide unused group limits</span>
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
            exportToExcel('quota-groups', 'Quota Groups', QUOTA_GROUP_COLUMNS.map(([key, label]) => ({ key, label })), rows.map((row) => {
              const obj: Record<string, unknown> = {}
              for (const [key] of QUOTA_GROUP_COLUMNS) obj[key] = getValue(row, key)
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
            <h4>Quota groups</h4>
            <p>
              {rows.length} of {baseRows.length} matching
              {grouped.length > 0 ? ` · ${grouped.length} Azure quota group(s)` : ''}
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {QUOTA_GROUP_COLUMNS.map(([column, label]) => (
                  <FilterableTh
                    key={column}
                    label={label}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={(c) => toggleSort(c as QuotaGroupSortKey)}
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
                  <td colSpan={QUOTA_GROUP_COLUMNS.length}>
                    <div className="empty">
                      No Azure Quota Groups match the current filters. Adjust column filters, or use
                      Clear column filters above. Collect quota groups from Azure Connect if none are
                      stored.
                    </div>
                  </td>
                </tr>
              </tbody>
            ) : null}
          </table>
        </div>
      </section>

      {grouped.map(({ key, label, items }) => {
        const meta = items[0]
        const customer = customers.find((c) => c.id === meta?.customerId)
        return (
          <section key={key} className="panel">
            <div className="panel-header">
              <div>
                <h4>{label}</h4>
                <p>
                  {items.length} group limit{items.length === 1 ? '' : 's'}
                  {meta
                    ? ` · ${customer?.name || '—'} · MG ${meta.managementGroupId} · ${meta.subscriptionIds.length} subscription(s)`
                    : ''}
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {QUOTA_GROUP_COLUMNS.map(([column, columnLabel]) => (
                      <th key={column}>{columnLabel}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const rowCustomer = customers.find((c) => c.id === row.customerId)
                    const pct = row.limit ? Math.round((row.allocated / row.limit) * 100) : 0
                    const tone = usageTone(row.allocated, Math.max(row.limit, 1))
                    return (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td>{rowCustomer?.name || '—'}</td>
                        <td>{row.managementGroupId}</td>
                        <td>{row.region}</td>
                        <td style={{ minWidth: 180 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>
                              {row.allocated}/{row.limit} {row.unit}
                            </span>
                            <span className="muted">{pct}%</span>
                          </div>
                          <div className={`progress ${tone}`} style={{ marginTop: '0.4rem' }}>
                            <span style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                        </td>
                        <td>
                          {row.availableLimit} {row.unit}
                        </td>
                        <td title={row.subscriptionIds.join(', ')}>
                          {formatSubscriptionSummary(row.subscriptionIds, subscriptions)}
                        </td>
                        <td>
                          <span className="pill pill-neutral">{row.source || 'Stored'}</span>
                        </td>
                        <td className="muted">
                          {row.collectedAt ? formatDate(row.collectedAt) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </div>
  )
}
