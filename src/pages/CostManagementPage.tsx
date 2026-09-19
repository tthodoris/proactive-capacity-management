import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Search, Star } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CheckboxMultiSelect } from '../components/CheckboxMultiSelect'
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

const MAX_COST_SUBSCRIPTIONS = 7

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
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([])
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<string[]>([])
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

  const customerOptions = useMemo(
    () =>
      visibleCustomers
        .map((c) => ({ value: c.id, label: c.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [visibleCustomers],
  )

  const customerSubs = useMemo(() => {
    if (selectedCustomerIds.length === 0) return []
    const selected = new Set(selectedCustomerIds)
    return subscriptions.filter(
      (s) => selected.has(s.customerId) && Boolean(String(s.subscriptionId || '').trim()),
    )
  }, [subscriptions, selectedCustomerIds])

  const subscriptionOptions = useMemo(() => {
    const customerName = new Map(visibleCustomers.map((c) => [c.id, c.name]))
    return customerSubs
      .map((s) => ({
        value: s.id,
        label: s.name,
        hint:
          selectedCustomerIds.length > 1
            ? customerName.get(s.customerId) || s.subscriptionId
            : s.subscriptionId,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [customerSubs, visibleCustomers, selectedCustomerIds.length])

  const selectedSubscriptions = useMemo(() => {
    const selected = new Set(selectedSubscriptionIds)
    return customerSubs.filter((s) => selected.has(s.id))
  }, [customerSubs, selectedSubscriptionIds])

  // Keep subscription picks valid when customers change.
  useEffect(() => {
    const allowed = new Set(customerSubs.map((s) => s.id))
    setSelectedSubscriptionIds((prev) => {
      const next = prev.filter((id) => allowed.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [customerSubs])

  const visibleInventory = useMemo(() => {
    const customerSet =
      selectedCustomerIds.length > 0
        ? new Set(selectedCustomerIds)
        : new Set(visibleCustomers.map((c) => c.id))
    const subSet =
      selectedSubscriptionIds.length > 0 ? new Set(selectedSubscriptionIds) : null
    return inventory.filter((item) => {
      if (!customerSet.has(item.customerId)) return false
      if (subSet && !subSet.has(item.subscriptionId)) return false
      return true
    })
  }, [
    inventory,
    selectedCustomerIds,
    selectedSubscriptionIds,
    visibleCustomers,
  ])

  const estimateTree = useMemo(
    () =>
      buildCostHierarchy({
        inventory: visibleInventory,
        customers: visibleCustomers.filter(
          (c) =>
            selectedCustomerIds.length === 0 || selectedCustomerIds.includes(c.id),
        ),
        subscriptions: selectedSubscriptions.length
          ? selectedSubscriptions
          : customerSubs,
        monthColumns: fallbackMonths,
      }),
    [
      visibleInventory,
      visibleCustomers,
      selectedCustomerIds,
      selectedSubscriptions,
      customerSubs,
      fallbackMonths,
    ],
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

  const canRetrieve =
    selectedCustomerIds.length > 0 &&
    selectedSubscriptionIds.length > 0 &&
    selectedSubscriptionIds.length <= MAX_COST_SUBSCRIPTIONS

  const loadCosts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const ready = await ensureAzureSession()
      if (!ready) {
        throw new Error(
          'No active Azure CLI session. Connect a tenant on Azure Connect, then retrieve costs.',
        )
      }
      if (selectedCustomerIds.length === 0) {
        throw new Error('Select at least one customer.')
      }
      if (selectedSubscriptions.length === 0) {
        throw new Error('Select at least one subscription.')
      }
      if (selectedSubscriptions.length > MAX_COST_SUBSCRIPTIONS) {
        throw new Error(
          `Select at most ${MAX_COST_SUBSCRIPTIONS} subscriptions per cost retrieval.`,
        )
      }
      const customerById = new Map(visibleCustomers.map((c) => [c.id, c]))
      const result = await queryAzureCosts({
        months: 12,
        subscriptions: selectedSubscriptions.map((s) => ({
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
  }, [
    ensureAzureSession,
    selectedCustomerIds.length,
    selectedSubscriptions,
    visibleCustomers,
  ])

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
            Resource group → Service type → SKU (meter) → Resource. Select customers and up to{' '}
            {MAX_COST_SUBSCRIPTIONS} subscriptions per retrieval.
          </p>
        </div>
        <div className="hero-actions">
          <span className={`pill ${usingLive ? 'pill-ok' : 'pill-neutral'}`}>
            {usingLive ? 'Azure ActualCost' : 'Inventory estimates'}
          </span>
          <span className="pill pill-neutral">{formatCompactUsd(portfolioTotal)} projected</span>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Cost scope</h4>
            <p>
              Choose customers and subscriptions, then retrieve costs. Maximum{' '}
              {MAX_COST_SUBSCRIPTIONS} subscriptions per operation.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="form-grid">
            <div className="field">
              <CheckboxMultiSelect
                id="cost-mgmt-customers"
                label="Customers"
                options={customerOptions}
                value={selectedCustomerIds}
                onChange={(next) => {
                  setSelectedCustomerIds(next)
                  setError(null)
                }}
                placeholder="Select customers"
                selectAllLabel="Select all customers"
                emptyLabel="No customers in portfolio"
              />
            </div>
            <div className="field">
              <CheckboxMultiSelect
                id="cost-mgmt-subscriptions"
                label="Subscriptions"
                options={subscriptionOptions}
                value={selectedSubscriptionIds}
                onChange={(next) => {
                  setSelectedSubscriptionIds(next)
                  setError(null)
                }}
                disabled={selectedCustomerIds.length === 0 || subscriptionOptions.length === 0}
                placeholder="Select subscriptions"
                selectAllLabel="Select subscriptions"
                emptyLabel={
                  selectedCustomerIds.length === 0
                    ? 'Select a customer first'
                    : 'No subscriptions for the selected customers'
                }
                maxSelections={MAX_COST_SUBSCRIPTIONS}
              />
            </div>
          </div>
          <div className="filters" style={{ alignItems: 'center', marginTop: '0.85rem' }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void loadCosts()}
              disabled={loading || !canRetrieve}
              aria-busy={loading}
              title={
                !canRetrieve
                  ? `Select customers and 1–${MAX_COST_SUBSCRIPTIONS} subscriptions`
                  : undefined
              }
            >
              {loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
              {loading ? 'Loading costs…' : 'Retrieve costs from Azure'}
            </button>
            <span className="muted" style={{ fontSize: '0.88rem' }}>
              {selectedSubscriptionIds.length}/{MAX_COST_SUBSCRIPTIONS} subscriptions selected
            </span>
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
          </div>
        </div>
      </section>

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter hierarchy by name"
          />
        </div>
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
            Management with your session. Until then, inventory-based estimates are shown for the
            selected scope.
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
          {selectedSubscriptions.length} subscription(s) queried
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
                : selectedCustomerIds.length === 0
                  ? ' · select customers to scope estimates'
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
                          : selectedCustomerIds.length === 0
                            ? 'Select customers and subscriptions, then retrieve costs from Azure.'
                            : visibleInventory.length === 0
                              ? 'No inventory in the selected scope. Retrieve costs from Azure or collect inventory.'
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
