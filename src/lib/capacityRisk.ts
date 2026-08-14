import { filterActiveImpacts } from './constraints'
import type {
  CapacityConstraint,
  ConstraintSeverity,
  Customer,
  ImpactResult,
  InventoryItem,
  Quota,
  Subscription,
} from '../types'

export type CapacityRiskLevel = 'Red' | 'Amber' | 'Green'

export type CapacityRiskWeightKey = 'constraints' | 'quotas' | 'sku'

export type CapacityRiskWeights = Record<CapacityRiskWeightKey, number>

/** Default share of the 0–100 score attributed to each scored factor. */
export const DEFAULT_CAPACITY_RISK_WEIGHTS: CapacityRiskWeights = {
  constraints: 40,
  quotas: 35,
  sku: 25,
}

/** Raw point caps used to normalize each factor to a 0–1 strength. */
export const CAPACITY_RISK_FACTOR_CAPS: CapacityRiskWeights = {
  constraints: 40,
  quotas: 30,
  /** Cap for SKU concentration strength; full SKU weight at this raw score. */
  sku: 25,
}

export const CAPACITY_RISK_WEIGHT_META: Array<{
  key: CapacityRiskWeightKey
  label: string
  description: string
  toneClass: string
}> = [
  {
    key: 'constraints',
    label: 'Open constraints',
    description: 'Active constraint exposure by severity',
    toneClass: 'tone-critical',
  },
  {
    key: 'quotas',
    label: 'Quota headroom',
    description: 'Peak usage / limit (Network Watchers, Storage Accounts, Total Regional vCPUs excluded)',
    toneClass: 'tone-high',
  },
  {
    key: 'sku',
    label: 'SKU concentration',
    description: 'Capacity-weighted concentration on a single SKU',
    toneClass: 'tone-2',
  },
]

const RISK_WEIGHTS_STORAGE_KEY = 'pcm.capacityRiskWeights'

export interface CapacityRiskFactor {
  id: string
  category: CapacityRiskWeightKey
  label: string
  detail: string
  points: number
  /** Unweighted raw points before weight share is applied. */
  rawPoints: number
}

/** Non-scoring advisories (region always; SKU when concentrated; some quotas). */
export interface CapacityRiskWarning {
  id: string
  category: 'region' | 'sku' | 'quota'
  label: string
  detail: string
  subscriptionName?: string | null
}

export interface ConcentrationSlice {
  label: string
  count: number
  sharePct: number
  /** Total capacity weight (e.g. sum of vCPUs). */
  capacityWeight: number
  /** Share of total capacity weight as %. */
  capacitySharePct: number
}

export interface QuotaRiskAction {
  quota: Quota
  usagePct: number
  /** Limit needed to bring usage to ~70% of capacity. */
  suggestedLimit: number
  increaseBy: number
  rationale: string
  priority: 'critical' | 'high' | 'medium'
}

export interface CustomerCapacityRisk {
  customerId: string
  /** Set when this score is scoped to a single subscription; null/omitted = customer rollup. */
  subscriptionId?: string | null
  subscriptionName?: string | null
  level: CapacityRiskLevel
  /** 0–100 composite score used for ranking within a RAG band. */
  score: number
  summary: string
  factors: CapacityRiskFactor[]
  warnings: CapacityRiskWarning[]
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

export const CAPACITY_RISK_RAG_THRESHOLDS = {
  red: 50,
  amber: 25,
} as const

export function adjustCapacityRiskWeight(
  _weights: CapacityRiskWeights,
  changed: CapacityRiskWeightKey,
  newValue: number,
): CapacityRiskWeights {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(newValue) || 0)))
  const others = (['constraints', 'quotas', 'sku'] as CapacityRiskWeightKey[]).filter(
    (k) => k !== changed,
  )
  const remaining = 100 - clamped
  const first = Math.floor(remaining / 2)
  const second = remaining - first
  const result: CapacityRiskWeights = {
    constraints: 0,
    quotas: 0,
    sku: 0,
  }
  result[changed] = clamped
  result[others[0]] = first
  result[others[1]] = second
  return result
}

export function normalizeCapacityRiskWeights(
  input?: Partial<CapacityRiskWeights> | null,
): CapacityRiskWeights {
  const next: CapacityRiskWeights = {
    constraints: Number(input?.constraints),
    quotas: Number(input?.quotas),
    sku: Number(input?.sku),
  }
  for (const key of Object.keys(DEFAULT_CAPACITY_RISK_WEIGHTS) as CapacityRiskWeightKey[]) {
    if (!Number.isFinite(next[key]) || next[key] < 0) {
      next[key] = DEFAULT_CAPACITY_RISK_WEIGHTS[key]
    }
  }
  const total = next.constraints + next.quotas + next.sku
  if (total <= 0) return { ...DEFAULT_CAPACITY_RISK_WEIGHTS }
  const scaled = {
    constraints: Math.round((next.constraints / total) * 100),
    quotas: Math.round((next.quotas / total) * 100),
    sku: Math.round((next.sku / total) * 100),
  }
  const drift = 100 - (scaled.constraints + scaled.quotas + scaled.sku)
  scaled.constraints += drift
  return scaled
}

export function capacityRiskWeightsEqual(a: CapacityRiskWeights, b: CapacityRiskWeights) {
  return (
    Math.abs(a.constraints - b.constraints) < 0.05 &&
    Math.abs(a.quotas - b.quotas) < 0.05 &&
    Math.abs(a.sku - b.sku) < 0.05
  )
}

export function loadCapacityRiskWeights(): CapacityRiskWeights {
  try {
    const raw = localStorage.getItem(RISK_WEIGHTS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CAPACITY_RISK_WEIGHTS }
    return normalizeCapacityRiskWeights(JSON.parse(raw) as Partial<CapacityRiskWeights>)
  } catch {
    return { ...DEFAULT_CAPACITY_RISK_WEIGHTS }
  }
}

export function saveCapacityRiskWeights(weights: CapacityRiskWeights) {
  const normalized = normalizeCapacityRiskWeights(weights)
  try {
    localStorage.setItem(RISK_WEIGHTS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Ignore quota / private-mode failures; in-memory weights still apply for the session.
  }
  return normalized
}

function weightedContribution(rawPoints: number, key: CapacityRiskWeightKey, weights: CapacityRiskWeights) {
  const strength = clamp(rawPoints / CAPACITY_RISK_FACTOR_CAPS[key], 0, 1)
  return Math.round(strength * weights[key] * 10) / 10
}

function quotaHaystack(q: Pick<Quota, 'name' | 'nameValue'>) {
  return `${q.name || ''} ${q.nameValue || ''}`.toLowerCase()
}

/** Azure Network Watcher quotas are nearly always saturated and not capacity-relevant. */
export function isNetworkWatcherQuota(q: Pick<Quota, 'name' | 'nameValue'>) {
  const hay = quotaHaystack(q)
  return hay.includes('network watcher') || hay.includes('networkwatcher')
}

/** Storage account count quotas — advisory only, not scored. */
export function isStorageAccountQuota(q: Pick<Quota, 'name' | 'nameValue'>) {
  const hay = quotaHaystack(q)
  return hay.includes('storage account') || hay.includes('storageaccounts')
}

/** Subscription-wide Total Regional vCPUs / cores — advisory only, not scored. */
export function isTotalRegionalVcpuQuota(q: Pick<Quota, 'name' | 'nameValue'>) {
  const name = String(q.name || '').toLowerCase()
  const nameValue = String(q.nameValue || '').toLowerCase()
  if (nameValue === 'cores') return true
  return /total\s+regional\s+(vcpus?|cores)/i.test(name)
}

/** Quotas that must not contribute to the scored quota-headroom factor. */
export function isQuotaExcludedFromScoring(q: Pick<Quota, 'name' | 'nameValue'>) {
  return isNetworkWatcherQuota(q) || isStorageAccountQuota(q) || isTotalRegionalVcpuQuota(q)
}

/**
 * Extract an approximate vCPU count from a VM SKU string.
 * Examples: Standard_D8s_v5 → 8, Standard_E64as_v5 → 64, GP_Gen5_8 → 8
 * Non-VM resources or unparseable SKUs return 1 (each resource counts equally).
 */
export function estimateVcpuFromSku(sku: string | undefined | null, size: string | undefined | null): number {
  const raw = String(sku || size || '').trim()
  if (!raw) return 1

  // Standard_D8s_v5, Standard_E64as_v5, Standard_NC24rs_v3, Standard_D2-1s_v5 etc.
  const vm = raw.match(/^Standard_[A-Za-z]+?(\d+)/i)
  if (vm) return Math.max(Number(vm[1]), 1)

  // GP_Gen5_8, BC_Gen5_4
  const gen = raw.match(/_Gen\d+_(\d+)$/i)
  if (gen) return Math.max(Number(gen[1]), 1)

  // Burstable4, GeneralPurpose8 etc.
  const tier = raw.match(/(?:Burstable|GeneralPurpose|MemoryOptimized|Premium)(\d+)/i)
  if (tier) return Math.max(Number(tier[1]), 1)

  return 1
}

/**
 * Region (and generic) concentration metrics by capacity-weighted share.
 * Does not assign score points — region is advisory only.
 */
function concentration(
  items: InventoryItem[],
  keyFn: (item: InventoryItem) => string,
) {
  if (items.length === 0) {
    return { label: null as string | null, sharePct: 0, elevated: false }
  }

  const buckets = new Map<string, number>()
  let totalWeight = 0
  for (const item of items) {
    const key = keyFn(item).trim() || 'Unknown'
    const w = estimateVcpuFromSku(item.sku, item.size)
    buckets.set(key, (buckets.get(key) || 0) + w)
    totalWeight += w
  }

  let topLabel = 'Unknown'
  let topWeight = 0
  for (const [label, weight] of buckets) {
    if (weight > topWeight) {
      topLabel = label
      topWeight = weight
    }
  }

  const sharePct = pct(topWeight, totalWeight)
  return { label: topLabel, sharePct, elevated: sharePct >= 25 }
}

/**
 * SKU concentration score (Excel column L):
 *   SUMSQ(skuShare_i) × √(total_vCPUs)
 * where skuShare_i = sku_vCPUs_i / total_vCPUs
 *
 * Combines HHI-style concentration with a volume (√vCPU) factor so tiny
 * fleets score low even when share looks concentrated.
 */
export function computeSkuConcentrationScore(items: InventoryItem[]) {
  if (items.length === 0) {
    return {
      label: null as string | null,
      sharePct: 0,
      sumSqShares: 0,
      totalVcpus: 0,
      points: 0,
      elevated: false,
    }
  }

  const buckets = new Map<string, number>()
  let totalVcpus = 0
  for (const item of items) {
    const key = (item.sku || item.size || item.resourceType || 'Unknown').trim() || 'Unknown'
    const w = estimateVcpuFromSku(item.sku, item.size)
    buckets.set(key, (buckets.get(key) || 0) + w)
    totalVcpus += w
  }

  let topLabel = 'Unknown'
  let topWeight = 0
  let sumSqShares = 0
  for (const [label, weight] of buckets) {
    if (weight > topWeight) {
      topLabel = label
      topWeight = weight
    }
    const share = totalVcpus > 0 ? weight / totalVcpus : 0
    sumSqShares += share * share
  }

  const sharePct = pct(topWeight, totalVcpus)
  // Column L: SUMSQ(shares) * SQRT(total vCPUs)
  const points = Math.round(sumSqShares * Math.sqrt(totalVcpus) * 1000) / 1000
  const elevated = sharePct >= 25 || points >= 5

  return {
    label: topLabel,
    sharePct,
    sumSqShares: Math.round(sumSqShares * 1e9) / 1e9,
    totalVcpus,
    points,
    elevated,
  }
}

function quotaHeadroom(quotas: Quota[]) {
  const usable = quotas.filter((q) => Number(q.limit) > 0 && !isQuotaExcludedFromScoring(q))
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

const ADVISORY_QUOTA_WARN_PCT = 60

function advisoryQuotaWarnings(
  quotas: Quota[],
  subscriptions?: Subscription[],
): CapacityRiskWarning[] {
  const warnings: CapacityRiskWarning[] = []
  for (const q of quotas) {
    if (isNetworkWatcherQuota(q)) continue
    const isStorage = isStorageAccountQuota(q)
    const isRegional = isTotalRegionalVcpuQuota(q)
    if (!isStorage && !isRegional) continue
    const limit = Number(q.limit)
    const usage = Number(q.usage)
    if (!(limit > 0) || !(usage >= 0)) continue
    const usagePct = pct(usage, limit)
    if (usagePct < ADVISORY_QUOTA_WARN_PCT) continue
    const kind = isStorage ? 'Storage Accounts' : 'Total Regional vCPUs'
    const region = q.region || 'unknown region'
    const subscriptionName = resolveSubscriptionName(q.subscriptionId, subscriptions, quotas)
    const scope = subscriptionName ? ` · ${subscriptionName}` : ''
    warnings.push({
      id: `quota-${q.id}`,
      category: 'quota',
      subscriptionName,
      label: `${kind} warning (${usagePct}% in ${region})${scope}`,
      detail: `${q.name || kind} is at ${usage} / ${limit} ${q.unit || ''} (${usagePct}%) — advisory only, not scored`.replace(
        /\s+/g,
        ' ',
      ).trim(),
    })
  }
  return warnings.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 8)
}

function constraintPressureForScope(
  customerId: string,
  subscriptionId: string | null,
  impacts: ImpactResult[],
  constraints: CapacityConstraint[],
) {
  let activeImpacts = filterActiveImpacts(impacts, constraints).filter(
    (i) => i.customerId === customerId,
  )
  if (subscriptionId) {
    activeImpacts = activeImpacts.filter((i) => i.subscriptionId === subscriptionId)
  }
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

function levelFromScore(score: number): CapacityRiskLevel {
  if (score >= CAPACITY_RISK_RAG_THRESHOLDS.red) return 'Red'
  if (score >= CAPACITY_RISK_RAG_THRESHOLDS.amber) return 'Amber'
  return 'Green'
}

function buildSummary(level: CapacityRiskLevel, factors: CapacityRiskFactor[]): string {
  const top = [...factors].sort((a, b) => b.points - a.points).slice(0, 2)
  if (top.length === 0) {
    return level === 'Green'
      ? 'No material capacity pressure from open constraints, quotas, or SKU concentration.'
      : 'Elevated capacity risk.'
  }
  return top.map((f) => f.label).join(' · ')
}

function filterInventoryForScope(
  inventory: InventoryItem[],
  customerId: string,
  subscriptionId: string | null,
) {
  return inventory.filter(
    (i) =>
      i.customerId === customerId &&
      (!subscriptionId || i.subscriptionId === subscriptionId),
  )
}

function filterQuotasForScope(
  quotas: Quota[],
  customerId: string,
  subscriptionId: string | null,
) {
  return quotas.filter(
    (q) =>
      q.customerId === customerId &&
      (!subscriptionId || q.subscriptionId === subscriptionId),
  )
}

function resolveSubscriptionName(
  subscriptionId: string | null | undefined,
  subscriptions: Subscription[] | undefined,
  quotas: Quota[],
): string | null {
  if (!subscriptionId) return null
  const named = subscriptions?.find((s) => s.id === subscriptionId)
  if (named?.name) return named.name
  const quota = quotas.find((q) => q.subscriptionId === subscriptionId)
  return quota?.subscriptionName || quota?.azureSubscriptionId || null
}

function pushConcentrationWarnings(input: {
  inventory: InventoryItem[]
  subscriptionId: string | null
  subscriptionName: string | null
  warnings: CapacityRiskWarning[]
}) {
  const skuPart = computeSkuConcentrationScore(input.inventory)
  const regionPart = concentration(input.inventory, (i) => i.region)
  const scope = input.subscriptionName
  const suffix = scope ? ` · ${scope}` : ''
  const scopeId = input.subscriptionId || 'customer'

  if (regionPart.elevated && regionPart.label) {
    input.warnings.push({
      id: `region-${scopeId}`,
      category: 'region',
      subscriptionName: scope,
      label: `Region concentration warning (${regionPart.sharePct}% in ${regionPart.label})${suffix}`,
      detail: `${regionPart.sharePct}% of capacity (vCPU-weighted) is in “${regionPart.label}” — advisory only, not scored`,
    })
  }

  if (skuPart.elevated && skuPart.label) {
    input.warnings.push({
      id: `sku-warning-${scopeId}`,
      category: 'sku',
      subscriptionName: scope,
      label: `SKU concentration warning (${skuPart.sharePct}% on ${skuPart.label})${suffix}`,
      detail:
        skuPart.points > 0
          ? `Top share ${skuPart.sharePct}% on “${skuPart.label}” (${skuPart.totalVcpus} vCPU)`
          : `${skuPart.sharePct}% of capacity is on “${skuPart.label}” — watch concentration even though score impact is low`,
    })
  }
}

function computeScopedCapacityRisk(input: {
  customerId: string
  subscriptionId?: string | null
  subscriptionName?: string | null
  subscriptions?: Subscription[]
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
  weights?: Partial<CapacityRiskWeights> | null
}): CustomerCapacityRisk {
  const {
    customerId,
    subscriptionId = null,
    subscriptionName = null,
    subscriptions,
    inventory,
    quotas,
    impacts,
    constraints,
  } = input
  const weights = normalizeCapacityRiskWeights(input.weights)
  const scopedInventory = filterInventoryForScope(inventory, customerId, subscriptionId)
  const scopedQuotas = filterQuotasForScope(quotas, customerId, subscriptionId)

  const constraintsPart = constraintPressureForScope(
    customerId,
    subscriptionId,
    impacts,
    constraints,
  )
  const quotasPart = quotaHeadroom(scopedQuotas)
  const skuPart = computeSkuConcentrationScore(scopedInventory)
  const regionPart = concentration(scopedInventory, (i) => i.region)

  const constraintContribution = weightedContribution(
    constraintsPart.points,
    'constraints',
    weights,
  )
  const quotaContribution = weightedContribution(quotasPart.points, 'quotas', weights)
  const skuContribution = weightedContribution(skuPart.points, 'sku', weights)

  const factors: CapacityRiskFactor[] = []
  const warnings: CapacityRiskWarning[] = []

  if (constraintsPart.openConstraintCount > 0) {
    const labels = constraintsPart.constraints
      .map((c) => `${c.sku} (${c.severity})`)
      .slice(0, 4)
    factors.push({
      id: 'constraints',
      category: 'constraints',
      label: `${constraintsPart.openConstraintCount} open constraint(s)`,
      detail: labels.join(', ') + (constraintsPart.constraints.length > 4 ? '…' : ''),
      points: constraintContribution,
      rawPoints: constraintsPart.points,
    })
  }

  if (quotasPart.maxPct != null && quotasPart.points > 0) {
    factors.push({
      id: 'quotas',
      category: 'quotas',
      label: `Quota headroom pressure (peak ${quotasPart.maxPct}%)`,
      detail:
        quotasPart.above80 > 0
          ? `${quotasPart.above80} quota line(s) at or above 80% used (Network Watchers, Storage Accounts, and Total Regional vCPUs excluded)`
          : `Highest usage/limit across collected quotas is ${quotasPart.maxPct}% (Network Watchers, Storage Accounts, and Total Regional vCPUs excluded)`,
      points: quotaContribution,
      rawPoints: quotasPart.points,
    })
  }

  if (skuPart.points > 0 && skuPart.label) {
    factors.push({
      id: 'sku',
      category: 'sku',
      label: `SKU concentration (score ${skuPart.points})`,
      detail: `Top ${skuPart.sharePct}% of capacity on “${skuPart.label}” · ${skuPart.totalVcpus} vCPU total`,
      points: skuContribution,
      rawPoints: skuPart.points,
    })
  }

  if (subscriptionId) {
    pushConcentrationWarnings({
      inventory: scopedInventory,
      subscriptionId,
      subscriptionName:
        subscriptionName ||
        resolveSubscriptionName(subscriptionId, subscriptions, scopedQuotas),
      warnings,
    })
  } else {
    const subIds = [
      ...new Set(
        scopedInventory
          .map((item) => item.subscriptionId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    if (subIds.length === 0) {
      pushConcentrationWarnings({
        inventory: scopedInventory,
        subscriptionId: null,
        subscriptionName: null,
        warnings,
      })
    } else {
      for (const subId of subIds) {
        pushConcentrationWarnings({
          inventory: scopedInventory.filter((item) => item.subscriptionId === subId),
          subscriptionId: subId,
          subscriptionName: resolveSubscriptionName(subId, subscriptions, scopedQuotas),
          warnings,
        })
      }
    }
  }

  warnings.push(...advisoryQuotaWarnings(scopedQuotas, subscriptions))

  const score = clamp(
    Math.round(constraintContribution + quotaContribution + skuContribution),
    0,
    100,
  )
  const level = levelFromScore(score)

  return {
    customerId,
    subscriptionId: subscriptionId ?? null,
    subscriptionName: subscriptionName ?? null,
    level,
    score,
    summary: buildSummary(level, factors),
    factors: factors.sort((a, b) => b.points - a.points),
    warnings,
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
      inventoryCount: scopedInventory.length,
    },
  }
}

/**
 * Compute a RAG capacity risk score for one customer (rollup across subscriptions).
 */
export function computeCustomerCapacityRisk(input: {
  customer: Customer
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
  weights?: Partial<CapacityRiskWeights> | null
  subscriptions?: Subscription[]
}): CustomerCapacityRisk {
  return computeScopedCapacityRisk({
    customerId: input.customer.id,
    subscriptionId: null,
    subscriptionName: null,
    subscriptions: input.subscriptions,
    inventory: input.inventory,
    quotas: input.quotas,
    impacts: input.impacts,
    constraints: input.constraints,
    weights: input.weights,
  })
}

/** Compute risk for a single subscription under a customer. */
export function computeSubscriptionCapacityRisk(input: {
  customer: Customer
  subscription: Subscription
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
  weights?: Partial<CapacityRiskWeights> | null
}): CustomerCapacityRisk {
  return computeScopedCapacityRisk({
    customerId: input.customer.id,
    subscriptionId: input.subscription.id,
    subscriptionName: input.subscription.name,
    subscriptions: [input.subscription],
    inventory: input.inventory,
    quotas: input.quotas,
    impacts: input.impacts,
    constraints: input.constraints,
    weights: input.weights,
  })
}

/** All subscription-level risks for one customer. */
export function computeCustomerSubscriptionRisks(input: {
  customer: Customer
  subscriptions: Subscription[]
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
  weights?: Partial<CapacityRiskWeights> | null
}): CustomerCapacityRisk[] {
  const subs = input.subscriptions.filter((s) => s.customerId === input.customer.id)
  return subs.map((subscription) =>
    computeSubscriptionCapacityRisk({
      customer: input.customer,
      subscription,
      inventory: input.inventory,
      quotas: input.quotas,
      impacts: input.impacts,
      constraints: input.constraints,
      weights: input.weights,
    }),
  )
}

export function computePortfolioCapacityRisks(input: {
  customers: Customer[]
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
  weights?: Partial<CapacityRiskWeights> | null
  subscriptions?: Subscription[]
}): CustomerCapacityRisk[] {
  return input.customers.map((customer) =>
    computeCustomerCapacityRisk({
      customer,
      inventory: input.inventory,
      quotas: input.quotas,
      impacts: input.impacts,
      constraints: input.constraints,
      weights: input.weights,
      subscriptions: input.subscriptions?.filter((s) => s.customerId === customer.id),
    }),
  )
}

export function computePortfolioSubscriptionRisks(input: {
  customers: Customer[]
  subscriptions: Subscription[]
  inventory: InventoryItem[]
  quotas: Quota[]
  impacts: ImpactResult[]
  constraints: CapacityConstraint[]
  weights?: Partial<CapacityRiskWeights> | null
}): CustomerCapacityRisk[] {
  const customerById = new Map(input.customers.map((c) => [c.id, c]))
  return input.subscriptions
    .filter((s) => customerById.has(s.customerId))
    .map((subscription) => {
      const customer = customerById.get(subscription.customerId)!
      return computeSubscriptionCapacityRisk({
        customer,
        subscription,
        inventory: input.inventory,
        quotas: input.quotas,
        impacts: input.impacts,
        constraints: input.constraints,
        weights: input.weights,
      })
    })
}

export function riskScopeKey(risk: Pick<CustomerCapacityRisk, 'customerId' | 'subscriptionId'>) {
  return risk.subscriptionId
    ? `${risk.customerId}:${risk.subscriptionId}`
    : risk.customerId
}

export function isSubscriptionRisk(risk: CustomerCapacityRisk) {
  return Boolean(risk.subscriptionId)
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

function concentrationSlices(
  items: InventoryItem[],
  keyFn: (item: InventoryItem) => string,
  limit = 8,
): ConcentrationSlice[] {
  if (items.length === 0) return []
  const buckets = new Map<string, { count: number; weight: number }>()
  let totalWeight = 0
  for (const item of items) {
    const key = keyFn(item).trim() || 'Unknown'
    const w = estimateVcpuFromSku(item.sku, item.size)
    const existing = buckets.get(key) || { count: 0, weight: 0 }
    existing.count += 1
    existing.weight += w
    buckets.set(key, existing)
    totalWeight += w
  }
  return [...buckets.entries()]
    .map(([label, data]) => ({
      label,
      count: data.count,
      sharePct: pct(data.count, items.length),
      capacityWeight: data.weight,
      capacitySharePct: pct(data.weight, totalWeight),
    }))
    .sort((a, b) => b.capacityWeight - a.capacityWeight || a.label.localeCompare(b.label))
    .slice(0, limit)
}

/** Inventory share by SKU / size / type for charts (top 10 by capacity). */
export function getSkuConcentrationSlices(
  inventory: InventoryItem[],
  customerId: string,
  subscriptionId?: string | null,
) {
  return concentrationSlices(
    filterInventoryForScope(inventory, customerId, subscriptionId ?? null),
    (i) => i.sku || i.size || i.resourceType,
    10,
  )
}

/** Inventory share by region for charts. */
export function getRegionConcentrationSlices(
  inventory: InventoryItem[],
  customerId: string,
  subscriptionId?: string | null,
) {
  return concentrationSlices(
    filterInventoryForScope(inventory, customerId, subscriptionId ?? null),
    (i) => i.region,
  )
}

/**
 * Quotas that should be increased to reduce headroom pressure.
 * Excludes Network Watchers, Storage Accounts, and Total Regional vCPUs.
 * Target: bring usage to ~70% of limit.
 */
export function getQuotaActionsToReduceRisk(
  quotas: Quota[],
  customerId: string,
  options?: {
    subscriptionId?: string | null
    minUsagePct?: number
    targetUsagePct?: number
    limit?: number
  },
): QuotaRiskAction[] {
  const minUsagePct = options?.minUsagePct ?? 60
  const targetUsagePct = options?.targetUsagePct ?? 70
  const maxRows = options?.limit ?? 25
  const subscriptionId = options?.subscriptionId ?? null
  const targetRatio = targetUsagePct / 100

  const actions: QuotaRiskAction[] = []
  for (const quota of quotas) {
    if (quota.customerId !== customerId) continue
    if (subscriptionId && quota.subscriptionId !== subscriptionId) continue
    if (isQuotaExcludedFromScoring(quota)) continue
    const limit = Number(quota.limit)
    const usage = Number(quota.usage)
    if (!(limit > 0) || !(usage >= 0)) continue
    const usagePct = Math.round((usage / limit) * 1000) / 10
    if (usagePct < minUsagePct) continue

    const suggestedLimit = Math.max(limit, Math.ceil(usage / targetRatio))
    const increaseBy = suggestedLimit - limit
    let priority: QuotaRiskAction['priority'] = 'medium'
    if (usagePct >= 95) priority = 'critical'
    else if (usagePct >= 80) priority = 'high'

    actions.push({
      quota,
      usagePct,
      suggestedLimit,
      increaseBy,
      priority,
      rationale:
        increaseBy > 0
          ? `Raise limit from ${limit} to at least ${suggestedLimit} ${quota.unit || ''} so current usage (${usage}) sits near ${targetUsagePct}% of capacity.`
              .replace(/\s+/g, ' ')
              .trim()
          : `Usage is already near the ${targetUsagePct}% target; keep monitoring.`,
    })
  }

  return actions
    .sort((a, b) => {
      const p = { critical: 0, high: 1, medium: 2 }
      const pd = p[a.priority] - p[b.priority]
      if (pd !== 0) return pd
      return b.usagePct - a.usagePct
    })
    .slice(0, maxRows)
}

/** Open constraints contributing to scoped risk. */
export function getOpenConstraintsForScope(
  customerId: string,
  subscriptionId: string | null,
  impacts: ImpactResult[],
  constraints: CapacityConstraint[],
) {
  return constraintPressureForScope(customerId, subscriptionId, impacts, constraints).constraints.sort(
    (a, b) => {
      const order: Record<ConstraintSeverity, number> = {
        Critical: 0,
        High: 1,
        Medium: 2,
        Low: 3,
      }
      return order[a.severity] - order[b.severity] || a.sku.localeCompare(b.sku)
    },
  )
}

/** Open constraints contributing to the customer's scored risk. */
export function getOpenConstraintsForCustomer(
  customerId: string,
  impacts: ImpactResult[],
  constraints: CapacityConstraint[],
) {
  return getOpenConstraintsForScope(customerId, null, impacts, constraints)
}
