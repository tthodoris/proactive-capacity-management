import { formatDistanceToNow, parseISO } from 'date-fns'

export function formatRelative(iso: string) {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true })
  } catch {
    return iso
  }
}

export function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(parseISO(iso))
  } catch {
    return iso
  }
}

/** Whole hours elapsed since `iso` (floored). Returns null if unparseable. */
export function hoursSince(iso: string): number | null {
  try {
    const ms = Date.now() - parseISO(iso).getTime()
    if (Number.isNaN(ms) || ms < 0) return 0
    return Math.floor(ms / (1000 * 60 * 60))
  } catch {
    return null
  }
}

export function formatHoursAgo(iso: string): string {
  const hours = hoursSince(iso)
  if (hours == null) return 'unknown'
  if (hours < 1) return 'less than 1 hour ago'
  if (hours === 1) return '1 hour ago'
  return `${hours} hours ago`
}

/** True when the timestamp is within the last `days` days. */
export function isWithinDays(iso: string, days: number): boolean {
  try {
    const ms = Date.now() - parseISO(iso).getTime()
    if (Number.isNaN(ms) || ms < 0) return true
    return ms < days * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

export function maxIsoDate(dates: Array<string | undefined | null>): string | null {
  let best: string | null = null
  let bestMs = -Infinity
  for (const value of dates) {
    if (!value) continue
    try {
      const ms = parseISO(value).getTime()
      if (Number.isNaN(ms)) continue
      if (ms > bestMs) {
        bestMs = ms
        best = value
      }
    } catch {
      /* ignore */
    }
  }
  return best
}

export function usageTone(usage: number, limit: number) {
  const pct = usage / limit
  if (pct >= 0.9) return 'danger'
  if (pct >= 0.75) return 'warn'
  return ''
}

const REGION_LABELS: Record<string, string> = {
  westeurope: 'West Europe',
  northeurope: 'North Europe',
  francecentral: 'France Central',
  swedencentral: 'Sweden Central',
  uksouth: 'UK South',
  ukwest: 'UK West',
  eastus: 'East US',
  eastus2: 'East US 2',
  westus: 'West US',
  westus2: 'West US 2',
  westus3: 'West US 3',
  centralus: 'Central US',
  southcentralus: 'South Central US',
  northcentralus: 'North Central US',
  canadacentral: 'Canada Central',
  canadaeast: 'Canada East',
  germanywestcentral: 'Germany West Central',
  switzerlandnorth: 'Switzerland North',
  norwayeast: 'Norway East',
  polandcentral: 'Poland Central',
  italynorth: 'Italy North',
  spaincentral: 'Spain Central',
  australiaeast: 'Australia East',
  southeastasia: 'Southeast Asia',
  eastasia: 'East Asia',
  japaneast: 'Japan East',
  japanwest: 'Japan West',
  koreacentral: 'Korea Central',
  brazilsouth: 'Brazil South',
  uaenorth: 'UAE North',
  southafricanorth: 'South Africa North',
}

export function prettyRegion(location: string) {
  if (!location) return location
  const known = REGION_LABELS[location.toLowerCase()]
  if (known) return known
  return location
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
}
