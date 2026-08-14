import type { CapacityConstraint, ConstraintSeverity, ImpactResult } from '../types'

const SEVERITY_RANK: Record<ConstraintSeverity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
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
