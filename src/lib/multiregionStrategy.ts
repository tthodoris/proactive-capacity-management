import type {
  CapacityConstraint,
  InventoryItem,
  Quota,
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

export interface WhatIfPlan {
  percent: number
  sourceItemCount: number
  projectedItemCount: number
  sourceVcpu: number
  projectedVcpu: number
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
  whatIfPercent: number
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

export function buildDependencyMap(workloadItems: InventoryItem[]): DependencyNode[] {
  const counts = new Map<string, { count: number; regions: Set<string> }>()
  for (const item of workloadItems) {
    const cur = counts.get(item.resourceType) || { count: 0, regions: new Set<string>() }
    cur.count += 1
    cur.regions.add(item.region)
    counts.set(item.resourceType, cur)
  }

  const presentTypes = new Set(counts.keys())
  const nodes: DependencyNode[] = DEPENDENCY_GRAPH.map((dep) => {
    const found = counts.get(dep.type)
    return {
      resourceType: dep.type,
      present: Boolean(found),
      count: found?.count || 0,
      regions: found ? [...found.regions].sort() : [],
      pairedWith: dep.pairedWith.filter((t) => presentTypes.has(t) || DEPENDENCY_GRAPH.some((d) => d.type === t)),
      note: dep.note,
    }
  })

  // Include any other present types not in the graph as informational nodes.
  for (const [type, meta] of counts) {
    if (nodes.some((n) => n.resourceType === type)) continue
    nodes.push({
      resourceType: type,
      present: true,
      count: meta.count,
      regions: [...meta.regions].sort(),
      pairedWith: [],
      note: 'Present in workload inventory — include in region parity checks.',
    })
  }

  return nodes.sort((a, b) => Number(b.present) - Number(a.present) || b.count - a.count)
}

export function buildWhatIfPlan(input: {
  workloadItems: InventoryItem[]
  percent: number
  customerId: string
  quotas: Quota[]
  targetRegionId: string
  targetRegionLabel: string
}): WhatIfPlan {
  const pct = Math.max(5, Math.min(100, Math.round(input.percent)))
  const sourceItemCount = input.workloadItems.length
  const projectedItemCount = Math.max(1, Math.ceil((sourceItemCount * pct) / 100))
  let sourceVcpu = 0
  const familyCounts = new Map<string, number>()
  for (const item of input.workloadItems) {
    sourceVcpu += estimateVcpuFromSku(item.sku, item.size)
    const family = toSkuFamily(item.sku, item.size) || item.sku
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1)
  }
  const projectedVcpu = Math.max(1, Math.ceil((sourceVcpu * pct) / 100))
  const bySkuFamily = [...familyCounts.entries()]
    .map(([family, sourceCount]) => ({
      family,
      sourceCount,
      projectedCount: Math.max(1, Math.ceil((sourceCount * pct) / 100)),
    }))
    .sort((a, b) => b.projectedCount - a.projectedCount)
    .slice(0, 12)

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
    percent: pct,
    sourceItemCount,
    projectedItemCount,
    sourceVcpu,
    projectedVcpu,
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
