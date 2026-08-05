import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search, X } from 'lucide-react'
import { SeverityBadge, StatusBadge } from '../components/Badges'
import { useApp } from '../context/AppContext'
import { formatRelative } from '../lib/format'
import { filterActiveImpacts } from '../lib/constraints'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'

type ConstraintSortKey =
  | 'sku'
  | 'regions'
  | 'scope'
  | 'severity'
  | 'status'
  | 'source'
  | 'affected'
  | 'updated'

export function ConstraintsPage() {
  const { constraints, impactResults, portfolioCustomerIds, canSeeAllPortfolios, user } = useApp()
  const [query, setQuery] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const navigate = useNavigate()
  const { sortKey, sortDir, toggleSort } = useSortState<ConstraintSortKey>('updated', 'desc')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<ConstraintSortKey>()

  const activeImpacts = useMemo(
    () => filterActiveImpacts(impactResults, constraints),
    [impactResults, constraints],
  )

  const getValue = useCallback(
    (c: (typeof constraints)[number], key: string) => {
      switch (key) {
        case 'regions':
          return c.regions.join(', ')
        case 'affected': {
          const count = new Set(
            activeImpacts.filter((i) => i.constraintId === c.id).map((i) => i.customerId),
          ).size
          return `${count} customers`
        }
        case 'updated':
          return formatRelative(c.updatedAt)
        case 'sku':
          return c.sku
        default:
          return c[key as keyof typeof c]
      }
    },
    [activeImpacts],
  )

  const getSortValue = useCallback(
    (c: (typeof constraints)[number], key: string) => {
      if (key === 'updated') return c.updatedAt
      if (key === 'affected') {
        return new Set(
          activeImpacts.filter((i) => i.constraintId === c.id).map((i) => i.customerId),
        ).size
      }
      return getValue(c, key)
    },
    [getValue, activeImpacts],
  )

  const baseRows = useMemo(() => {
    return constraints.filter((c) => {
      if (!showResolved && c.status === 'Resolved') return false
      const matchesQuery =
        !query ||
        c.sku.toLowerCase().includes(query.toLowerCase()) ||
        c.regions.join(' ').toLowerCase().includes(query.toLowerCase()) ||
        c.source.toLowerCase().includes(query.toLowerCase()) ||
        c.resourceType.toLowerCase().includes(query.toLowerCase())
      if (!matchesQuery) return false
      if (!canSeeAllPortfolios) {
        const touchesPortfolio = activeImpacts.some(
          (i) => i.constraintId === c.id && portfolioCustomerIds.includes(i.customerId),
        )
        if (!touchesPortfolio && c.createdBy !== user.id) return false
      }
      return true
    })
  }, [
    constraints,
    activeImpacts,
    portfolioCustomerIds,
    canSeeAllPortfolios,
    query,
    user.id,
    showResolved,
  ])

  const filtered = useMemo(() => {
    return baseRows.filter((c) =>
      matchesColumnFilters((column) => String(getValue(c, column) ?? '')),
    )
  }, [baseRows, matchesColumnFilters, getValue])

  const displayRows = useSortedRows(filtered, sortKey, sortDir, getSortValue)

  const columnKeys: ConstraintSortKey[] = [
    'sku',
    'regions',
    'scope',
    'severity',
    'status',
    'source',
    'affected',
    'updated',
  ]

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
          <h3>Capacity-constraint records</h3>
          <p>
            Track constrained SKUs by region, severity, source, and investigation status. Click a
            column name to filter values.
          </p>
        </div>
        <Link className="btn btn-primary" to="/constraints/new">
          <Plus size={16} /> New constraint
        </Link>
      </div>

      <div className="filters">
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search SKU, region, or source"
          />
        </div>
        {activeFilterCount > 0 ? (
          <button className="btn btn-ghost" type="button" onClick={clearAllFilters}>
            <X size={16} /> Clear column filters ({activeFilterCount})
          </button>
        ) : null}
        <label className="switch-field" title="Include constraints marked as Resolved">
          <span className="switch">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />
            <span className="switch-track" aria-hidden />
          </span>
          <span className="switch-label">Show resolved constraints</span>
        </label>
      </div>

      <section className="panel">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {(
                  [
                    ['sku', 'SKU / type'],
                    ['regions', 'Regions'],
                    ['scope', 'Scope'],
                    ['severity', 'Severity'],
                    ['status', 'Status'],
                    ['source', 'Source'],
                    ['affected', 'Affected'],
                    ['updated', 'Updated'],
                  ] as Array<[ConstraintSortKey, string]>
                ).map(([column, label]) => (
                  <FilterableTh
                    key={column}
                    label={label}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={(c) => toggleSort(c as ConstraintSortKey)}
                    options={columnOptions[column]}
                    selected={filters[column]}
                    onFilterChange={(values) => setColumnFilter(column, values)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((c) => {
                const affected = new Set(
                  activeImpacts.filter((i) => i.constraintId === c.id).map((i) => i.customerId),
                ).size
                return (
                  <tr
                    key={c.id}
                    className="clickable"
                    onClick={() => navigate(`/constraints/${c.id}`)}
                  >
                    <td>
                      <strong>{c.sku}</strong>
                      <div className="muted">{c.resourceType}</div>
                    </td>
                    <td>{c.regions.join(', ')}</td>
                    <td>
                      <span className="pill pill-neutral">{c.scope}</span>
                    </td>
                    <td>
                      <SeverityBadge severity={c.severity} />
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="muted">{c.source}</td>
                    <td>
                      <strong>{affected}</strong> customers
                    </td>
                    <td className="muted">{formatRelative(c.updatedAt)}</td>
                  </tr>
                )
              })}
              {displayRows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">No constraints match the current filters.</div>
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
