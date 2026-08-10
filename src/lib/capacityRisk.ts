import { filterActiveImpacts } from './constraints'
import type {
  CapacityConstraint,
  ConstraintSeverity,
  Customer,
  ImpactResult,
  InventoryItem,
  Quota,
} from '../types'

export type CapacityRiskLevel = 'Red' | 'Amber' | 'Green'

export interface CapacityRiskFactor {
  id: string
  category: 'constraints' | 'quotas' | 'sku' | 'region'
  label: string
  detail: string
  points: number
}

export interface CustomerCapacityRisk {
  customerId: string
  level: CapacityRiskLevel
  /** 0–100 composite score used for ranking within a RAG band. */
  score: number
  summary: string
  factors: CapacityRiskFactor[]
  metrics: {
    openConstraintCount: number
    criticalConstraintCount: number
    highConstraintCount: number
    maxQuotaUsagePct: number | null
    quotasAbove80: number
    topSkuSharePct: number
    topSkuLabel: string | null
    topRegionSharePct: number
    topRegionLabel: string | null
    inventoryCount: number
  }
}

const SEVERITY_POINTS: Record<ConstraintSeverity, number> = {
  Critical: 12,
  High: 8,
  Medium: 4,
  Low: 2,
}

const LEVEL_RANK: Record<CapacityRiskLevel, number> = {
  Red: 0,
  Amber: 1,
  Green: 2,
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function pct(part: number, whole: number) {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 1000) / 10
}

function concentration(items: InventoryItem[], keyFn: (item: InventoryItem) => string) {
  if (items.length === 0) {
    return { label: null as string | null, sharePct: 0, points: 0 }
  }
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = keyFn(item).trim() || 'Unknown'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let topLabel = 'Unknown'
  let topCount = 0
  for (const [label, count] of counts) {
    if (count > topCount) {
      topLabel = label
      topCount = count
    }
  }
  const sharePct = pct(topCount, items.length)
  let points = 0
  if (sharePct >= 50) points = 15
  else if (sharePct >= 35) points = 10
  else if (sharePct >= 25) points = 5
  return { label: topLabel, sharePct, points }
}

function quotaHeadroom(quotas: Quota[]) {
  const usable = quotas.filter((q) => Number(q.limit) > 0)
  if (usable.length === 0) {
    return { maxPct: null as number | null, above80: 0, points: 0 }
  }
  let maxPct = 0
  let above80 = 0
  for (const q of usable) {
    const ratio = (Number(q.usage) / Number(q.limit)) * 100
    if (ratio > maxPct) maxPct = ratio
    if (ratio >= 80) above80 += 1
  }
  maxPct = Math.round(maxPct * 10) / 10
  let points = 0
  if (maxPct >= 95) points = 30
  else if (maxPct >= 85) points = 22
  else if (maxPct >= 75) points = 14
  else if (maxPct >= 60) points = 8
  if (above80 >= 3) points = Math.min(30, points + 4)
  return { maxPct, above80, points }
}

function constraintPressure(
  customerId: string,
  impacts: ImpactResult[],
  constraints: CapacityConstraint[],
) {
  const activeImpacts = filterActiveImpacts(impacts, constraints).filter(
    (i) => i.customerId === customerId,
  )
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  const touched = new Map<string, CapacityConstraint>()
  for (const impact of activeImpacts) {
    const c = constraintById.get(impact.constraintId)
    if (c && c.status !== 'Resolved') touched.set(c.id, c)
  }
  const list = [...touched.values()]
  let points = 0
  let critical = 0
  let high = 0
  for (const c of list) {
    points += SEVERITY_POINTS[c.severity] || 2
    if (c.severity === 'Critical') critical += 1
    if (c.severity === 'High') high += 1
  }
  points = clamp(points, 0, 40)
  return {
    constraints: list,
    openConstraintCount: list.length,
    criticalConstraintCount: critical,
    highConstraintCount: high,
    points,
  }
}

function levelFromScore(
  score: number,
  criticalConstraintCount: number,
  highConstraintCount: number,
  maxQuotaUsagePct: number | null,
): CapacityRiskLevel {
  if (criticalConstraintCount > 0 || (maxQuotaUsagePct != null && maxQuotaUsagePct >= 95) || score >= 60) {
    return 'Red'
  }
  if (
    highConstraintCount > 0 ||
    (maxQuotaUsagePct != null && maxQuotaUsagePct >= 80) ||
    score >= 30
  ) {
    return 'Amber'
  }
  return 'Green'
}

function buildSummary(level: CapacityRiskLevel, factors: CapacityRiskFactor[]): string {
  const top = [...factors].sort((a, b) => b.points - a.points).slice(0, 2)
  if (top.length === 0) {
    return level === 'Green'
      ? 'No material capacity pressure from open constraints, quotas, or concentration.'
      : 'Elevated capacity risk.'
  }
  return top.map((f) => f.label).join(' · ')
}

/**
 * Compute a RAG capacity risk score for one customer.
 */
export function computeCustomerCapacityRisk(input: {
  customer: Customer
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
}): CustomerCapacityRisk {
  const { customer, inventory, quotas, impacts, constraints } = input
  const customerInventory = inventory.filter((i) => i.customerId === customer.id)
  const customerQuotas = quotas.filter((q) => q.customerId === customer.id)

  const constraintsPart = constraintPressure(customer.id, impacts, constraints)
  const quotasPart = quotaHeadroom(customerQuotas)
  const skuPart = concentration(customerInventory, (i) => i.sku || i.size || i.resourceType)
  const regionPart = concentration(customerInventory, (i) => i.region)

  const factors: CapacityRiskFactor[] = []

  if (constraintsPart.openConstraintCount > 0) {
    const labels = constraintsPart.constraints
      .map((c) => `${c.sku} (${c.severity})`)
      .slice(0, 4)
    factors.push({
      id: 'constraints',
      category: 'constraints',
      label: `${constraintsPart.openConstraintCount} open constraint(s)`,
      detail: labels.join(', ') + (constraintsPart.constraints.length > 4 ? '…' : ''),
      points: constraintsPart.points,
    })
  }

  if (quotasPart.maxPct != null && quotasPart.points > 0) {
    factors.push({
      id: 'quotas',
      category: 'quotas',
      label: `Quota headroom pressure (peak ${quotasPart.maxPct}%)`,
      detail:
        quotasPart.above80 > 0
          ? `${quotasPart.above80} quota line(s) at or above 80% used`
          : `Highest usage/limit across collected quotas is ${quotasPart.maxPct}%`,
      points: quotasPart.points,
    })
  }

  if (skuPart.points > 0 && skuPart.label) {
    factors.push({
      id: 'sku',
      category: 'sku',
      label: `SKU concentration (${skuPart.sharePct}% on ${skuPart.label})`,
      detail: `${skuPart.sharePct}% of inventory shares SKU/family “${skuPart.label}”`,
      points: skuPart.points,
    })
  }

  if (regionPart.points > 0 && regionPart.label) {
    factors.push({
      id: 'region',
      category: 'region',
      label: `Region concentration (${regionPart.sharePct}% in ${regionPart.label})`,
      detail: `${regionPart.sharePct}% of inventory is in “${regionPart.label}”`,
      points: regionPart.points,
    })
  }

  const score = clamp(
    constraintsPart.points + quotasPart.points + skuPart.points + regionPart.points,
    0,
    100,
  )
  const level = levelFromScore(
    score,
    constraintsPart.criticalConstraintCount,
    constraintsPart.highConstraintCount,
    quotasPart.maxPct,
  )

  return {
    customerId: customer.id,
    level,
    score,
    summary: buildSummary(level, factors),
    factors: factors.sort((a, b) => b.points - a.points),
    metrics: {
      openConstraintCount: constraintsPart.openConstraintCount,
      criticalConstraintCount: constraintsPart.criticalConstraintCount,
      highConstraintCount: constraintsPart.highConstraintCount,
      maxQuotaUsagePct: quotasPart.maxPct,
      quotasAbove80: quotasPart.above80,
      topSkuSharePct: skuPart.sharePct,
      topSkuLabel: skuPart.label,
      topRegionSharePct: regionPart.sharePct,
      topRegionLabel: regionPart.label,
      inventoryCount: customerInventory.length,
    },
  }
}

export function computePortfolioCapacityRisks(input: {
  customers: Customer[]
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
}): CustomerCapacityRisk[] {
  return input.customers.map((customer) =>
    computeCustomerCapacityRisk({
      customer,
      inventory: input.inventory,
      quotas: input.quotas,
      impacts: input.impacts,
      constraints: input.constraints,
    }),
  )
}

export function sortRisksForTriage(risks: CustomerCapacityRisk[]) {
  return [...risks].sort((a, b) => {
    const levelDiff = LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    if (levelDiff !== 0) return levelDiff
    return b.score - a.score
  })
}

export function riskLevelPillClass(level: CapacityRiskLevel) {
  switch (level) {
    case 'Red':
      return 'pill pill-critical'
    case 'Amber':
      return 'pill pill-high'
    default:
      return 'pill pill-ok'
  }
}
