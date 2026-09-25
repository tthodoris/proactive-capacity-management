import type {
  CapacityConstraint,
  InventoryItem,
  Quota,
  QuotaGroupLimit,
  Subscription,
} from '../types'
import {
  estimateVcpuFromSku,
  isQuotaExcludedFromScoring,
} from './capacityRisk'
import { findMatchingConstraintsForEval, filterListableConstraints } from './constraints'
import { normalizeRegionKey } from './regionCost'
import { prettyRegion } from './format'
import { toSkuFamily } from './skuFamily'

export type StrategyGroupBy = 'resourceGroup' | 'resourceType' | 'region' | 'skuFamily'

export interface StrategyWorkloadGroup {
  key: string
  label: string
  itemCount: number
  vcpuEstimate: number
  regions: Array<{ region: string; count: number; sharePct: number }>
  resourceTypes: Array<{ type: string; count: number }>
  skuFamilies: Array<{ family: string; count: number }>
  items: InventoryItem[]
}

export interface RegionShortlistEntry {
  regionId: string
  regionLabel: string
  role: 'Primary' | 'Secondary' | 'Tertiary' | 'Candidate'
  score: number
  reasons: string[]
  currentSharePct: number
  openConstraintCount: number
  quotaPressurePct: number | null
}

export interface FailoverScorecard {
  score: number
  grade: 'Strong' | 'Moderate' | 'Weak'
  pattern: 'Active-active ready' | 'Active-passive viable' | 'Redesign before failover'
  checks: Array<{ id: string; label: string; pass: boolean; detail: string }>
}

export interface DependencyNode {
  resourceType: string
  present: boolean
  count: number
  regions: string[]
  pairedWith: string[]
  note: string
}

/** Services present for a single subscription + region inventory slice. */
export interface DependencyPairSlice {
  key: string
  subscriptionId: string
  subscriptionName: string
  region: string
  regionLabel: string
  itemCount: number
  services: Array<{
    resourceType: string
    count: number
    pairedWithPresent: string[]
    note: string
  }>
}

/** Navigation state used to launch Region evaluation from Multiregion strategy. */
export type StrategyEvalLaunchState = {
  fromStrategy: true
  customerId: string
  subscriptionIds: string[]
  targetRegionIds: string[]
  autoEvaluate?: boolean
}

export interface WhatIfExpansionAdd {
  id: string
  resourceType: string
  sku: string
  size?: string
  count: number
  /** Optional planner group key (RG name or service category) that created this add. */
  groupKey?: string
}

export type WhatIfInventoryGroupBy = 'serviceCategory' | 'resourceGroup'

export interface WhatIfSelection {
  targetRegionId: string
  selectedItemIds: string[]
  ignoredDependencyIds: string[]
  expansionAdds: WhatIfExpansionAdd[]
  /** How inventory is grouped in the what-if planner. */
  inventoryGroupBy?: WhatIfInventoryGroupBy
  /** Optional focus on a single resource group within the selected workload. */
  focusedResourceGroup?: string | null
}

export interface WhatIfPlan {
  targetRegionId: string
  targetRegionLabel: string
  moveItemCount: number
  dependencyItemCount: number
  ignoredDependencyCount: number
  expansionItemCount: number
  projectedItemCount: number
  projectedVcpu: number
  movedItems: InventoryItem[]
  dependencyItems: InventoryItem[]
  byServiceCategory: Array<{
    resourceType: string
    moveCount: number
    dependencyCount: number
    expansionCount: number
    projectedCount: number
    projectedVcpu: number
  }>
  bySkuFamily: Array<{ family: string; sourceCount: number; projectedCount: number }>
  quotaWatch: Array<{
    region: string
    name: string
    usage: number
    limit: number
    usagePct: number
    projectedExtra: number
    note: string
  }>
}

export interface StrategyScenario {
  id: string
  customerId: string
  customerName: string
  name: string
  notes: string
  subscriptionIds: string[]
  groupBy: StrategyGroupBy
  selectedGroupKey: string | null
  candidateRegionIds: string[]
  /** @deprecated kept for older saved scenarios */
  whatIfPercent?: number
  whatIfSelection?: WhatIfSelection | null
  linkedEvaluationIds: string[]
  createdByUserId?: string | null
  createdByName?: string | null
  createdAt: string
  updatedAt: string
}

/** Common Azure region pairs used for secondary recommendations. */
export const REGION_PAIR_HINTS: Record<string, string[]> = {
  westeurope: ['northeurope', 'swedencentral', 'francecentral', 'germanywestcentral'],
  northeurope: ['westeurope', 'swedencentral', 'uk south', 'uksouth'],
  uksouth: ['ukwest', 'northeurope', 'westeurope'],
  ukwest: ['uksouth', 'northeurope'],
  eastus: ['westus2', 'eastus2', 'centralus'],
  eastus2: ['centralus', 'westus2', 'eastus'],
  westus2: ['eastus', 'westus3', 'centralus'],
  westus3: ['westus2', 'eastus'],
  francecentral: ['germanywestcentral', 'westeurope', 'northeurope'],
  germanywestcentral: ['francecentral', 'westeurope', 'swedencentral'],
  swedencentral: ['northeurope', 'westeurope', 'germanywestcentral'],
  canadacentral: ['canadaeast', 'eastus'],
  australiaeast: ['australiasoutheast', 'southeastasia'],
  southeastasia: ['eastasia', 'australiaeast'],
  japaneast: ['japanwest', 'koreacentral'],
  brazilsouth: ['southcentralus', 'eastus'],
}

const DEPENDENCY_GRAPH: Array<{ type: string; pairedWith: string[]; note: string }> = [
  {
    type: 'Virtual Machine',
    pairedWith: ['Storage Account', 'Key Vault', 'Application Gateway', 'VPN Gateway'],
    note: 'Compute usually depends on storage, secrets, and ingress.',
  },
  {
    type: 'Azure Kubernetes Service',
    pairedWith: ['Key Vault', 'Storage Account', 'Application Gateway', 'Azure Container Registry'],
    note: 'AKS needs registry, secrets, and often shared ingress.',
  },
  {
    type: 'Azure SQL Database',
    pairedWith: ['Virtual Machine', 'Azure Kubernetes Service', 'Key Vault'],
    note: 'Data tier must be available in the failover region or replicated.',
  },
  {
    type: 'Azure SQL Managed Instance',
    pairedWith: ['Virtual Machine', 'VPN Gateway', 'Key Vault'],
    note: 'MI often requires networking and private connectivity in both regions.',
  },
  {
    type: 'Key Vault',
    pairedWith: ['Virtual Machine', 'Azure Kubernetes Service', 'Application Gateway'],
    note: 'Secrets/certs must exist (or be replicated) in every active region.',
  },
  {
    type: 'Storage Account',
    pairedWith: ['Virtual Machine', 'Azure Kubernetes Service'],
    note: 'Disks/blobs and state often pin a workload to a region strategy.',
  },
  {
    type: 'Application Gateway',
    pairedWith: ['Virtual Machine', 'Azure Kubernetes Service', 'Key Vault'],
    note: 'Ingress and WAF posture should be planned per region.',
  },
  {
    type: 'VPN Gateway',
    pairedWith: ['Virtual Machine', 'Azure SQL Managed Instance'],
    note: 'Hybrid connectivity is a frequent multiregion blocker.',
  },
  {
    type: 'API Management',
    pairedWith: ['Application Gateway', 'Key Vault', 'Virtual Machine'],
    note: 'APIM multi-region requires explicit gateway deployment per region.',
  },
]

export function filterInventoryForStrategy(
  inventory: InventoryItem[],
  customerId: string,
  subscriptionIds: string[],
) {
  const subSet = new Set(subscriptionIds)
  return inventory.filter(
    (item) =>
      item.customerId === customerId &&
      (subscriptionIds.length === 0 || subSet.has(item.subscriptionId)),
  )
}

export function deriveAppGroupKey(item: InventoryItem, groupBy: StrategyGroupBy): string {
  if (groupBy === 'resourceType') return item.resourceType || 'Unknown type'
  if (groupBy === 'region') return item.region || 'Unknown region'
  if (groupBy === 'skuFamily') {
    return toSkuFamily(item.sku, item.size) || item.sku || 'Unknown SKU'
  }
  const rg = String(item.resourceGroup || '').trim()
  if (!rg) return 'Ungrouped resources'
  const cleaned = rg.replace(/^rg[-_]/i, '').replace(/^resourcegroup[-_]/i, '')
  const parts = cleaned.split(/[-_]/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
  return parts[0] || rg
}

export function buildWorkloadGroups(
  items: InventoryItem[],
  groupBy: StrategyGroupBy,
): StrategyWorkloadGroup[] {
  const map = new Map<string, InventoryItem[]>()
  for (const item of items) {
    const key = deriveAppGroupKey(item, groupBy)
    const list = map.get(key) || []
    list.push(item)
    map.set(key, list)
  }

  return [...map.entries()]
    .map(([key, groupItems]) => {
      const total = groupItems.length || 1
      const regionCounts = new Map<string, number>()
      const typeCounts = new Map<string, number>()
      const familyCounts = new Map<string, number>()
      let vcpuEstimate = 0
      for (const item of groupItems) {
        regionCounts.set(item.region, (regionCounts.get(item.region) || 0) + 1)
        typeCounts.set(item.resourceType, (typeCounts.get(item.resourceType) || 0) + 1)
        const family = toSkuFamily(item.sku, item.size) || item.sku
        familyCounts.set(family, (familyCounts.get(family) || 0) + 1)
        vcpuEstimate += estimateVcpuFromSku(item.sku, item.size)
      }
      const regions = [...regionCounts.entries()]
        .map(([region, count]) => ({
          region,
          count,
          sharePct: Math.round((count / total) * 1000) / 10,
        }))
        .sort((a, b) => b.count - a.count)
      return {
        key,
        label: key,
        itemCount: groupItems.length,
        vcpuEstimate,
        regions,
        resourceTypes: [...typeCounts.entries()]
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count),
        skuFamilies: [...familyCounts.entries()]
          .map(([family, count]) => ({ family, count }))
          .sort((a, b) => b.count - a.count),
        items: groupItems,
      }
    })
    .sort((a, b) => b.itemCount - a.itemCount || a.label.localeCompare(b.label))
}

function regionSharePct(items: InventoryItem[], regionIdOrLabel: string) {
  if (!items.length) return 0
  const want = normalizeRegionKey(regionIdOrLabel)
  const match = items.filter(
    (item) =>
      normalizeRegionKey(item.region) === want ||
      normalizeRegionKey(prettyRegion(item.region)) === want,
  ).length
  return Math.round((match / items.length) * 1000) / 10
}

function quotaPressureForRegion(quotas: Quota[], customerId: string, regionIdOrLabel: string) {
  const want = normalizeRegionKey(regionIdOrLabel)
  const scoped = quotas.filter((q) => {
    if (q.customerId && q.customerId !== customerId) return false
    if (isQuotaExcludedFromScoring(q)) return false
    if (!q.limit || q.limit <= 0) return false
    return (
      normalizeRegionKey(q.region) === want ||
      normalizeRegionKey(prettyRegion(q.region)) === want
    )
  })
  if (!scoped.length) return null
  let maxPct = 0
  for (const q of scoped) {
    maxPct = Math.max(maxPct, (q.usage / q.limit) * 100)
  }
  return Math.round(maxPct * 10) / 10
}

function openConstraintsForRegion(
  constraints: CapacityConstraint[],
  items: InventoryItem[],
  regionId: string,
  regionLabel: string,
) {
  const open = filterListableConstraints(constraints)
  const matched = new Set<string>()
  for (const item of items) {
    const hits = findMatchingConstraintsForEval({
      constraints: open,
      resourceType: item.resourceType,
      sku: item.sku,
      size: item.size,
      family: toSkuFamily(item.sku, item.size),
      targetRegionId: regionId,
      targetRegionLabel: regionLabel,
    })
    for (const c of hits) matched.add(c.id)
  }
  return open.filter((c) => matched.has(c.id))
}

export function buildRegionShortlist(input: {
  workloadItems: InventoryItem[]
  customerId: string
  constraints: CapacityConstraint[]
  quotas: Quota[]
  candidateRegions: Array<{ id: string; label: string }>
}): RegionShortlistEntry[] {
  const { workloadItems, customerId, constraints, quotas, candidateRegions } = input
  const scored = candidateRegions.map((region) => {
    const share = regionSharePct(workloadItems, region.id) || regionSharePct(workloadItems, region.label)
    const openConstraints = openConstraintsForRegion(
      constraints,
      workloadItems,
      region.id,
      region.label,
    )
    const quotaPressure = quotaPressureForRegion(quotas, customerId, region.id)
    const pairBoost = Object.entries(REGION_PAIR_HINTS).some(([primary, seconds]) => {
      const primaryShare =
        regionSharePct(workloadItems, primary) >= 20 ||
        regionSharePct(workloadItems, prettyRegion(primary)) >= 20
      if (!primaryShare) return false
      return seconds.some(
        (s) =>
          normalizeRegionKey(s) === normalizeRegionKey(region.id) ||
          normalizeRegionKey(s) === normalizeRegionKey(region.label),
      )
    })

    let score = 55
    const reasons: string[] = []

    if (share >= 40) {
      score += 18
      reasons.push(`Already hosts ${share}% of this workload — natural primary.`)
    } else if (share > 0) {
      score += 8
      reasons.push(`Already present at ${share}% — useful expansion foothold.`)
    } else {
      score += 4
      reasons.push('No current footprint — clean secondary/tertiary candidate.')
    }

    if (openConstraints.length === 0) {
      score += 16
      reasons.push('No open capacity constraints match this workload here.')
    } else {
      score -= Math.min(24, openConstraints.length * 8)
      reasons.push(
        `${openConstraints.length} open constraint${openConstraints.length === 1 ? '' : 's'} affect matching SKUs.`,
      )
    }

    if (quotaPressure == null) {
      score += 2
      reasons.push('No scoped quota pressure signal for this region.')
    } else if (quotaPressure < 70) {
      score += 12
      reasons.push(`Quota headroom looks healthier (peak ~${quotaPressure}%).`)
    } else if (quotaPressure < 90) {
      score += 2
      reasons.push(`Elevated quota usage (~${quotaPressure}%) — watch before scale-out.`)
    } else {
      score -= 14
      reasons.push(`Quota near exhaustion (~${quotaPressure}%) — weak expansion target.`)
    }

    if (pairBoost) {
      score += 10
      reasons.push('Common Azure pairing with a region that already hosts this workload.')
    }

    score = Math.max(0, Math.min(100, Math.round(score)))
    return {
      regionId: region.id,
      regionLabel: region.label,
      role: 'Candidate' as const,
      score,
      reasons,
      currentSharePct: share,
      openConstraintCount: openConstraints.length,
      quotaPressurePct: quotaPressure,
    }
  })

  scored.sort((a, b) => b.score - a.score || a.regionLabel.localeCompare(b.regionLabel))
  return scored.map((entry, index) => ({
    ...entry,
    role:
      index === 0 ? 'Primary' : index === 1 ? 'Secondary' : index === 2 ? 'Tertiary' : 'Candidate',
  }))
}

export function buildFailoverScorecard(input: {
  workloadItems: InventoryItem[]
  constraints: CapacityConstraint[]
  shortlist: RegionShortlistEntry[]
}): FailoverScorecard {
  const { workloadItems, constraints, shortlist } = input
  const regionWeights = new Map<string, number>()
  let totalWeight = 0
  for (const item of workloadItems) {
    const key = normalizeRegionKey(item.region) || 'unknown'
    const weight = Math.max(1, estimateVcpuFromSku(item.sku, item.size))
    regionWeights.set(key, (regionWeights.get(key) || 0) + weight)
    totalWeight += weight
  }
  const topWeight = Math.max(0, ...regionWeights.values())
  const topShare = totalWeight > 0 ? (topWeight / totalWeight) * 100 : 0
  const regionCount = regionWeights.size
  const open = filterListableConstraints(constraints)
  let constrainedSkus = 0
  for (const item of workloadItems) {
    for (const region of shortlist.slice(0, 3)) {
      const hits = findMatchingConstraintsForEval({
        constraints: open,
        resourceType: item.resourceType,
        sku: item.sku,
        size: item.size,
        targetRegionId: region.regionId,
        targetRegionLabel: region.regionLabel,
      })
      if (hits.length) {
        constrainedSkus += 1
        break
      }
    }
  }
  const types = new Set(workloadItems.map((i) => i.resourceType))
  const hasDataTier = [...types].some((t) => /sql|cosmos|mysql|postgres|storage/i.test(t))
  const hasSecretsOrIngress = [...types].some((t) => /key vault|application gateway|api management|vpn/i.test(t))

  const checks = [
    {
      id: 'multi-region-presence',
      label: 'Workload already spans more than one region',
      pass: regionCount >= 2,
      detail: regionCount >= 2 ? `Present in ${regionCount} regions.` : 'Single-region footprint today.',
    },
    {
      id: 'concentration',
      label: 'No extreme single-region concentration',
      pass: topShare < 85,
      detail: `Top region holds ~${Math.round(topShare)}% of capacity weight.`,
    },
    {
      id: 'secondary-candidate',
      label: 'Secondary region shortlist is healthy',
      pass: Boolean(shortlist[1] && shortlist[1].score >= 55 && shortlist[1].openConstraintCount === 0),
      detail: shortlist[1]
        ? `${shortlist[1].regionLabel} scores ${shortlist[1].score}/100 with ${shortlist[1].openConstraintCount} open constraints.`
        : 'Need at least two candidate regions.',
    },
    {
      id: 'constraint-pressure',
      label: 'Limited constrained SKUs on primary/secondary path',
      pass: constrainedSkus <= Math.max(1, Math.floor(workloadItems.length * 0.15)),
      detail: `${constrainedSkus} inventory item(s) match open constraints in top candidate regions.`,
    },
    {
      id: 'paired-services',
      label: 'Data and edge dependencies are visible in inventory',
      pass: hasDataTier && hasSecretsOrIngress,
      detail:
        hasDataTier && hasSecretsOrIngress
          ? 'Data tier and ingress/secrets types are present for paired planning.'
          : 'Missing data tier and/or ingress/secrets types — validate outside inventory before active-active.',
    },
  ]

  const passed = checks.filter((c) => c.pass).length
  const score = Math.round((passed / checks.length) * 100)
  const grade: FailoverScorecard['grade'] =
    score >= 80 ? 'Strong' : score >= 50 ? 'Moderate' : 'Weak'
  const pattern: FailoverScorecard['pattern'] =
    score >= 80
      ? 'Active-active ready'
      : score >= 50
        ? 'Active-passive viable'
        : 'Redesign before failover'

  return { score, grade, pattern, checks }
}

export function buildDependencyMap(
  workloadItems: InventoryItem[],
  subscriptions: Subscription[] = [],
): DependencyPairSlice[] {
  const byPair = new Map<
    string,
    {
      subscriptionId: string
      region: string
      itemCount: number
      types: Map<string, number>
    }
  >()

  for (const item of workloadItems) {
    const subscriptionId = item.subscriptionId || 'unknown'
    const region = item.region || 'Unknown region'
    const key = `${subscriptionId}::${normalizeRegionKey(region) || region}`
    const cur = byPair.get(key) || {
      subscriptionId,
      region,
      itemCount: 0,
      types: new Map<string, number>(),
    }
    cur.itemCount += 1
    cur.types.set(item.resourceType, (cur.types.get(item.resourceType) || 0) + 1)
    byPair.set(key, cur)
  }

  const graphNote = (type: string) =>
    DEPENDENCY_GRAPH.find((d) => d.type === type)?.note ||
    'Present in this subscription / region — include in region parity checks.'

  const graphPairs = (type: string) =>
    DEPENDENCY_GRAPH.find((d) => d.type === type)?.pairedWith || []

  return [...byPair.entries()]
    .map(([key, slice]) => {
      const presentTypes = new Set(slice.types.keys())
      const services = [...slice.types.entries()]
        .map(([resourceType, count]) => ({
          resourceType,
          count,
          pairedWithPresent: graphPairs(resourceType).filter((t) => presentTypes.has(t)),
          note: graphNote(resourceType),
        }))
        .sort((a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType))

      return {
        key,
        subscriptionId: slice.subscriptionId,
        subscriptionName: subscriptionLabel(subscriptions, slice.subscriptionId),
        region: slice.region,
        regionLabel: prettyRegion(slice.region),
        itemCount: slice.itemCount,
        services,
      }
    })
    .sort(
      (a, b) =>
        a.subscriptionName.localeCompare(b.subscriptionName) ||
        a.regionLabel.localeCompare(b.regionLabel),
    )
}

/** Resolve inventory / strategy region labels to Azure region option ids. */
export function resolveStrategyRegionIds(
  regionValues: string[],
  regionOptions: Array<{ value: string; label: string }>,
) {
  const out = new Set<string>()
  for (const raw of regionValues) {
    const key = normalizeRegionKey(raw)
    if (!key) continue
    const match = regionOptions.find(
      (opt) =>
        normalizeRegionKey(opt.value) === key || normalizeRegionKey(opt.label) === key,
    )
    out.add(match?.value || raw)
  }
  return [...out]
}

export function pairedServiceTypes(resourceType: string): string[] {
  return DEPENDENCY_GRAPH.find((d) => d.type === resourceType)?.pairedWith || []
}

export function dependencyNoteForType(resourceType: string): string {
  return (
    DEPENDENCY_GRAPH.find((d) => d.type === resourceType)?.note ||
    'Related service commonly required alongside the selected workload.'
  )
}

/** Inventory items suggested as dependencies for the selected move set. */
export function suggestDependencyItems(
  selectedItems: InventoryItem[],
  pool: InventoryItem[],
): InventoryItem[] {
  if (!selectedItems.length) return []
  const selectedIds = new Set(selectedItems.map((item) => item.id))
  const neededTypes = new Set<string>()
  for (const item of selectedItems) {
    for (const type of pairedServiceTypes(item.resourceType)) neededTypes.add(type)
  }
  if (neededTypes.size === 0) return []

  const subIds = new Set(selectedItems.map((item) => item.subscriptionId))
  const resourceGroups = new Set(
    selectedItems.map((item) => String(item.resourceGroup || '').trim().toLowerCase()).filter(Boolean),
  )

  const scored = pool
    .filter((item) => {
      if (selectedIds.has(item.id)) return false
      if (!neededTypes.has(item.resourceType)) return false
      if (!subIds.has(item.subscriptionId)) return false
      return true
    })
    .map((item) => {
      const sameRg = resourceGroups.has(String(item.resourceGroup || '').trim().toLowerCase())
      return { item, rank: sameRg ? 0 : 1 }
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.item.resourceType.localeCompare(b.item.resourceType) ||
        a.item.name.localeCompare(b.item.name),
    )

  return scored.map((row) => row.item)
}

export function groupInventoryByServiceCategory(items: InventoryItem[]) {
  const map = new Map<string, InventoryItem[]>()
  for (const item of items) {
    const key = item.resourceType || 'Unknown'
    const list = map.get(key) || []
    list.push(item)
    map.set(key, list)
  }
  return [...map.entries()]
    .map(([resourceType, groupItems]) => ({
      resourceType,
      items: groupItems
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku)),
      count: groupItems.length,
      vcpuEstimate: groupItems.reduce(
        (sum, item) => sum + estimateVcpuFromSku(item.sku, item.size),
        0,
      ),
    }))
    .sort((a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType))
}

export type WhatIfInventoryGroup = {
  key: string
  label: string
  items: InventoryItem[]
  count: number
  vcpuEstimate: number
  /** Default resource type for expansion adds (most common in the group). */
  defaultResourceType: string
  resourceTypes: string[]
}

export function groupInventoryForWhatIf(
  items: InventoryItem[],
  mode: WhatIfInventoryGroupBy,
): WhatIfInventoryGroup[] {
  const map = new Map<string, InventoryItem[]>()
  for (const item of items) {
    const key =
      mode === 'resourceGroup'
        ? String(item.resourceGroup || '').trim() || '(no resource group)'
        : item.resourceType || 'Unknown'
    const list = map.get(key) || []
    list.push(item)
    map.set(key, list)
  }

  return [...map.entries()]
    .map(([key, groupItems]) => {
      const sorted = groupItems
        .slice()
        .sort(
          (a, b) =>
            a.resourceType.localeCompare(b.resourceType) ||
            a.name.localeCompare(b.name) ||
            a.sku.localeCompare(b.sku),
        )
      const typeCounts = new Map<string, number>()
      for (const item of sorted) {
        typeCounts.set(item.resourceType, (typeCounts.get(item.resourceType) || 0) + 1)
      }
      const resourceTypes = [...typeCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([type]) => type)
      return {
        key,
        label: key,
        items: sorted,
        count: sorted.length,
        vcpuEstimate: sorted.reduce(
          (sum, item) => sum + estimateVcpuFromSku(item.sku, item.size),
          0,
        ),
        defaultResourceType: resourceTypes[0] || 'Virtual Machine',
        resourceTypes,
      }
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function emptyWhatIfSelection(targetRegionId = ''): WhatIfSelection {
  return {
    targetRegionId,
    selectedItemIds: [],
    ignoredDependencyIds: [],
    expansionAdds: [],
    inventoryGroupBy: 'resourceGroup',
    focusedResourceGroup: null,
  }
}

export function buildWhatIfPlan(input: {
  workloadItems: InventoryItem[]
  selection: WhatIfSelection
  customerId: string
  quotas: Quota[]
  targetRegionId: string
  targetRegionLabel: string
}): WhatIfPlan {
  const selectedIds = new Set(input.selection.selectedItemIds || [])
  const ignoredIds = new Set(input.selection.ignoredDependencyIds || [])
  const movedItems = input.workloadItems.filter((item) => selectedIds.has(item.id))
  const suggestedDeps = suggestDependencyItems(movedItems, input.workloadItems)
  const dependencyItems = suggestedDeps.filter((item) => !ignoredIds.has(item.id))
  const ignoredDependencyCount = suggestedDeps.filter((item) => ignoredIds.has(item.id)).length

  const expansionAdds = (input.selection.expansionAdds || []).filter(
    (row) => row.resourceType && row.sku && Number(row.count) > 0,
  )

  const includedInventory = [...movedItems, ...dependencyItems]
  let projectedVcpu = 0
  const familyCounts = new Map<string, number>()
  const categoryMove = new Map<string, number>()
  const categoryDep = new Map<string, number>()
  const categoryExp = new Map<string, number>()
  const categoryVcpu = new Map<string, number>()

  for (const item of includedInventory) {
    const vcpu = estimateVcpuFromSku(item.sku, item.size)
    projectedVcpu += vcpu
    const family = toSkuFamily(item.sku, item.size) || item.sku
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1)
    const bucket = selectedIds.has(item.id) ? categoryMove : categoryDep
    bucket.set(item.resourceType, (bucket.get(item.resourceType) || 0) + 1)
    categoryVcpu.set(item.resourceType, (categoryVcpu.get(item.resourceType) || 0) + vcpu)
  }

  let expansionItemCount = 0
  for (const add of expansionAdds) {
    const count = Math.max(1, Math.floor(Number(add.count) || 0))
    expansionItemCount += count
    const vcpuEach = estimateVcpuFromSku(add.sku, add.size)
    projectedVcpu += vcpuEach * count
    const family = toSkuFamily(add.sku, add.size) || add.sku
    familyCounts.set(family, (familyCounts.get(family) || 0) + count)
    categoryExp.set(add.resourceType, (categoryExp.get(add.resourceType) || 0) + count)
    categoryVcpu.set(
      add.resourceType,
      (categoryVcpu.get(add.resourceType) || 0) + vcpuEach * count,
    )
  }

  const allTypes = new Set([
    ...categoryMove.keys(),
    ...categoryDep.keys(),
    ...categoryExp.keys(),
  ])
  const byServiceCategory = [...allTypes]
    .map((resourceType) => {
      const moveCount = categoryMove.get(resourceType) || 0
      const dependencyCount = categoryDep.get(resourceType) || 0
      const expansionCount = categoryExp.get(resourceType) || 0
      return {
        resourceType,
        moveCount,
        dependencyCount,
        expansionCount,
        projectedCount: moveCount + dependencyCount + expansionCount,
        projectedVcpu: categoryVcpu.get(resourceType) || 0,
      }
    })
    .sort((a, b) => b.projectedCount - a.projectedCount || a.resourceType.localeCompare(b.resourceType))

  const bySkuFamily = [...familyCounts.entries()]
    .map(([family, projectedCount]) => ({
      family,
      sourceCount: projectedCount,
      projectedCount,
    }))
    .sort((a, b) => b.projectedCount - a.projectedCount)
    .slice(0, 12)

  const projectedItemCount = includedInventory.length + expansionItemCount
  const want = normalizeRegionKey(input.targetRegionId)
  const quotaWatch = input.quotas
    .filter((q) => {
      if (q.customerId && q.customerId !== input.customerId) return false
      if (isQuotaExcludedFromScoring(q)) return false
      if (!q.limit || q.limit <= 0) return false
      return (
        normalizeRegionKey(q.region) === want ||
        normalizeRegionKey(prettyRegion(q.region)) === want ||
        normalizeRegionKey(q.region) === normalizeRegionKey(input.targetRegionLabel)
      )
    })
    .map((q) => {
      const usagePct = Math.round((q.usage / q.limit) * 1000) / 10
      const projectedExtra = /vcpu/i.test(`${q.name} ${q.unit || ''}`)
        ? projectedVcpu
        : projectedItemCount
      const note =
        q.usage + projectedExtra > q.limit
          ? 'Projected add would exceed current limit.'
          : q.usage + projectedExtra > q.limit * 0.85
            ? 'Projected add pushes usage above 85%.'
            : 'Headroom appears sufficient for this what-if.'
      return {
        region: prettyRegion(q.region),
        name: q.name,
        usage: q.usage,
        limit: q.limit,
        usagePct,
        projectedExtra,
        note,
      }
    })
    .sort((a, b) => b.usagePct - a.usagePct)
    .slice(0, 8)

  return {
    targetRegionId: input.targetRegionId,
    targetRegionLabel: input.targetRegionLabel,
    moveItemCount: movedItems.length,
    dependencyItemCount: dependencyItems.length,
    ignoredDependencyCount,
    expansionItemCount,
    projectedItemCount,
    projectedVcpu,
    movedItems,
    dependencyItems,
    byServiceCategory,
    bySkuFamily,
    quotaWatch,
  }
}

export function subscriptionLabel(
  subscriptions: Subscription[],
  subscriptionId: string,
) {
  return subscriptions.find((s) => s.id === subscriptionId)?.name || subscriptionId
}

/** Minimal evaluation shape needed for strategy linking / gap analysis. */
export type StrategyEvaluationLike = {
  id: string
  customerId: string
  subscriptionIds?: string[]
  subscriptionNames?: string[]
  targetRegions?: Array<{ id: string; label?: string }>
  results?: Array<{
    resourceType: string
    sku: string
    size?: string | null
    family?: string | null
    resourceCount: number
    sourceRegions?: string[]
    byRegion?: Record<
      string,
      {
        status?: string
        reason?: string
      }
    >
  }>
  createdAt?: string
}

export type StrategySkuGap = {
  evaluationId: string
  regionId: string
  regionLabel: string
  resourceType: string
  sku: string
  size: string | null
  family: string | null
  resourceCount: number
  status: string
  constrained: boolean
  reason: string
}

export type StrategyQuotaRecommendation = {
  source: 'quota' | 'quotaGroup'
  name: string
  region: string
  usage: number
  limit: number
  usagePct: number
  suggestedLimit: number
  increaseBy: number
  priority: 'critical' | 'high' | 'medium'
  unit: string
  rationale: string
  subscriptionHint?: string
}

export type StrategyEvalCoverage = {
  hasMatchingEvaluation: boolean
  matchingCount: number
  linkedMatchingCount: number
  uncoveredSubscriptions: string[]
  uncoveredRegions: string[]
  coveredSubscriptions: string[]
  coveredRegions: string[]
}

function regionInSet(regionIdOrLabel: string, keys: Set<string>) {
  const normalized = normalizeRegionKey(regionIdOrLabel)
  if (!normalized) return false
  if (keys.has(normalized)) return true
  return keys.has(normalizeRegionKey(prettyRegion(regionIdOrLabel)))
}

/**
 * An evaluation is linkable when it shares at least one selected subscription
 * and at least one candidate region with the strategy scope.
 */
export function evaluationMatchesStrategyScope(
  evaluation: StrategyEvaluationLike,
  scope: {
    customerId: string
    subscriptionIds: string[]
    regionIds: string[]
  },
): boolean {
  if (!scope.customerId || evaluation.customerId !== scope.customerId) return false
  if (!scope.subscriptionIds.length || !scope.regionIds.length) return false

  const evalSubs = new Set((evaluation.subscriptionIds || []).map(String))
  const subMatch = scope.subscriptionIds.some((id) => evalSubs.has(id))
  if (!subMatch) return false

  const regionKeys = new Set(scope.regionIds.map((id) => normalizeRegionKey(id)).filter(Boolean))
  return (evaluation.targetRegions || []).some(
    (region) =>
      regionInSet(region.id, regionKeys) || regionInSet(region.label || '', regionKeys),
  )
}

export function filterLinkableEvaluations<T extends StrategyEvaluationLike>(
  evaluations: T[],
  scope: {
    customerId: string
    subscriptionIds: string[]
    regionIds: string[]
  },
): T[] {
  return evaluations
    .filter((evaluation) => evaluationMatchesStrategyScope(evaluation, scope))
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

export function pruneLinkedEvaluationIds(
  linkedIds: string[],
  linkableEvaluations: Array<{ id: string }>,
) {
  const allowed = new Set(linkableEvaluations.map((e) => e.id))
  return linkedIds.filter((id) => allowed.has(id))
}

export function buildStrategyEvalCoverage(input: {
  subscriptionIds: string[]
  regionIds: Array<{ id: string; label: string }>
  matchingEvaluations: StrategyEvaluationLike[]
  linkedEvaluationIds: string[]
}): StrategyEvalCoverage {
  const matching = input.matchingEvaluations
  const linkedSet = new Set(input.linkedEvaluationIds)
  const linkedMatchingCount = matching.filter((e) => linkedSet.has(e.id)).length

  const coveredSubs = new Set<string>()
  const coveredRegions = new Set<string>()
  for (const evaluation of matching) {
    for (const subId of evaluation.subscriptionIds || []) coveredSubs.add(subId)
    for (const region of evaluation.targetRegions || []) {
      coveredRegions.add(normalizeRegionKey(region.id))
      if (region.label) coveredRegions.add(normalizeRegionKey(region.label))
    }
  }

  const uncoveredSubscriptions = input.subscriptionIds.filter((id) => !coveredSubs.has(id))
  const uncoveredRegions = input.regionIds
    .filter(
      (region) =>
        !regionInSet(region.id, coveredRegions) && !regionInSet(region.label, coveredRegions),
    )
    .map((region) => region.label || region.id)

  return {
    hasMatchingEvaluation: matching.length > 0,
    matchingCount: matching.length,
    linkedMatchingCount,
    uncoveredSubscriptions,
    uncoveredRegions,
    coveredSubscriptions: input.subscriptionIds.filter((id) => coveredSubs.has(id)),
    coveredRegions: input.regionIds
      .filter(
        (region) =>
          regionInSet(region.id, coveredRegions) || regionInSet(region.label, coveredRegions),
      )
      .map((region) => region.label || region.id),
  }
}

function gapKey(gap: Pick<StrategySkuGap, 'evaluationId' | 'regionId' | 'resourceType' | 'sku' | 'size'>) {
  return `${gap.evaluationId}|${gap.regionId}|${gap.resourceType}|${gap.sku}|${gap.size || ''}`
}

/** SKU unavailability + constraint gaps from evaluations that match strategy scope. */
export function collectStrategySkuGaps(input: {
  evaluations: StrategyEvaluationLike[]
  constraints: CapacityConstraint[]
  regionIds: Array<{ id: string; label: string }>
}): StrategySkuGap[] {
  const open = filterListableConstraints(input.constraints)
  const regionKeys = new Set(
    input.regionIds.flatMap((r) => [normalizeRegionKey(r.id), normalizeRegionKey(r.label)]),
  )
  const byKey = new Map<string, StrategySkuGap>()

  for (const evaluation of input.evaluations) {
    for (const row of evaluation.results || []) {
      for (const region of evaluation.targetRegions || []) {
        if (!regionInSet(region.id, regionKeys) && !regionInSet(region.label || '', regionKeys)) {
          continue
        }
        const cell = row.byRegion?.[region.id]
        const status = String(cell?.status || 'unknown')
        const regionLabel = region.label || region.id
        const matchingConstraints = findMatchingConstraintsForEval({
          constraints: open,
          resourceType: row.resourceType,
          sku: row.sku,
          size: row.size,
          family: row.family,
          targetRegionId: region.id,
          targetRegionLabel: regionLabel,
        })
        const availabilityGap = status !== 'available'
        const constrained = matchingConstraints.length > 0
        if (!availabilityGap && !constrained) continue

        const reasonParts: string[] = []
        if (availabilityGap) reasonParts.push(cell?.reason || 'No availability reason recorded')
        if (constrained) {
          reasonParts.push(
            `${matchingConstraints.length} open capacity constraint${
              matchingConstraints.length === 1 ? '' : 's'
            }: ${matchingConstraints.map((c) => `${c.sku} (${c.severity})`).join(', ')}`,
          )
        }

        const gap: StrategySkuGap = {
          evaluationId: evaluation.id,
          regionId: region.id,
          regionLabel,
          resourceType: row.resourceType,
          sku: row.sku,
          size: row.size ?? null,
          family: row.family ?? null,
          resourceCount: row.resourceCount,
          status,
          constrained,
          reason: reasonParts.join(' · '),
        }
        byKey.set(gapKey(gap), gap)
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.regionLabel.localeCompare(b.regionLabel) ||
      a.resourceType.localeCompare(b.resourceType) ||
      a.sku.localeCompare(b.sku),
  )
}

function quotaPriority(usagePct: number): StrategyQuotaRecommendation['priority'] {
  if (usagePct >= 95) return 'critical'
  if (usagePct >= 80) return 'high'
  return 'medium'
}

/** Recommend quota / quota-group increases for strategy subscriptions + candidate regions. */
export function buildStrategyQuotaRecommendations(input: {
  customerId: string
  subscriptionIds: string[]
  regionIds: Array<{ id: string; label: string }>
  quotas: Quota[]
  quotaGroupLimits: QuotaGroupLimit[]
  projectedExtraVcpu?: number
  minUsagePct?: number
  targetUsagePct?: number
  limit?: number
}): StrategyQuotaRecommendation[] {
  const minUsagePct = input.minUsagePct ?? 60
  const targetUsagePct = input.targetUsagePct ?? 70
  const maxRows = input.limit ?? 20
  const targetRatio = targetUsagePct / 100
  const subSet = new Set(input.subscriptionIds)
  const regionKeys = new Set(
    input.regionIds.flatMap((r) => [normalizeRegionKey(r.id), normalizeRegionKey(r.label)]),
  )
  const projectedExtra = Math.max(0, Number(input.projectedExtraVcpu || 0))
  const recommendations: StrategyQuotaRecommendation[] = []

  for (const quota of input.quotas) {
    if (quota.customerId && quota.customerId !== input.customerId) continue
    if (quota.subscriptionId && !subSet.has(quota.subscriptionId)) continue
    if (!regionInSet(quota.region, regionKeys)) continue
    if (isQuotaExcludedFromScoring(quota)) continue
    const limit = Number(quota.limit)
    const usage = Number(quota.usage)
    if (!(limit > 0) || !(usage >= 0)) continue

    const isVcpu = /vcpu/i.test(`${quota.name} ${quota.unit || ''}`)
    const effectiveUsage = usage + (isVcpu ? projectedExtra : 0)
    const usagePct = Math.round((effectiveUsage / limit) * 1000) / 10
    if (usagePct < minUsagePct && effectiveUsage <= limit * 0.85) continue

    const suggestedLimit = Math.max(limit, Math.ceil(effectiveUsage / targetRatio))
    const increaseBy = suggestedLimit - limit
    if (increaseBy <= 0 && usagePct < minUsagePct) continue

    recommendations.push({
      source: 'quota',
      name: quota.name,
      region: prettyRegion(quota.region),
      usage: effectiveUsage,
      limit,
      usagePct,
      suggestedLimit,
      increaseBy,
      priority: quotaPriority(usagePct),
      unit: quota.unit || '',
      subscriptionHint: quota.subscriptionName || quota.subscriptionId || undefined,
      rationale:
        projectedExtra > 0 && isVcpu
          ? `Including projected +${projectedExtra} vCPU from what-if, raise limit from ${limit} to ≥${suggestedLimit} so usage sits near ${targetUsagePct}%.`
          : `Raise limit from ${limit} to ≥${suggestedLimit} so usage (${usage}) sits near ${targetUsagePct}%.`,
    })
  }

  for (const group of input.quotaGroupLimits) {
    if (group.customerId && group.customerId !== input.customerId) continue
    const groupSubs = group.subscriptionIds || []
    if (!groupSubs.some((id) => subSet.has(id))) continue
    if (!regionInSet(group.region, regionKeys)) continue
    if (isQuotaExcludedFromScoring({ name: group.name, nameValue: group.nameValue })) continue

    const limit = Number(group.limit)
    const allocated = Number(group.allocated)
    if (!(limit > 0) || !(allocated >= 0)) continue

    const isVcpu = /vcpu/i.test(`${group.name} ${group.unit || ''}`)
    const effectiveUsage = allocated + (isVcpu ? projectedExtra : 0)
    const usagePct = Math.round((effectiveUsage / limit) * 1000) / 10
    if (usagePct < minUsagePct && effectiveUsage <= limit * 0.85) continue

    const suggestedLimit = Math.max(limit, Math.ceil(effectiveUsage / targetRatio))
    const increaseBy = suggestedLimit - limit
    if (increaseBy <= 0 && usagePct < minUsagePct) continue

    recommendations.push({
      source: 'quotaGroup',
      name: group.groupDisplayName || group.name,
      region: prettyRegion(group.region),
      usage: effectiveUsage,
      limit,
      usagePct,
      suggestedLimit,
      increaseBy,
      priority: quotaPriority(usagePct),
      unit: group.unit || '',
      subscriptionHint: `${groupSubs.filter((id) => subSet.has(id)).length} matching subscription(s)`,
      rationale:
        projectedExtra > 0 && isVcpu
          ? `Quota group pressure with projected +${projectedExtra} vCPU — raise shared limit from ${limit} to ≥${suggestedLimit}.`
          : `Quota group allocated ${allocated}/${limit}; raise shared limit to ≥${suggestedLimit} (~${targetUsagePct}% target).`,
    })
  }

  return recommendations
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2 }
      return order[a.priority] - order[b.priority] || b.usagePct - a.usagePct
    })
    .slice(0, maxRows)
}
