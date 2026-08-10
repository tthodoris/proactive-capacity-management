import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Download, Search, ShieldAlert, X } from 'lucide-react'
import { useApp } from '../context/AppContext'
import {
  computePortfolioCapacityRisks,
  riskLevelPillClass,
  sortRisksForTriage,
  type CapacityRiskLevel,
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

type RiskSortKey = 'name' | 'owner' | 'level' | 'score' | 'why' | 'callFirst'

const LEVEL_ORDER: Record<CapacityRiskLevel, number> = { Red: 0, Amber: 1, Green: 2 }

export function CustomerRiskPage() {
  const {
    customers,
    users,
    inventory,
    quotas,
    impactResults,
    constraints,
    portfolioCustomerIds,
    canSeeAllPortfolios,
  } = useApp()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
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
    })
    return new Map(list.map((r) => [r.customerId, r]))
  }, [portfolioCustomers, inventory, quotas, impactResults, constraints])

  const triageOrder = useMemo(() => {
    const risks = sortRisksForTriage([...riskByCustomer.values()])
    const order = new Map<string, number>()
    risks.forEach((r, index) => order.set(r.customerId, index + 1))
    return order
  }, [riskByCustomer])

  const baseRows = useMemo(() => {
    return portfolioCustomers.filter((c) => {
      if (!query) return true
      const q = query.toLowerCase()
      const owner = users.find((u) => u.id === c.csaOwnerId)
      const risk = riskByCustomer.get(c.id)
      return (
        c.name.toLowerCase().includes(q) ||
        c.segment.toLowerCase().includes(q) ||
        (owner?.name || '').toLowerCase().includes(q) ||
        (risk?.level || '').toLowerCase().includes(q) ||
        (risk?.summary || '').toLowerCase().includes(q)
      )
    })
  }, [portfolioCustomers, query, users, riskByCustomer])

  const getValue = useCallback(
    (c: (typeof baseRows)[number], key: string) => {
      const risk = riskByCustomer.get(c.id)
      const owner = users.find((u) => u.id === c.csaOwnerId)
      switch (key) {
        case 'owner':
          return owner?.name || ''
        case 'level':
          return risk?.level || 'Green'
        case 'score':
          return risk?.score ?? 0
        case 'why':
          return risk?.summary || ''
        case 'callFirst':
          return triageOrder.get(c.id) ?? 9999
        case 'name':
          return c.name
        default:
          return ''
      }
    },
    [riskByCustomer, users, triageOrder],
  )

  const filtered = useMemo(() => {
    return baseRows.filter((c) =>
      matchesColumnFilters((column) => String(getValue(c, column) ?? '')),
    )
  }, [baseRows, matchesColumnFilters, getValue])

  const rows = useSortedRows(filtered, sortKey, sortDir, (row, key) => {
    if (key === 'level') {
      const level = (riskByCustomer.get(row.id)?.level || 'Green') as CapacityRiskLevel
      return LEVEL_ORDER[level]
    }
    return getValue(row, key)
  })

  const columnKeys: RiskSortKey[] = ['name', 'owner', 'level', 'score', 'why', 'callFirst']
  const columnOptions = useMemo(
    () => collectCascadingOptions(baseRows, columnKeys, filters, getValue),
    [baseRows, filters, getValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(columnOptions)
  }, [columnOptions, pruneFiltersToOptions])

  const counts = useMemo(() => {
    const all = [...riskByCustomer.values()]
    return {
      red: all.filter((r) => r.level === 'Red').length,
      amber: all.filter((r) => r.level === 'Amber').length,
      green: all.filter((r) => r.level === 'Green').length,
    }
  }, [riskByCustomer])

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Customer capacity risk</h3>
          <p>
            Red / Amber / Green posture from open constraints, quota headroom, SKU concentration,
            and region concentration — sorted for who to call first.
          </p>
        </div>
      </div>

      <div className="metric-grid">
        <div className="metric-card">
          <div className="label">Red</div>
          <div className="value">{counts.red}</div>
          <div className="hint">Call first</div>
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
            placeholder="Search customer, owner, level, or why"
          />
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
              { key: 'name', label: 'Customer' },
              { key: 'owner', label: 'CSA owner' },
              { key: 'level', label: 'Risk' },
              { key: 'score', label: 'Score' },
              { key: 'why', label: 'Why' },
              { key: 'factors', label: 'Factor details' },
            ]
            exportToExcel(
              'customer-capacity-risk',
              'Capacity risk',
              columns,
              rows.map((c) => {
                const risk = riskByCustomer.get(c.id)
                return {
                  callFirst: triageOrder.get(c.id) ?? '',
                  name: c.name,
                  owner: users.find((u) => u.id === c.csaOwnerId)?.name || '',
                  level: risk?.level || 'Green',
                  score: risk?.score ?? 0,
                  why: risk?.summary || '',
                  factors: (risk?.factors || []).map((f) => f.detail).join(' | '),
                }
              }),
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
              {rows.map((c) => {
                const risk = riskByCustomer.get(c.id) as CustomerCapacityRisk | undefined
                const owner = users.find((u) => u.id === c.csaOwnerId)
                const level = risk?.level || 'Green'
                return (
                  <tr
                    key={c.id}
                    className="clickable"
                    onClick={() => navigate(`/customers/${c.id}`)}
                  >
                    <td>
                      <strong>#{triageOrder.get(c.id)}</strong>
                    </td>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted">{c.segment}</div>
                    </td>
                    <td>{owner?.name}</td>
                    <td>
                      <span className={riskLevelPillClass(level)}>{level}</span>
                    </td>
                    <td>{risk?.score ?? 0}</td>
                    <td>{risk?.summary || '—'}</td>
                    <td>
                      <div className="risk-factor-list">
                        {(risk?.factors || []).length === 0 ? (
                          <span className="muted">No elevated factors</span>
                        ) : (
                          risk!.factors.map((f) => (
                            <div key={f.id} className="risk-factor-item">
                              <ShieldAlert size={14} />
                              <div>
                                <strong>{f.label}</strong>
                                <div className="muted">{f.detail}</div>
                              </div>
                              <span className="muted">+{f.points}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">No customers match the current filters.</div>
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
