import type { RegionEvalRegionResult, RegionEvalRow } from './azureApi'

export function formatRegionMoney(
  amount: number | null | undefined,
  currencyCode?: string | null,
) {
  if (amount == null || !Number.isFinite(amount)) return null
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode || 'USD',
      maximumFractionDigits: amount < 1 ? 4 : 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(4)} ${currencyCode || 'USD'}`
  }
}

export function shortUnitLabel(unitOfMeasure?: string | null) {
  const unit = String(unitOfMeasure || '').toLowerCase()
  if (unit.includes('hour')) return '/hr'
  if (unit.includes('month')) return '/mo'
  if (unit.includes('day')) return '/day'
  if (unitOfMeasure) return `/${unitOfMeasure.replace(/^1\s*/i, '')}`
  return ''
}

export function regionCostSummary(cell: RegionEvalRegionResult | undefined) {
  if (!cell) return '—'
  const unit = formatRegionMoney(cell.unitPrice, cell.currencyCode)
  if (!unit) return cell.costNote || 'Price n/a'
  const monthly = formatRegionMoney(cell.monthlyUnitPrice, cell.currencyCode)
  if (monthly) return `${unit}${shortUnitLabel(cell.unitOfMeasure)} · ${monthly}/mo`
  return `${unit}${shortUnitLabel(cell.unitOfMeasure)}`
}

export function normalizeRegionKey(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Resolve a source inventory region label to a bySourceRegion cell. */
export function findSourceCostCell(row: RegionEvalRow, sourceRegionLabel: string) {
  const bySource = row.bySourceRegion || {}
  const direct = bySource[sourceRegionLabel]
  if (direct) return { regionId: sourceRegionLabel, cell: direct }

  const want = normalizeRegionKey(sourceRegionLabel)
  for (const [id, cell] of Object.entries(bySource)) {
    const label = cell.label || id
    if (normalizeRegionKey(id) === want || normalizeRegionKey(label) === want) {
      return { regionId: id, cell }
    }
  }
  for (const meta of row.sourceRegionMeta || []) {
    if (normalizeRegionKey(meta.id) === want || normalizeRegionKey(meta.label) === want) {
      return { regionId: meta.id, cell: bySource[meta.id] }
    }
  }
  return null
}

export function sumMonthly(
  values: Array<number | null | undefined>,
): number | null {
  let total = 0
  let any = false
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue
    total += value
    any = true
  }
  return any ? total : null
}
