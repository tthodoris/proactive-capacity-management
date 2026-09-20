import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Search, Star } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CheckboxMultiSelect } from '../components/CheckboxMultiSelect'
import { useApp } from '../context/AppContext'
import {
  listStoredAzureCosts,
  queryAzureCosts,
  type CostQueryResponse,
  type StoredCostsResponse,
} from '../lib/azureApi'
import {
  COST_LEVEL_META,
  applyEmptyRetrievalMarkers,
  buildCostHierarchyFromActual,
  buildEmptyCostHierarchy,
  buildMonthColumns,
  flattenVisibleCostRows,
  formatCompactUsd,
  mergeCostHierarchyWithPlaceholders,
  type CostMonthColumn,
  type CostTreeNode,
} from '../lib/costHierarchy'
import { formatDate } from '../lib/format'

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
  const [loadingStored, setLoadingStored] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [costResult, setCostResult] = useState<CostQueryResponse | null>(null)
  const [stored, setStored] = useState<StoredCostsResponse | null>(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)

  const fallbackMonths = useMemo(() => buildMonthColumns(new Date(), 6), [])

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

  const monthColumns: CostMonthColumn[] = useMemo(() => {
    if (costResult?.monthColumns?.length) return costResult.monthColumns
    const fromStored = stored?.retrievals?.find((r) => r.monthColumns?.length)?.monthColumns
    if (fromStored?.length) return fromStored
    return fallbackMonths
  }, [costResult, stored, fallbackMonths])

  const loadStoredCosts = useCallback(async (azureIds: string[]) => {
    const ids = azureIds.map((id) => String(id || '').trim()).filter(Boolean)
    if (ids.length === 0) {
      setStored(null)
      return
    }
    setLoadingStored(true)
    try {
      const result = await listStoredAzureCosts(ids)
      setStored(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError((prev) => prev || message)
    } finally {
      setLoadingStored(false)
    }
  }, [])

  useEffect(() => {
    const azureIds = selectedSubscriptions.map((s) => s.subscriptionId)
    void loadStoredCosts(azureIds)
  }, [selectedSubscriptions, loadStoredCosts])

  const placeholders = useMemo(() => {
    if (selectedSubscriptions.length === 0) return []
    const customerById = new Map(visibleCustomers.map((c) => [c.id, c]))
    return buildEmptyCostHierarchy({
      subscriptions: selectedSubscriptions.map((s) => ({
        customerId: s.customerId,
        customerName: customerById.get(s.customerId)?.name || null,
        azureSubscriptionId: s.subscriptionId,
        subscriptionName: s.name,
      })),
      monthColumns,
    })
  }, [selectedSubscriptions, visibleCustomers, monthColumns])

  const costRows = useMemo(() => {
    const sourceRows = costResult?.rows?.length
      ? costResult.rows
      : stored?.rows?.length
        ? stored.rows
        : []
    if (!sourceRows.length) return []

    const skuBySubAndName = new Map<string, string>()
    for (const item of inventory) {
      const key = `${item.subscriptionId}|${String(item.name || '').toLowerCase()}`
      if (item.sku) skuBySubAndName.set(key, item.sku)
    }
    const azureToLocalSub = new Map(
      subscriptions.map((s) => [String(s.subscriptionId).toLowerCase(), s.id]),
    )
    return sourceRows.map((row) => {
      if (row.sku && row.sku !== 'Unspecified') return row
      const localSubId = azureToLocalSub.get(String(row.azureSubscriptionId).toLowerCase())
      if (!localSubId) return row
      const sku = skuBySubAndName.get(
        `${localSubId}|${String(row.resourceName || '').toLowerCase()}`,
      )
      return sku ? { ...row, sku } : row
    })
  }, [costResult, stored, inventory, subscriptions])

  const tree = useMemo(() => {
    if (selectedSubscriptions.length === 0) return []

    let retrievedTree = buildCostHierarchyFromActual({
      rows: costRows,
      monthColumns,
    })

    const retrievals =
      costResult?.rows != null && costResult.fetchedAt
        ? selectedSubscriptions
            .filter((s) =>
              !costResult.errors?.some(
                (e) =>
                  String(e.azureSubscriptionId || '').toLowerCase() ===
                  String(s.subscriptionId).toLowerCase(),
              ),
            )
            .map((s) => {
              const customer = visibleCustomers.find((c) => c.id === s.customerId)
              return {
                azureSubscriptionId: s.subscriptionId,
                customerId: s.customerId,
                customerName: customer?.name || null,
                subscriptionName: s.name,
                retrievedAt: costResult.fetchedAt,
              }
            })
        : stored?.retrievals || []

    retrievedTree = applyEmptyRetrievalMarkers({
      tree: retrievedTree,
      retrievals,
      monthColumns,
    })

    return mergeCostHierarchyWithPlaceholders({
      retrievedTree,
      placeholders,
    })
  }, [
    selectedSubscriptions,
    costRows,
    monthColumns,
    costResult,
    stored,
    placeholders,
    visibleCustomers,
  ])

  const canRetrieve =
    selectedCustomerIds.length > 0 &&
    selectedSubscriptionIds.length > 0 &&
    selectedSubscriptionIds.length <= MAX_COST_SUBSCRIPTIONS &&
    cooldownSeconds <= 0

  useEffect(() => {
    if (cooldownSeconds <= 0) return
    const timer = window.setInterval(() => {
      setCooldownSeconds((s) => Math.max(0, s - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [cooldownSeconds])

  const loadCosts = useCallback(async () => {
    if (cooldownSeconds > 0) {
      setError(
        `Azure Cost Management cooldown active — wait ${cooldownSeconds}s before retrieving again.`,
      )
      return
    }
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
        months: 6,
        subscriptions: selectedSubscriptions.map((s) => ({
          azureSubscriptionId: s.subscriptionId,
          customerId: s.customerId,
          customerName: customerById.get(s.customerId)?.name || null,
          subscriptionName: s.name,
        })),
      })
      setCostResult(result)
      setExpanded(new Set())
      await loadStoredCosts(selectedSubscriptions.map((s) => s.subscriptionId))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (/\b429\b|rate-limited|cooling down|cooldown/i.test(message)) {
        const match = message.match(/(\d+)\s*s(?:ec(?:ond)?s?)?\s+remaining/i)
        setCooldownSeconds(match ? Number(match[1]) : 180)
      }
    } finally {
      setLoading(false)
    }
  }, [
    cooldownSeconds,
    ensureAzureSession,
    selectedCustomerIds.length,
    selectedSubscriptions,
    visibleCustomers,
    loadStoredCosts,
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

  const hasAnyCostData = tree.some((n) => n.hasCostData)
  const portfolioTotal = filteredTree.reduce(
    (sum, n) => sum + (n.hasCostData ? Number(n.projected) || 0 : 0),
    0,
  )
  const retrievedCount = stored?.retrievalCount ?? 0

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Cost Management</h3>
          <p>
            Hierarchical Actual Cost from Azure Cost Management — Customer → Subscription →
            Resource group → Service type → SKU (meter) → Resource. Select customers and up to{' '}
            {MAX_COST_SUBSCRIPTIONS} subscriptions per retrieval. Costs are stored in PCM; never-
            retrieved subscriptions show empty values until you retrieve them.
          </p>
        </div>
        <div className="hero-actions">
          <span className={`pill ${hasAnyCostData ? 'pill-ok' : 'pill-neutral'}`}>
            {hasAnyCostData ? 'Stored ActualCost' : 'No costs retrieved'}
          </span>
          <span className="pill pill-neutral">
            {hasAnyCostData ? `${formatCompactUsd(portfolioTotal)} projected` : '— projected'}
          </span>
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
                  setCostResult(null)
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
                  setCostResult(null)
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
                cooldownSeconds > 0
                  ? `Cooldown ${cooldownSeconds}s after rate limit`
                  : !canRetrieve
                    ? `Select customers and 1–${MAX_COST_SUBSCRIPTIONS} subscriptions`
                    : undefined
              }
            >
              {loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
              {loading
                ? 'Loading costs…'
                : cooldownSeconds > 0
                  ? `Wait ${cooldownSeconds}s`
                  : 'Retrieve costs from Azure'}
            </button>
            <span className="muted" style={{ fontSize: '0.88rem' }}>
              {selectedSubscriptionIds.length}/{MAX_COST_SUBSCRIPTIONS} subscriptions selected · last
              6 months
              {loadingStored ? ' · loading stored…' : retrievedCount > 0 ? ` · ${retrievedCount} stored` : ''}
            </span>
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
            Management with your session. Previously stored costs still appear for selected
            subscriptions.
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

      {costResult ? (
        <div className="muted" style={{ fontSize: '0.88rem' }}>
          {costResult.message} · {formatDate(costResult.fetchedAt)} ·{' '}
          {selectedSubscriptions.length} subscription(s) queried
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Cost hierarchy</h4>
            <p>
              {rows.length} visible row{rows.length === 1 ? '' : 's'}
              {hasAnyCostData
                ? ` · ${costRows.length} cost lines`
                : selectedCustomerIds.length === 0
                  ? ' · select customers and subscriptions'
                  : ' · retrieve costs to populate values'}
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
                <th className="cost-col-retrieved">Retrieved</th>
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
                        {formatCompactUsd(
                          node.hasCostData ? node.months[month.key] ?? 0 : null,
                        )}
                      </td>
                    ))}
                    <td className="cost-col-projected">
                      {formatCompactUsd(node.hasCostData ? node.projected : null)}
                    </td>
                    <td className="cost-col-retrieved muted">
                      {node.retrievedAt ? formatDate(node.retrievedAt) : '—'}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={monthColumns.length + 3}>
                    <div className="empty">
                      {loading || loadingStored
                        ? 'Loading costs…'
                        : selectedCustomerIds.length === 0
                          ? 'Select customers and subscriptions, then retrieve costs from Azure.'
                          : selectedSubscriptions.length === 0
                            ? 'Select at least one subscription.'
                            : query.trim()
                              ? 'No hierarchy rows match the current filter.'
                              : 'No hierarchy rows for the selected scope.'}
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
