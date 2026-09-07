import type { CapacityCalendarEntry, CapacityCalendarEntryStatus } from '../types'

/** Normalize to YYYY-MM-DD for date-only comparisons. */
export function toDateKey(value: string | Date): string {
  if (value instanceof Date) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const raw = String(value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return toDateKey(parsed)
}

export function todayDateKey(now = new Date()) {
  return toDateKey(now)
}

export function isReliefDatePastDue(expectedReliefDate: string, now = new Date()) {
  const key = toDateKey(expectedReliefDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  return key < todayDateKey(now)
}

/** Effective status: Resolved stays; otherwise Past due when the relief date has passed. */
export function effectiveCalendarStatus(
  entry: Pick<CapacityCalendarEntry, 'status' | 'expectedReliefDate'>,
  now = new Date(),
): CapacityCalendarEntryStatus {
  if (entry.status === 'Resolved') return 'Resolved'
  if (isReliefDatePastDue(entry.expectedReliefDate, now)) return 'Past due'
  return 'Scheduled'
}

export function calendarEntryNeedsAutoDowngrade(
  entry: Pick<CapacityCalendarEntry, 'status' | 'expectedReliefDate' | 'severityDowngradedAt' | 'linkedConstraintIds'>,
  now = new Date(),
) {
  if (entry.severityDowngradedAt) return false
  if (!entry.linkedConstraintIds?.length) return false
  const status = effectiveCalendarStatus(entry, now)
  return status === 'Past due' || entry.status === 'Resolved'
}

export function monthMatrix(year: number, monthIndex: number) {
  const first = new Date(year, monthIndex, 1)
  const startOffset = (first.getDay() + 6) % 7 // Monday-first
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const cells: Array<{ dateKey: string; inMonth: boolean; day: number } | null> = []
  for (let i = 0; i < startOffset; i += 1) cells.push(null)
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    cells.push({ dateKey, inMonth: true, day })
  }
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: typeof cells[] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}
