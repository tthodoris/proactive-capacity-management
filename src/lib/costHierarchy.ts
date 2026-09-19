import type { Customer, InventoryItem, Subscription } from '../types'

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
  /** Monthly costs aligned with `months` keys (USD). */
  months: Record<string, number>
  projected: number
  children: CostTreeNode[]
  resourceCount: number
}

function hashString(input: string) {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Rough monthly USD estimate from SKU name until Cost Management API is wired. */
export function estimateMonthlyCostUsd(sku: string, resourceType: string) {
  const text = `${sku} ${resourceType}`.toLowerCase()
  const coresMatch = sku.match(/_([a-z]?)(\d+)/i)
  const cores = coresMatch ? Math.max(1, Number(coresMatch[2]) || 4) : 4
  let rate = 42
  if (/gpu|nc|nd|nv/.test(text)) rate = 180
  else if (/memory|e\d|m\d/.test(text)) rate = 58
  else if (/aks|kubernetes|container/.test(text)) rate = 36
  else if (/sql|database|cosmos|postgres/.test(text)) rate = 95
  else if (/storage|disk|blob/.test(text)) rate = 18
  else if (/app service|function|web/.test(text)) rate = 28
  const noise = (hashString(sku) % 17) - 8
  return Math.max(12, cores * rate + noise)
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

function seriesForLeaf(baseMonthly: number, monthKeys: string[], seed: string) {
  const out: Record<string, number> = {}
  const h = hashString(seed)
  monthKeys.forEach((key, index) => {
    const wave = 1 + (((h >> (index % 8)) & 7) - 3) * 0.018
    const trend = 1 + (index - (monthKeys.length - 1)) * 0.012
    out[key] = Math.max(0, baseMonthly * wave * trend)
  })
  return out
}

function sumSeries(nodes: CostTreeNode[], monthKeys: string[]) {
  const months: Record<string, number> = {}
  for (const key of monthKeys) months[key] = 0
  let projected = 0
  let resourceCount = 0
  for (const node of nodes) {
    for (const key of monthKeys) months[key] += node.months[key] || 0
    projected += node.projected
    resourceCount += node.resourceCount
  }
  return { months, projected, resourceCount }
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const list = map.get(key)
    if (list) list.push(item)
    else map.set(key, [item])
  }
  return map
}

export function buildCostHierarchy(input: {
  inventory: InventoryItem[]
  customers: Customer[]
  subscriptions: Subscription[]
  monthColumns: CostMonthColumn[]
}): CostTreeNode[] {
  const monthKeys = input.monthColumns.map((m) => m.key)
  const currentKey = input.monthColumns.find((m) => m.isCurrent)?.key || monthKeys[monthKeys.length - 1]
  const customerName = new Map(input.customers.map((c) => [c.id, c.name]))
  const subName = new Map(input.subscriptions.map((s) => [s.id, s.name]))

  const byCustomer = groupBy(input.inventory, (i) => i.customerId)
  const roots: CostTreeNode[] = []

  for (const [customerId, customerItems] of byCustomer) {
    const bySub = groupBy(customerItems, (i) => i.subscriptionId)
    const subNodes: CostTreeNode[] = []

    for (const [subscriptionId, subItems] of bySub) {
      const byRg = groupBy(subItems, (i) => i.resourceGroup || '(no resource group)')
      const rgNodes: CostTreeNode[] = []

      for (const [resourceGroup, rgItems] of byRg) {
        const byType = groupBy(rgItems, (i) => i.resourceType || 'Unknown')
        const typeNodes: CostTreeNode[] = []

        for (const [serviceType, typeItems] of byType) {
          const bySku = groupBy(typeItems, (i) => i.sku || 'Unknown SKU')
          const skuNodes: CostTreeNode[] = []

          for (const [sku, skuItems] of bySku) {
            const resourceNodes: CostTreeNode[] = skuItems.map((item) => {
              const base = estimateMonthlyCostUsd(item.sku, item.resourceType)
              const months = seriesForLeaf(base, monthKeys, item.id)
              const projected = (months[currentKey] || base) * 1.04
              return {
                id: `res:${item.id}`,
                level: 6 as const,
                label: item.name,
                months,
                projected,
                children: [],
                resourceCount: 1,
              }
            })

            const skuAgg = sumSeries(resourceNodes, monthKeys)
            skuNodes.push({
              id: `sku:${customerId}:${subscriptionId}:${resourceGroup}:${serviceType}:${sku}`,
              level: 5,
              label: sku,
              months: skuAgg.months,
              projected: skuAgg.projected,
              children: resourceNodes,
              resourceCount: skuAgg.resourceCount,
            })
          }

          skuNodes.sort((a, b) => b.projected - a.projected)
          const typeAgg = sumSeries(skuNodes, monthKeys)
          typeNodes.push({
            id: `type:${customerId}:${subscriptionId}:${resourceGroup}:${serviceType}`,
            level: 4,
            label: serviceType,
            months: typeAgg.months,
            projected: typeAgg.projected,
            children: skuNodes,
            resourceCount: typeAgg.resourceCount,
          })
        }

        typeNodes.sort((a, b) => b.projected - a.projected)
        const rgAgg = sumSeries(typeNodes, monthKeys)
        rgNodes.push({
          id: `rg:${customerId}:${subscriptionId}:${resourceGroup}`,
          level: 3,
          label: resourceGroup,
          months: rgAgg.months,
          projected: rgAgg.projected,
          children: typeNodes,
          resourceCount: rgAgg.resourceCount,
        })
      }

      rgNodes.sort((a, b) => b.projected - a.projected)
      const subAgg = sumSeries(rgNodes, monthKeys)
      subNodes.push({
        id: `sub:${customerId}:${subscriptionId}`,
        level: 2,
        label: subName.get(subscriptionId) || subscriptionId,
        months: subAgg.months,
        projected: subAgg.projected,
        children: rgNodes,
        resourceCount: subAgg.resourceCount,
      })
    }

    subNodes.sort((a, b) => b.projected - a.projected)
    const custAgg = sumSeries(subNodes, monthKeys)
    roots.push({
      id: `cust:${customerId}`,
      level: 1,
      label: customerName.get(customerId) || customerId,
      months: custAgg.months,
      projected: custAgg.projected,
      children: subNodes,
      resourceCount: custAgg.resourceCount,
    })
  }

  roots.sort((a, b) => b.projected - a.projected)
  return roots
}

export function formatCompactUsd(value: number) {
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
}

export function buildCostHierarchyFromActual(input: {
  rows: CostActualLeaf[]
  monthColumns: CostMonthColumn[]
}): CostTreeNode[] {
  const monthKeys = input.monthColumns.map((m) => m.key)
  const currentKey =
    input.monthColumns.find((m) => m.isCurrent)?.key || monthKeys[monthKeys.length - 1]

  const emptyMonths = () => Object.fromEntries(monthKeys.map((k) => [k, 0]))

  type Acc = {
    id: string
    level: CostLevel
    label: string
    months: Record<string, number>
    projected: number
    resourceCount: number
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
        children: new Map(),
      }
      parent.set(id, node)
    }
    return node
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
  }

  const toNode = (acc: Acc): CostTreeNode => {
    const children = [...acc.children.values()]
      .map(toNode)
      .sort((a, b) => b.projected - a.projected)
    return {
      id: acc.id,
      level: acc.level,
      label: acc.label,
      months: acc.months,
      projected: acc.projected,
      children,
      resourceCount: acc.resourceCount,
    }
  }

  return [...roots.values()].map(toNode).sort((a, b) => b.projected - a.projected)
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
