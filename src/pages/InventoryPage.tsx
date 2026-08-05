import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Search, X } from 'lucide-react'
import { exportToExcel } from '../lib/exportExcel'
import { useApp } from '../context/AppContext'
import { formatDate } from '../lib/format'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'

type InventorySortKey =
  | 'name'
  | 'customer'
  | 'subscription'
  | 'type'
  | 'sku'
  | 'region'
  | 'source'
  | 'retrieved'

const INVENTORY_COLUMNS: Array<[InventorySortKey, string]> = [
  ['name', 'Resource'],
  ['customer', 'Customer'],
  ['subscription', 'Subscription'],
  ['type', 'Type'],
  ['sku', 'SKU'],
  ['region', 'Region'],
  ['source', 'Source'],
  ['retrieved', 'Retrieved'],
]

export function InventoryPage() {
  const { inventory, customers, subscriptions, portfolioCustomerIds, canSeeAllPortfolios } = useApp()
  const [query, setQuery] = useState('')
  const { sortKey, sortDir, toggleSort } = useSortState<InventorySortKey>('name')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<InventorySortKey>()

  const visibleInventory = useMemo(() => {
    return inventory.filter((item) => {
      if (!canSeeAllPortfolios && !portfolioCustomerIds.includes(item.customerId)) return false
      return true
    })
  }, [inventory, canSeeAllPortfolios, portfolioCustomerIds])

  const getValue = useCallback(
    (item: (typeof visibleInventory)[number], key: string) => {
      const customer = customers.find((c) => c.id === item.customerId)
      const sub = subscriptions.find((s) => s.id === item.subscriptionId)
      switch (key) {
        case 'customer':
          return customer?.name || ''
        case 'subscription':
          return sub?.name || ''
        case 'type':
          return item.resourceType
        case 'retrieved':
          return item.collectedAt ? formatDate(item.collectedAt) : '—'
        default:
          return item[key as keyof typeof item]
      }
    },
    [customers, subscriptions],
  )

  const getSortValue = useCallback(
    (item: (typeof visibleInventory)[number], key: string) => {
      if (key === 'retrieved') return item.collectedAt || ''
      return getValue(item, key)
    },
    [getValue],
  )

  const searched = useMemo(() => {
    return visibleInventory.filter((item) => {
      const customer = customers.find((c) => c.id === item.customerId)
      const sub = subscriptions.find((s) => s.id === item.subscriptionId)
      const retrieved = item.collectedAt ? formatDate(item.collectedAt) : ''
      const hay =
        `${item.name} ${item.sku} ${item.region} ${item.resourceGroup} ${customer?.name ?? ''} ${sub?.name ?? ''} ${retrieved}`.toLowerCase()
      return !query || hay.includes(query.toLowerCase())
    })
  }, [visibleInventory, query, customers, subscriptions])

  const filtered = useMemo(() => {
    return searched.filter((item) =>
      matchesColumnFilters((column) => String(getValue(item, column) ?? '')),
    )
  }, [searched, matchesColumnFilters, getValue])

  const rows = useSortedRows(filtered, sortKey, sortDir, getSortValue)

  const columnKeys = INVENTORY_COLUMNS.map(([key]) => key)

  const columnOptions = useMemo(
    () => collectCascadingOptions(searched, columnKeys, filters, getValue),
    [searched, filters, getValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(columnOptions)
  }, [columnOptions, pruneFiltersToOptions])

  const hasFilters = Boolean(query) || activeFilterCount > 0

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Resource inventory</h3>
          <p>
            Consent-based tenant collection reconciled with internal inventory — SKU, region,
            subscription, and resource group. Click a column name to filter values.
          </p>
        </div>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search resource, SKU, customer, region, or RG"
          />
        </div>
        {hasFilters ? (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setQuery('')
              clearAllFilters()
            }}
          >
            <X size={16} /> Clear filters
          </button>
        ) : null}
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() =>
            exportToExcel('inventory', 'Inventory', INVENTORY_COLUMNS.map(([key, label]) => ({ key, label })), rows.map((item) => {
              const obj: Record<string, unknown> = {}
              for (const [key] of INVENTORY_COLUMNS) obj[key] = getValue(item, key)
              return obj
            }))
          }
        >
          <Download size={16} /> Export to Excel
        </button>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Inventory</h4>
            <p>
              {rows.length} of {visibleInventory.length} resources
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {INVENTORY_COLUMNS.map(([column, label]) => (
                  <FilterableTh
                    key={column}
                    label={label}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={(c) => toggleSort(c as InventorySortKey)}
                    options={columnOptions[column]}
                    selected={filters[column]}
                    onFilterChange={(values) => setColumnFilter(column, values)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const customer = customers.find((c) => c.id === item.customerId)
                const sub = subscriptions.find((s) => s.id === item.subscriptionId)
                return (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                      <div className="muted">{item.resourceGroup}</div>
                    </td>
                    <td>{customer?.name}</td>
                    <td>{sub?.name}</td>
                    <td>{item.resourceType}</td>
                    <td>{item.sku}</td>
                    <td>{item.region}</td>
                    <td>
                      <span className="pill pill-neutral">{item.source}</span>
                    </td>
                    <td className="muted">
                      {item.collectedAt ? formatDate(item.collectedAt) : '—'}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={INVENTORY_COLUMNS.length}>
                    <div className="empty">No inventory matches the current filters.</div>
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
