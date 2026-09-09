import type { CapacityConstraint, ConstraintSeverity, ImpactResult } from '../types'
import { normalizeRegionKey } from './regionCost'
import { toSkuFamily } from './skuFamily'

const SEVERITY_RANK: Record<ConstraintSeverity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
}

const SEVERITY_DOWNGRADE: Record<ConstraintSeverity, ConstraintSeverity> = {
  Critical: 'High',
  High: 'Medium',
  Medium: 'Low',
  Low: 'Low',
}

export function downgradeConstraintSeverity(severity: ConstraintSeverity): ConstraintSeverity {
  return SEVERITY_DOWNGRADE[severity] ?? severity
}

export function canDowngradeSeverity(severity: ConstraintSeverity) {
  return severity !== 'Low'
}

export function getResolvedConstraintIds(constraints: CapacityConstraint[]) {
  return new Set(constraints.filter((c) => c.status === 'Resolved').map((c) => c.id))
}

export function isResolvedConstraint(constraint: CapacityConstraint) {
  return constraint.status === 'Resolved'
}

/** Constraints shown on the dashboard and Constraints list (same set). */
export function filterListableConstraints(
  constraints: CapacityConstraint[],
  options?: { includeResolved?: boolean },
) {
  const includeResolved = Boolean(options?.includeResolved)
  return constraints.filter((constraint) => includeResolved || !isResolvedConstraint(constraint))
}

export function sortConstraintsForDashboard(constraints: CapacityConstraint[]) {
  return [...constraints].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (severity !== 0) return severity
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  })
}

export function filterActiveImpacts(impacts: ImpactResult[], constraints: CapacityConstraint[]) {
  const resolvedIds = getResolvedConstraintIds(constraints)
  return impacts.filter((impact) => !resolvedIds.has(impact.constraintId))
}

function skuMatchesConstraint(
  constraintSku: string,
  rowSku: string,
  rowSize?: string | null,
  rowFamily?: string | null,
) {
  const cSku = String(constraintSku || '').trim().toLowerCase()
  const sku = String(rowSku || '').trim().toLowerCase()
  const size = String(rowSize || '').trim().toLowerCase()
  if (!cSku) return false
  if (cSku === sku || (size && cSku === size)) return true

  const constraintFamily = toSkuFamily(constraintSku).toLowerCase()
  const rowFamilies = [toSkuFamily(rowSku, rowSize), rowFamily || '', toSkuFamily(rowSize)]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean)

  return Boolean(constraintFamily && rowFamilies.some((f) => f === constraintFamily))
}

function regionMatchesConstraint(
  constraintRegions: string[],
  targetRegionId?: string | null,
  targetRegionLabel?: string | null,
) {
  if (!constraintRegions?.length) return false
  const targets = [targetRegionId, targetRegionLabel]
    .map((v) => normalizeRegionKey(String(v || '')))
    .filter(Boolean)
  if (targets.length === 0) return false
  return constraintRegions.some((region) => {
    const key = normalizeRegionKey(region)
    return Boolean(key && targets.includes(key))
  })
}

/** Open constraints that apply to a region-evaluation SKU/service in a target region. */
export function findMatchingConstraintsForEval(input: {
  constraints: CapacityConstraint[]
  resourceType: string
  sku: string
  size?: string | null
  family?: string | null
  targetRegionId?: string | null
  targetRegionLabel?: string | null
  includeResolved?: boolean
}) {
  const open = filterListableConstraints(input.constraints, {
    includeResolved: input.includeResolved,
  })
  return sortConstraintsForDashboard(
    open.filter((constraint) => {
      if (constraint.resourceType !== input.resourceType) return false
      if (!skuMatchesConstraint(constraint.sku, input.sku, input.size, input.family)) {
        return false
      }
      return regionMatchesConstraint(
        constraint.regions || [],
        input.targetRegionId,
        input.targetRegionLabel,
      )
    }),
  )
}
