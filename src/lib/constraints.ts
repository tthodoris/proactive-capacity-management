import type { CapacityConstraint, ImpactResult } from '../types'

export function getResolvedConstraintIds(constraints: CapacityConstraint[]) {
  return new Set(constraints.filter((c) => c.status === 'Resolved').map((c) => c.id))
}

export function filterActiveImpacts(impacts: ImpactResult[], constraints: CapacityConstraint[]) {
  const resolvedIds = getResolvedConstraintIds(constraints)
  return impacts.filter((impact) => !resolvedIds.has(impact.constraintId))
}
