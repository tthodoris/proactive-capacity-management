import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { SeverityBadge, StatusBadge } from '../components/Badges'
import { useApp } from '../context/AppContext'
import { azureRegions } from '../data/mockData'
import {
  effectiveCalendarStatus,
  monthMatrix,
  toDateKey,
  todayDateKey,
} from '../lib/capacityCalendar'
import { filterListableConstraints } from '../lib/constraints'
import {
  fetchInventoryResourceTypes,
  fetchInventorySkus,
  type InventorySkuOption,
} from '../lib/dataApi'
import { formatDate, prettyRegion } from '../lib/format'
import type {
  CapacityCalendarEntry,
  CapacityConstraint,
  ConstraintSeverity,
  ConstraintStatus,
  ResourceType,
} from '../types'

const FALLBACK_RESOURCE_TYPES: ResourceType[] = [
  'Virtual Machine',
  'Azure SQL Database',
  'Azure SQL Managed Instance',
  'Azure Database for MySQL',
  'Azure Database for PostgreSQL',
  'Azure Cosmos DB',
  'Azure Kubernetes Service',
  'Container Instances',
  'Azure Container Apps',
  'Azure Container Apps Environment',
  'Azure Databricks',
  'Azure Data Explorer',
  'Azure Cache for Redis',
  'Azure Managed Redis',
  'Key Vault',
  'Storage Account',
  'Application Gateway',
  'API Management',
  'VPN Gateway',
]

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const SEVERITY_OPTIONS: ConstraintSeverity[] = ['Critical', 'High', 'Medium', 'Low']
const STATUS_OPTIONS: ConstraintStatus[] = [
  'Open',
  'Under investigation',
  'Mitigating',
  'Resolved',
]

/** Form sentinel: keep default one-level severity downgrade. */
const TARGET_SEVERITY_DEFAULT = '__default__'
/** Form sentinel: do not change linked constraint status. */
const TARGET_STATUS_UNCHANGED = '__unchanged__'

function statusTone(status: CapacityCalendarEntry['status']) {
  if (status === 'Resolved') return 'ok'
  if (status === 'Past due') return 'critical'
  return 'medium'
}

export function CapacityCalendarPage() {
  const {
    capacityCalendarEntries,
    constraints,
    createCapacityCalendarEntry,
    resolveCapacityCalendarEntry,
    deleteCapacityCalendarEntryById,
  } = useApp()

  const today = todayDateKey()
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })
  const [selectedDate, setSelectedDate] = useState(today)
  const [showForm, setShowForm] = useState(false)

  const [resourceTypes, setResourceTypes] = useState<string[]>(FALLBACK_RESOURCE_TYPES)
  const [skuOptions, setSkuOptions] = useState<InventorySkuOption[]>([])
  const [resourceType, setResourceType] = useState('Virtual Machine')
  const [sku, setSku] = useState('')
  const [region, setRegion] = useState('')
  const [expectedReliefDate, setExpectedReliefDate] = useState(today)
  const [notes, setNotes] = useState('')
  const [source, setSource] = useState('Weekly Capacity call')
  const [linkedConstraintIds, setLinkedConstraintIds] = useState<string[]>([])
  const [targetSeverityChoice, setTargetSeverityChoice] = useState(TARGET_SEVERITY_DEFAULT)
  const [targetStatusChoice, setTargetStatusChoice] = useState(TARGET_STATUS_UNCHANGED)
  const [loadingTypes, setLoadingTypes] = useState(true)
  const [loadingSkus, setLoadingSkus] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingSkuRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingTypes(true)
      try {
        const data = await fetchInventoryResourceTypes()
        if (cancelled) return
        const fromDb = data.resourceTypes.map((t) => t.resourceType)
        const types = [...new Set([...FALLBACK_RESOURCE_TYPES, ...fromDb])].sort((a, b) =>
          a.localeCompare(b),
        )
        if (types.length > 0) {
          setResourceTypes(types)
          setResourceType((prev) => (types.includes(prev) ? prev : types[0]))
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoadingTypes(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!resourceType) return
      setLoadingSkus(true)
      try {
        const data = await fetchInventorySkus(resourceType)
        if (cancelled) return
        setSkuOptions(data.skus)
        setSku((prev) => {
          const preferred = pendingSkuRef.current
          if (preferred && data.skus.some((s) => s.sku === preferred)) {
            pendingSkuRef.current = null
            return preferred
          }
          if (data.skus.some((s) => s.sku === prev)) return prev
          if (preferred) {
            // Keep constraint SKU even if not in inventory options yet.
            pendingSkuRef.current = null
            return preferred
          }
          return data.skus[0]?.sku ?? ''
        })
      } catch (err) {
        if (!cancelled) {
          setSkuOptions([])
          const preferred = pendingSkuRef.current
          pendingSkuRef.current = null
          setSku(preferred || '')
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoadingSkus(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resourceType])

  const weeks = useMemo(
    () => monthMatrix(cursor.year, cursor.month),
    [cursor.year, cursor.month],
  )

  const entriesByDate = useMemo(() => {
    const map = new Map<string, CapacityCalendarEntry[]>()
    for (const entry of capacityCalendarEntries) {
      const key = toDateKey(entry.expectedReliefDate)
      const list = map.get(key) || []
      list.push(entry)
      map.set(key, list)
    }
    return map
  }, [capacityCalendarEntries])

  const selectedEntries = useMemo(() => {
    return (entriesByDate.get(selectedDate) || []).slice().sort((a, b) =>
      a.sku.localeCompare(b.sku),
    )
  }, [entriesByDate, selectedDate])

  const upcoming = useMemo(() => {
    return capacityCalendarEntries
      .map((entry) => ({ ...entry, status: effectiveCalendarStatus(entry) }))
      .sort((a, b) => a.expectedReliefDate.localeCompare(b.expectedReliefDate))
  }, [capacityCalendarEntries])

  const selectedSku = useMemo(
    () => skuOptions.find((option) => option.sku === sku) ?? null,
    [skuOptions, sku],
  )

  const linkedConstraints = useMemo(
    () => constraints.filter((c) => linkedConstraintIds.includes(c.id)),
    [constraints, linkedConstraintIds],
  )

  const regionChoices = useMemo(() => {
    const merged: string[] = []
    const push = (value: string | undefined | null) => {
      const v = String(value || '').trim()
      if (!v || merged.includes(v)) return
      merged.push(v)
    }
    for (const c of linkedConstraints) {
      for (const r of c.regions || []) push(r)
    }
    for (const r of selectedSku?.regions || []) push(r)
    for (const r of azureRegions) push(r)
    if (region) push(region)
    return merged
  }, [linkedConstraints, selectedSku, region])

  useEffect(() => {
    if (!region && regionChoices.length > 0) {
      setRegion(regionChoices[0])
      return
    }
    if (region && regionChoices.length > 0 && !regionChoices.includes(region)) {
      setRegion(regionChoices[0])
    }
  }, [region, regionChoices])

  const linkableConstraints = useMemo(() => {
    return filterListableConstraints(constraints).slice().sort((a, b) => {
      const skuCmp = a.sku.localeCompare(b.sku)
      if (skuCmp !== 0) return skuCmp
      return (a.regions[0] || '').localeCompare(b.regions[0] || '')
    })
  }, [constraints])

  const monthLabel = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(cursor.year, cursor.month, 1))

  function shiftMonth(delta: number) {
    setCursor((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  function applyConstraintToForm(constraint: CapacityConstraint) {
    const nextType = constraint.resourceType || resourceType
    const nextSku = constraint.sku || ''
    const nextRegion = constraint.regions?.[0] || region || ''
    pendingSkuRef.current = nextSku
    setResourceType(nextType)
    setSku(nextSku)
    if (nextRegion) setRegion(nextRegion)
    setResourceTypes((prev) =>
      prev.includes(nextType) ? prev : [...prev, nextType].sort((a, b) => a.localeCompare(b)),
    )
  }

  function toggleLinkedConstraint(id: string) {
    setLinkedConstraintIds((prev) => {
      const already = prev.includes(id)
      if (already) return prev.filter((x) => x !== id)
      const constraint = constraints.find((c) => c.id === id)
      if (constraint) applyConstraintToForm(constraint)
      return [...prev, id]
    })
  }

  function openCreateForDate(dateKey: string) {
    setSelectedDate(dateKey)
    setExpectedReliefDate(dateKey)
    setShowForm(true)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!sku || !expectedReliefDate || !region || saving) return
    setSaving(true)
    setError(null)
    try {
      await createCapacityCalendarEntry({
        resourceType,
        sku,
        region,
        expectedReliefDate,
        notes,
        source,
        linkedConstraintIds,
        targetSeverity:
          linkedConstraintIds.length > 0 && targetSeverityChoice !== TARGET_SEVERITY_DEFAULT
            ? (targetSeverityChoice as ConstraintSeverity)
            : null,
        targetStatus:
          linkedConstraintIds.length > 0 && targetStatusChoice !== TARGET_STATUS_UNCHANGED
            ? (targetStatusChoice as ConstraintStatus)
            : null,
      })
      setNotes('')
      setLinkedConstraintIds([])
      setTargetSeverityChoice(TARGET_SEVERITY_DEFAULT)
      setTargetStatusChoice(TARGET_STATUS_UNCHANGED)
      setShowForm(false)
      setSelectedDate(expectedReliefDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Capacity calendar</h3>
          <p>
            Link constraints to expected relief dates from Capacity calls and other inputs.
            Past-due or resolved entries auto-downgrade linked constraint severity.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => openCreateForDate(selectedDate)}>
          <Plus size={16} />
          Add relief date
        </button>
      </div>

      <div className="calendar-layout">
        <section className="panel">
          <div className="panel-header">
            <div className="calendar-nav">
              <button type="button" className="btn btn-ghost" onClick={() => shiftMonth(-1)}>
                <ChevronLeft size={18} />
              </button>
              <h4>{monthLabel}</h4>
              <button type="button" className="btn btn-ghost" onClick={() => shiftMonth(1)}>
                <ChevronRight size={18} />
              </button>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const now = new Date()
                setCursor({ year: now.getFullYear(), month: now.getMonth() })
                setSelectedDate(today)
              }}
            >
              Today
            </button>
          </div>
          <div className="panel-body">
            <div className="calendar-grid">
              {WEEKDAYS.map((d) => (
                <div key={d} className="calendar-weekday">
                  {d}
                </div>
              ))}
              {weeks.flat().map((cell, idx) => {
                if (!cell) {
                  return <div key={`empty-${idx}`} className="calendar-cell empty" />
                }
                const dayEntries = entriesByDate.get(cell.dateKey) || []
                const isSelected = cell.dateKey === selectedDate
                const isToday = cell.dateKey === today
                return (
                  <button
                    key={cell.dateKey}
                    type="button"
                    className={`calendar-cell${isSelected ? ' selected' : ''}${
                      isToday ? ' today' : ''
                    }`}
                    onClick={() => setSelectedDate(cell.dateKey)}
                    onDoubleClick={() => openCreateForDate(cell.dateKey)}
                  >
                    <span className="calendar-day-num">{cell.day}</span>
                    <div className="calendar-dots">
                      {dayEntries.slice(0, 3).map((entry) => {
                        const status = effectiveCalendarStatus(entry)
                        return (
                          <span
                            key={entry.id}
                            className={`calendar-dot tone-${statusTone(status)}`}
                            title={`${entry.sku} · ${status}`}
                          />
                        )
                      })}
                      {dayEntries.length > 3 ? (
                        <span className="calendar-more">+{dayEntries.length - 3}</span>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>
                <CalendarDays size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                {selectedDate}
              </h4>
              <p className="muted" style={{ margin: 0 }}>
                {selectedEntries.length} relief entr
                {selectedEntries.length === 1 ? 'y' : 'ies'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => openCreateForDate(selectedDate)}
            >
              <Plus size={16} />
              Add
            </button>
          </div>
          <div className="panel-body stack" style={{ gap: '0.75rem' }}>
            {selectedEntries.length === 0 ? (
              <p className="muted">No expected relief dates on this day. Double-click a date to add one.</p>
            ) : (
              selectedEntries.map((entry) => {
                const status = effectiveCalendarStatus(entry)
                const linked = constraints.filter((c) => entry.linkedConstraintIds.includes(c.id))
                return (
                  <div key={entry.id} className="calendar-entry-card">
                    <div className="calendar-entry-top">
                      <div>
                        <strong>
                          {entry.sku}
                          <span className="muted"> · {entry.resourceType}</span>
                        </strong>
                        <div className="muted" style={{ fontSize: '0.82rem' }}>
                          {entry.region ? `${prettyRegion(entry.region)} · ` : ''}
                          {entry.source || 'Capacity input'}
                          {entry.targetSeverity
                            ? ` · target severity ${entry.targetSeverity}`
                            : linked.length > 0
                              ? ' · severity −1 level (default)'
                              : ''}
                          {entry.targetStatus ? ` · target status ${entry.targetStatus}` : ''}
                          {entry.severityDowngradedAt
                            ? ` · relief applied ${formatDate(entry.severityDowngradedAt)}`
                            : ''}
                        </div>
                      </div>
                      <span className={`pill pill-${statusTone(status)}`}>{status}</span>
                    </div>
                    {entry.notes ? <p className="calendar-entry-notes">{entry.notes}</p> : null}
                    {linked.length > 0 ? (
                      <div className="calendar-linked">
                        <div className="muted" style={{ fontSize: '0.78rem', marginBottom: 4 }}>
                          Linked constraints
                        </div>
                        {linked.map((c) => (
                          <Link key={c.id} to={`/constraints/${c.id}`} className="calendar-linked-row">
                            <span>{c.sku}</span>
                            <SeverityBadge severity={c.severity} />
                            <StatusBadge status={c.status} />
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: '0.82rem' }}>
                        No linked constraints
                      </div>
                    )}
                    <div className="row-actions">
                      {status !== 'Resolved' ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => void resolveCapacityCalendarEntry(entry.id)}
                        >
                          <CheckCircle2 size={14} />
                          Mark resolved
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void deleteCapacityCalendarEntryById(entry.id)}
                      >
                        <Trash2 size={14} />
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>

      {showForm ? (
        <form className="panel" onSubmit={onSubmit}>
          <div className="panel-header">
            <div>
              <h4>Add expected relief date</h4>
              <p>Select resource type and SKU/series, then set the date and notes from the Capacity call.</p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
          <div className="panel-body">
            {error ? <div className="banner banner-error">{error}</div> : null}
            <div className="form-grid">
              <div className="field">
                <label htmlFor="cal-type">Resource type</label>
                <select
                  id="cal-type"
                  value={resourceType}
                  onChange={(e) => setResourceType(e.target.value)}
                  disabled={loadingTypes}
                  required
                >
                  {resourceTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cal-sku">SKU / series</label>
                <select
                  id="cal-sku"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  disabled={loadingSkus && skuOptions.length === 0 && !sku}
                  required
                >
                  {sku && !skuOptions.some((option) => option.sku === sku) ? (
                    <option value={sku}>{sku}</option>
                  ) : null}
                  {skuOptions.length === 0 && !sku ? (
                    <option value="">{loadingSkus ? 'Loading…' : 'No families available'}</option>
                  ) : (
                    skuOptions.map((option) => (
                      <option key={option.sku} value={option.sku}>
                        {option.sku}
                        {option.resourceCount > 0 ? ` (${option.resourceCount})` : ' (suggested)'}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cal-region">Region</label>
                <select
                  id="cal-region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  required
                >
                  {regionChoices.length === 0 ? (
                    <option value="">No regions available</option>
                  ) : (
                    regionChoices.map((r) => (
                      <option key={r} value={r}>
                        {prettyRegion(r)}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cal-date">Expected relief date</label>
                <input
                  id="cal-date"
                  type="date"
                  value={expectedReliefDate}
                  onChange={(e) => setExpectedReliefDate(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="cal-source">Source</label>
                <input
                  id="cal-source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Weekly Capacity call"
                />
              </div>
              <div className="field full">
                <label htmlFor="cal-notes">Notes</label>
                <textarea
                  id="cal-notes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Capacity team expects Dsv5 relief in West Europe after maintenance window."
                />
              </div>
              <div className="field full">
                <label>Link open constraints</label>
                <p className="field-hint" style={{ marginTop: 0 }}>
                  Selecting a constraint fills resource type, SKU/series, and region from that record.
                </p>
                {linkableConstraints.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No open constraints available.
                  </p>
                ) : (
                  <div className="calendar-link-list">
                    {linkableConstraints.map((c) => (
                      <label key={c.id} className="calendar-link-item">
                        <input
                          type="checkbox"
                          checked={linkedConstraintIds.includes(c.id)}
                          onChange={() => toggleLinkedConstraint(c.id)}
                        />
                        <span>
                          {c.sku} · {c.resourceType} ·{' '}
                          {(c.regions || []).map((r) => prettyRegion(r)).join(', ') || 'No region'}
                        </span>
                        <SeverityBadge severity={c.severity} />
                        <StatusBadge status={c.status} />
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {linkedConstraintIds.length > 0 ? (
                <>
                  <div className="field">
                    <label htmlFor="cal-target-severity">Target severity (linked constraints)</label>
                    <select
                      id="cal-target-severity"
                      value={targetSeverityChoice}
                      onChange={(e) => setTargetSeverityChoice(e.target.value)}
                    >
                      <option value={TARGET_SEVERITY_DEFAULT}>
                        Default — decrease one severity level
                      </option>
                      {SEVERITY_OPTIONS.map((severity) => (
                        <option key={severity} value={severity}>
                          Set to {severity}
                        </option>
                      ))}
                    </select>
                    <p className="field-hint">
                      Applied when the relief date is past due or the calendar entry is marked
                      resolved.
                    </p>
                  </div>
                  <div className="field">
                    <label htmlFor="cal-target-status">Target status (linked constraints)</label>
                    <select
                      id="cal-target-status"
                      value={targetStatusChoice}
                      onChange={(e) => setTargetStatusChoice(e.target.value)}
                    >
                      <option value={TARGET_STATUS_UNCHANGED}>No status change</option>
                      {STATUS_OPTIONS.map((status) => (
                        <option key={status} value={status}>
                          Set to {status}
                        </option>
                      ))}
                    </select>
                    <p className="field-hint">
                      Optional. Leave unchanged unless Capacity relief should also update investigation
                      status.
                    </p>
                  </div>
                </>
              ) : null}
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving || !sku || !region}
              >
                {saving ? 'Saving…' : 'Save relief date'}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>All relief dates</h4>
            <p>Scheduled, past due, and resolved entries across the portfolio.</p>
          </div>
        </div>
        <div className="panel-body" style={{ padding: 0 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>SKU / series</th>
                <th>Region</th>
                <th>Type</th>
                <th>Status</th>
                <th>Source</th>
                <th>Linked</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    No calendar entries yet.
                  </td>
                </tr>
              ) : (
                upcoming.map((entry) => (
                  <tr
                    key={entry.id}
                    className="clickable"
                    onClick={() => {
                      setSelectedDate(toDateKey(entry.expectedReliefDate))
                      const d = new Date(entry.expectedReliefDate)
                      if (!Number.isNaN(d.getTime())) {
                        setCursor({ year: d.getFullYear(), month: d.getMonth() })
                      }
                    }}
                  >
                    <td>{entry.expectedReliefDate}</td>
                    <td>{entry.sku}</td>
                    <td>{entry.region ? prettyRegion(entry.region) : '—'}</td>
                    <td>{entry.resourceType}</td>
                    <td>
                      <span className={`pill pill-${statusTone(entry.status)}`}>{entry.status}</span>
                    </td>
                    <td>{entry.source || '—'}</td>
                    <td>{entry.linkedConstraintIds.length}</td>
                    <td className="muted">{entry.notes || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
