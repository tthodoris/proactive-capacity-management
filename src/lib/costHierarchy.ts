export type CostLevel = 1 | 2 | 3 | 4 | 5 | 6

export type CostLevelKey =
  | 'customer'
  | 'subscription'
  | 'resourceGroup'
  | 'serviceType'
  | 'sku'
  | 'resource'

export const COST_LEVEL_META: Record<
  CostLevel,
  { key: CostLevelKey; badge: string; label: string }
> = {
  1: { key: 'customer', badge: 'L1', label: 'Customer' },
  2: { key: 'subscription', badge: 'L2', label: 'Subscription' },
  3: { key: 'resourceGroup', badge: 'L3', label: 'Resource group' },
  4: { key: 'serviceType', badge: 'L4', label: 'Service type' },
  5: { key: 'sku', badge: 'L5', label: 'SKU' },
  6: { key: 'resource', badge: 'L6', label: 'Resource' },
}

export interface CostMonthColumn {
  key: string
  label: string
  /** True for the column representing the current calendar month. */
  isCurrent: boolean
}

export interface CostTreeNode {
  id: string
  level: CostLevel
  label: string
  /** Monthly costs aligned with `months` keys (USD). Null when never retrieved. */
  months: Record<string, number | null>
  projected: number | null
  children: CostTreeNode[]
  resourceCount: number
  /** ISO timestamp of latest cost retrieval under this node; null if never retrieved. */
  retrievedAt: string | null
  /** False when this node (or branch) has no persisted Azure cost data. */
  hasCostData: boolean
}

export function buildMonthColumns(now = new Date(), count = 12): CostMonthColumn[] {
  const months: CostMonthColumn[] = []
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const label = d
      .toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
      .toUpperCase()
    months.push({
      key,
      label,
      isCurrent: i === 0,
    })
  }
  return months
}

export function formatCompactUsd(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

export interface CostActualLeaf {
  customerId?: string | null
  customerName?: string | null
  azureSubscriptionId: string
  subscriptionName: string
  resourceGroup: string
  serviceType: string
  sku: string
  resourceName: string
  resourceId?: string | null
  months: Record<string, number>
  projected: number
  currency?: string
  retrievedAt?: string | null
}

export function buildEmptyCostHierarchy(input: {
  subscriptions: Array<{
    customerId?: string | null
    customerName?: string | null
    azureSubscriptionId: string
    subscriptionName: string
  }>
  monthColumns: CostMonthColumn[]
}): CostTreeNode[] {
  const monthKeys = input.monthColumns.map((m) => m.key)
  const emptyMonths = () =>
    Object.fromEntries(monthKeys.map((k) => [k, null])) as Record<string, number | null>
  const byCustomer = new Map<string, CostTreeNode>()

  for (const sub of input.subscriptions) {
    const customerKey = sub.customerId || sub.customerName || 'unknown-customer'
    const customerLabel = sub.customerName || sub.customerId || 'Unknown customer'
    let cust = byCustomer.get(customerKey)
    if (!cust) {
      cust = {
        id: `cust:${customerKey}`,
        level: 1,
        label: customerLabel,
        months: emptyMonths(),
        projected: null,
        children: [],
        resourceCount: 0,
        retrievedAt: null,
        hasCostData: false,
      }
      byCustomer.set(customerKey, cust)
    }
    cust.children.push({
      id: `sub:${customerKey}:${sub.azureSubscriptionId}`,
      level: 2,
      label: sub.subscriptionName || sub.azureSubscriptionId,
      months: emptyMonths(),
      projected: null,
      children: [],
      resourceCount: 0,
      retrievedAt: null,
      hasCostData: false,
    })
  }

  return [...byCustomer.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function buildCostHierarchyFromActual(input: {
  rows: CostActualLeaf[]
  monthColumns: CostMonthColumn[]
}): CostTreeNode[] {
  const monthKeys = input.monthColumns.map((m) => m.key)
  const currentKey =
    input.monthColumns.find((m) => m.isCurrent)?.key || monthKeys[monthKeys.length - 1]

  const emptyMonths = () => Object.fromEntries(monthKeys.map((k) => [k, 0])) as Record<string, number>

  type Acc = {
    id: string
    level: CostLevel
    label: string
    months: Record<string, number>
    projected: number
    resourceCount: number
    retrievedAt: string | null
    hasCostData: boolean
    children: Map<string, Acc>
  }

  const roots = new Map<string, Acc>()

  const ensureChild = (
    parent: Map<string, Acc>,
    id: string,
    level: CostLevel,
    label: string,
  ): Acc => {
    let node = parent.get(id)
    if (!node) {
      node = {
        id,
        level,
        label,
        months: emptyMonths(),
        projected: 0,
        resourceCount: 0,
        retrievedAt: null,
        hasCostData: true,
        children: new Map(),
      }
      parent.set(id, node)
    }
    return node
  }

  const bumpRetrieved = (node: Acc, iso: string | null | undefined) => {
    if (!iso) return
    if (!node.retrievedAt || iso > node.retrievedAt) node.retrievedAt = iso
  }

  for (const row of input.rows) {
    const customerKey = row.customerId || row.customerName || 'unknown-customer'
    const customerLabel = row.customerName || row.customerId || 'Unknown customer'
    const cust = ensureChild(roots, `cust:${customerKey}`, 1, customerLabel)

    const sub = ensureChild(
      cust.children,
      `sub:${customerKey}:${row.azureSubscriptionId}`,
      2,
      row.subscriptionName || row.azureSubscriptionId,
    )
    const rg = ensureChild(
      sub.children,
      `rg:${customerKey}:${row.azureSubscriptionId}:${row.resourceGroup}`,
      3,
      row.resourceGroup || '(unassigned)',
    )
    const svc = ensureChild(
      rg.children,
      `type:${customerKey}:${row.azureSubscriptionId}:${row.resourceGroup}:${row.serviceType}`,
      4,
      row.serviceType || 'Other',
    )
    const sku = ensureChild(
      svc.children,
      `sku:${customerKey}:${row.azureSubscriptionId}:${row.resourceGroup}:${row.serviceType}:${row.sku}`,
      5,
      row.sku || 'Unspecified',
    )
    const resId =
      row.resourceId ||
      `${row.resourceGroup}/${row.resourceName}/${row.sku}`
    const res = ensureChild(
      sku.children,
      `res:${customerKey}:${row.azureSubscriptionId}:${resId}`,
      6,
      row.resourceName || '(unassigned)',
    )

    for (const key of monthKeys) {
      const amount = Number(row.months?.[key] || 0)
      res.months[key] += amount
      sku.months[key] += amount
      svc.months[key] += amount
      rg.months[key] += amount
      sub.months[key] += amount
      cust.months[key] += amount
    }
    const projected =
      row.projected != null
        ? Number(row.projected) || 0
        : Number(row.months?.[currentKey] || 0)
    res.projected += projected
    sku.projected += projected
    svc.projected += projected
    rg.projected += projected
    sub.projected += projected
    cust.projected += projected
    res.resourceCount += 1
    sku.resourceCount += 1
    svc.resourceCount += 1
    rg.resourceCount += 1
    sub.resourceCount += 1
    cust.resourceCount += 1
    bumpRetrieved(res, row.retrievedAt)
    bumpRetrieved(sku, row.retrievedAt)
    bumpRetrieved(svc, row.retrievedAt)
    bumpRetrieved(rg, row.retrievedAt)
    bumpRetrieved(sub, row.retrievedAt)
    bumpRetrieved(cust, row.retrievedAt)
  }

  const toNode = (acc: Acc): CostTreeNode => {
    const children = [...acc.children.values()]
      .map(toNode)
      .sort((a, b) => (b.projected || 0) - (a.projected || 0))
    return {
      id: acc.id,
      level: acc.level,
      label: acc.label,
      months: acc.months,
      projected: acc.projected,
      children,
      resourceCount: acc.resourceCount,
      retrievedAt: acc.retrievedAt,
      hasCostData: true,
    }
  }

  return [...roots.values()].map(toNode).sort((a, b) => (b.projected || 0) - (a.projected || 0))
}

/**
 * Ensure subscription nodes that were retrieved with zero line items still show as retrieved
 * (empty months as $0) rather than never-retrieved placeholders.
 */
export function applyEmptyRetrievalMarkers(input: {
  tree: CostTreeNode[]
  retrievals: Array<{
    azureSubscriptionId: string
    customerId?: string | null
    customerName?: string | null
    subscriptionName?: string | null
    retrievedAt: string | null
  }>
  monthColumns: CostMonthColumn[]
}): CostTreeNode[] {
  if (!input.retrievals.length) return input.tree

  const monthKeys = input.monthColumns.map((m) => m.key)
  const zeroMonths = () =>
    Object.fromEntries(monthKeys.map((k) => [k, 0])) as Record<string, number | null>

  const byCustomer = new Map<string, CostTreeNode>()
  for (const root of input.tree) {
    byCustomer.set(root.id, {
      ...root,
      months: { ...root.months },
      children: root.children.map((c) => ({
        ...c,
        months: { ...c.months },
        children: c.children.map((x) => ({ ...x, months: { ...x.months }, children: [...x.children] })),
      })),
    })
  }

  for (const retrieval of input.retrievals) {
    const customerKey = retrieval.customerId || retrieval.customerName || 'unknown-customer'
    const customerLabel = retrieval.customerName || retrieval.customerId || 'Unknown customer'
    const custId = `cust:${customerKey}`
    const subId = `sub:${customerKey}:${retrieval.azureSubscriptionId}`
    let cust = byCustomer.get(custId)
    if (!cust) {
      cust = {
        id: custId,
        level: 1,
        label: customerLabel,
        months: zeroMonths(),
        projected: 0,
        children: [],
        resourceCount: 0,
        retrievedAt: retrieval.retrievedAt,
        hasCostData: true,
      }
      byCustomer.set(custId, cust)
    }
    const existingSub = cust.children.find((c) => c.id === subId)
    if (existingSub) {
      if (retrieval.retrievedAt && (!existingSub.retrievedAt || retrieval.retrievedAt > existingSub.retrievedAt)) {
        existingSub.retrievedAt = retrieval.retrievedAt
      }
      existingSub.hasCostData = true
      if (cust.retrievedAt == null || (retrieval.retrievedAt && retrieval.retrievedAt > cust.retrievedAt)) {
        cust.retrievedAt = retrieval.retrievedAt
      }
      cust.hasCostData = true
      continue
    }
    cust.children.push({
      id: subId,
      level: 2,
      label: retrieval.subscriptionName || retrieval.azureSubscriptionId,
      months: zeroMonths(),
      projected: 0,
      children: [],
      resourceCount: 0,
      retrievedAt: retrieval.retrievedAt,
      hasCostData: true,
    })
    if (cust.retrievedAt == null || (retrieval.retrievedAt && retrieval.retrievedAt > cust.retrievedAt)) {
      cust.retrievedAt = retrieval.retrievedAt
    }
    cust.hasCostData = true
  }

  return [...byCustomer.values()].sort((a, b) => (b.projected || 0) - (a.projected || 0) || a.label.localeCompare(b.label))
}

/** Merge retrieved hierarchy with empty placeholders for subscriptions never retrieved. */
export function mergeCostHierarchyWithPlaceholders(input: {
  retrievedTree: CostTreeNode[]
  placeholders: CostTreeNode[]
}): CostTreeNode[] {
  const byId = new Map<string, CostTreeNode>()

  const clone = (node: CostTreeNode): CostTreeNode => ({
    ...node,
    months: { ...node.months },
    children: node.children.map(clone),
  })

  for (const root of input.retrievedTree) {
    byId.set(root.id, clone(root))
  }

  for (const placeholder of input.placeholders) {
    const existing = byId.get(placeholder.id)
    if (!existing) {
      byId.set(placeholder.id, clone(placeholder))
      continue
    }
    const existingSubIds = new Set(existing.children.map((c) => c.id))
    for (const sub of placeholder.children) {
      if (!existingSubIds.has(sub.id)) {
        existing.children.push(clone(sub))
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.hasCostData !== b.hasCostData) return a.hasCostData ? -1 : 1
    return (b.projected || 0) - (a.projected || 0) || a.label.localeCompare(b.label)
  })
}

/** Flatten visible rows given an expanded-id set (parents expanded show children). */
export function flattenVisibleCostRows(
  roots: CostTreeNode[],
  expanded: Set<string>,
): CostTreeNode[] {
  const rows: CostTreeNode[] = []
  const walk = (nodes: CostTreeNode[]) => {
    for (const node of nodes) {
      rows.push(node)
      if (node.children.length > 0 && expanded.has(node.id)) {
        walk(node.children)
      }
    }
  }
  walk(roots)
  return rows
}
