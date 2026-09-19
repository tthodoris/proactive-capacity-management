import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Search, Star } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { queryAzureCosts, type CostQueryResponse } from '../lib/azureApi'
import {
  COST_LEVEL_META,
  buildCostHierarchy,
  buildCostHierarchyFromActual,
  buildMonthColumns,
  flattenVisibleCostRows,
  formatCompactUsd,
  type CostMonthColumn,
  type CostTreeNode,
} from '../lib/costHierarchy'

export function CostManagementPage() {
  const {
    inventory,
    customers,
    subscriptions,
    portfolioCustomerIds,
    canSeeAllPortfolios,
    azureSessionReady,
    ensureAzureSession,
  } = useApp()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [costResult, setCostResult] = useState<CostQueryResponse | null>(null)
  const [useEstimates, setUseEstimates] = useState(false)

  const fallbackMonths = useMemo(() => buildMonthColumns(new Date(), 12), [])

  const visibleCustomers = useMemo(() => {
    return customers.filter((c) => canSeeAllPortfolios || portfolioCustomerIds.includes(c.id))
  }, [customers, canSeeAllPortfolios, portfolioCustomerIds])

  const visibleInventory = useMemo(() => {
    return inventory.filter((item) => {
      if (!canSeeAllPortfolios && !portfolioCustomerIds.includes(item.customerId)) return false
      return true
    })
  }, [inventory, canSeeAllPortfolios, portfolioCustomerIds])

  const scopedSubscriptions = useMemo(() => {
    const customerIds = new Set(visibleCustomers.map((c) => c.id))
    return subscriptions.filter((s) => customerIds.has(s.customerId) && s.subscriptionId)
  }, [subscriptions, visibleCustomers])

  const estimateTree = useMemo(
    () =>
      buildCostHierarchy({
        inventory: visibleInventory,
        customers: visibleCustomers,
        subscriptions,
        monthColumns: fallbackMonths,
      }),
    [visibleInventory, visibleCustomers, subscriptions, fallbackMonths],
  )

  const actualTree = useMemo(() => {
    if (!costResult?.rows?.length) return []
    return buildCostHierarchyFromActual({
      rows: costResult.rows,
      monthColumns: costResult.monthColumns,
    })
  }, [costResult])

  const usingLive = Boolean(costResult) && !useEstimates
  const tree = usingLive ? actualTree : estimateTree
  const monthColumns: CostMonthColumn[] =
    usingLive && costResult?.monthColumns?.length ? costResult.monthColumns : fallbackMonths

  const loadCosts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const ready = await ensureAzureSession()
      if (!ready) {
        throw new Error(
          'No active Azure CLI session. Connect a tenant on Azure Connect, then refresh costs.',
        )
      }
      if (scopedSubscriptions.length === 0) {
        throw new Error(
          'No subscriptions in scope. Add customers/subscriptions (or collect inventory) first.',
        )
      }
      const customerById = new Map(visibleCustomers.map((c) => [c.id, c]))
      const result = await queryAzureCosts({
        months: 12,
        subscriptions: scopedSubscriptions.map((s) => ({
          azureSubscriptionId: s.subscriptionId,
          customerId: s.customerId,
          customerName: customerById.get(s.customerId)?.name || null,
          subscriptionName: s.name,
        })),
      })
      setCostResult(result)
      setUseEstimates(false)
      setExpanded(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [ensureAzureSession, scopedSubscriptions, visibleCustomers])

  useEffect(() => {
    if (!azureSessionReady || scopedSubscriptions.length === 0) return
    if (costResult || loading) return
    void loadCosts()
    // Auto-load once when session + subscriptions are ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [azureSessionReady, scopedSubscriptions.length])

  useEffect(() => {
    if (tree.length === 0) return
    setExpanded((prev) => {
      if (prev.size > 0) return prev
      return new Set(tree.map((n) => n.id))
    })
  }, [tree])

  const filteredTree = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tree

    const filterNode = (node: CostTreeNode): CostTreeNode | null => {
      const selfMatch = node.label.toLowerCase().includes(q)
      const children = node.children
        .map(filterNode)
        .filter((child): child is CostTreeNode => Boolean(child))
      if (selfMatch || children.length > 0) {
        return { ...node, children: selfMatch ? node.children : children }
      }
      return null
    }

    return tree.map(filterNode).filter((n): n is CostTreeNode => Boolean(n))
  }, [tree, query])

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const ids = new Set<string>()
    const walk = (nodes: CostTreeNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) {
          ids.add(node.id)
          walk(node.children)
        }
      }
    }
    walk(filteredTree)
    setExpanded(ids)
  }, [query, filteredTree])

  const rows = useMemo(
    () => flattenVisibleCostRows(filteredTree, expanded),
    [filteredTree, expanded],
  )

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function expandAll() {
    const ids = new Set<string>()
    const walk = (nodes: CostTreeNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) {
          ids.add(node.id)
          walk(node.children)
        }
      }
    }
    walk(filteredTree)
    setExpanded(ids)
  }

  function collapseAll() {
    setExpanded(new Set())
  }

  const portfolioTotal = filteredTree.reduce((sum, n) => sum + n.projected, 0)

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Cost Management</h3>
          <p>
            Hierarchical Actual Cost from Azure Cost Management — Customer → Subscription →
            Resource group → Service type → SKU (meter) → Resource.
          </p>
        </div>
        <div className="hero-actions">
          <span className={`pill ${usingLive ? 'pill-ok' : 'pill-neutral'}`}>
            {usingLive ? 'Azure ActualCost' : 'Inventory estimates'}
          </span>
          <span className="pill pill-neutral">{formatCompactUsd(portfolioTotal)} projected</span>
        </div>
      </div>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter hierarchy by name"
          />
        </div>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => void loadCosts()}
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
          {loading ? 'Loading costs…' : 'Refresh from Azure'}
        </button>
        {costResult ? (
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              setUseEstimates((v) => !v)
              setExpanded(new Set())
            }}
          >
            {useEstimates ? 'Show Azure costs' : 'Show estimates'}
          </button>
        ) : null}
        <button className="btn btn-secondary" type="button" onClick={expandAll}>
          Expand all
        </button>
        <button className="btn btn-ghost" type="button" onClick={collapseAll}>
          Collapse all
        </button>
      </div>

      {!azureSessionReady ? (
        <div className="panel soft-panel">
          <p className="muted" style={{ margin: 0 }}>
            Connect an Azure tenant on <Link to="/connect">Azure Connect</Link> so PCM can call Cost
            Management with your session. Until then, inventory-based estimates are shown.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="panel soft-panel">
          <p style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>
        </div>
      ) : null}

      {costResult?.errors?.length ? (
        <div className="panel soft-panel">
          <strong>Some subscriptions failed</strong>
          <ul className="muted" style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
            {costResult.errors.slice(0, 8).map((e) => (
              <li key={`${e.azureSubscriptionId}-${e.error}`}>
                {e.subscriptionName || e.azureSubscriptionId}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {costResult && usingLive ? (
        <div className="muted" style={{ fontSize: '0.88rem' }}>
          {costResult.message} · {new Date(costResult.fetchedAt).toLocaleString()} ·{' '}
          {scopedSubscriptions.length} subscription(s) queried
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>{usingLive ? 'Actual cost hierarchy' : 'Estimated cost hierarchy'}</h4>
            <p>
              {rows.length} visible row{rows.length === 1 ? '' : 's'}
              {usingLive
                ? ` · ${costResult?.rowCount ?? 0} cost lines`
                : ` · ${visibleInventory.length} inventory resources`}
            </p>
          </div>
        </div>
        <div className="table-wrap cost-hierarchy-wrap">
          <table className="data cost-hierarchy-table">
            <thead>
              <tr>
                <th className="cost-service-col">Service</th>
                {monthColumns.map((month) => (
                  <th
                    key={month.key}
                    className={month.isCurrent ? 'cost-col-current' : undefined}
                  >
                    <span className="cost-month-label">
                      {month.label}
                      {month.isCurrent ? <Star size={12} aria-label="Current month" /> : null}
                    </span>
                  </th>
                ))}
                <th className="cost-col-projected">Projected</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((node) => {
                const meta = COST_LEVEL_META[node.level]
                const hasChildren = node.children.length > 0
                const isOpen = expanded.has(node.id)
                return (
                  <tr key={node.id} className={`cost-row level-${node.level}`}>
                    <td>
                      <div
                        className="cost-service-cell"
                        style={{ paddingLeft: `${(node.level - 1) * 1.1}rem` }}
                      >
                        {hasChildren ? (
                          <button
                            type="button"
                            className="cost-expand-btn"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? 'Collapse' : 'Expand'}
                            onClick={() => toggle(node.id)}
                          >
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        ) : (
                          <span className="cost-expand-spacer" />
                        )}
                        <span className={`cost-level-badge level-${node.level}`}>{meta.badge}</span>
                        <span className="cost-service-name" title={node.label}>
                          {node.label}
                        </span>
                      </div>
                    </td>
                    {monthColumns.map((month) => (
                      <td
                        key={month.key}
                        className={month.isCurrent ? 'cost-col-current' : undefined}
                      >
                        {formatCompactUsd(node.months[month.key] || 0)}
                      </td>
                    ))}
                    <td className="cost-col-projected">{formatCompactUsd(node.projected)}</td>
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={monthColumns.length + 2}>
                    <div className="empty">
                      {loading
                        ? 'Loading Azure Cost Management…'
                        : usingLive
                          ? 'No cost rows returned for the selected subscriptions in this period.'
                          : visibleInventory.length === 0
                            ? 'No inventory in scope. Collect inventory or refresh costs from Azure.'
                            : 'No hierarchy rows match the current filter.'}
                    </div>
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
