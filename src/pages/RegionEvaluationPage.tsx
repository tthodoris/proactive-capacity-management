import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, MapPinned, PlugZap, RefreshCw, X } from 'lucide-react'
import { CheckboxMultiSelect } from '../components/CheckboxMultiSelect'
import { useApp } from '../context/AppContext'
import { deployableAzureRegions } from '../data/azureLocations'
import {
  evaluateRegions,
  type RegionEvalLineItem,
  type RegionEvalRow,
  type RegionEvalStatus,
  type RegionEvaluationResponse,
} from '../lib/azureApi'
import { persistRegionEvaluation } from '../lib/dataApi'
import {
  findSourceCostCell,
  formatRegionMoney,
  regionCostSummary,
  shortUnitLabel,
} from '../lib/regionCost'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'

function statusTone(status: RegionEvalStatus) {
  if (status === 'available') return 'pill-ok'
  if (status === 'restricted') return 'pill-high'
  if (status === 'unavailable') return 'pill-critical'
  return 'pill-neutral'
}

function statusLabel(status: RegionEvalStatus) {
  if (status === 'available') return 'Available'
  if (status === 'restricted') return 'Restricted'
  if (status === 'unavailable') return 'Unavailable'
  return 'Unknown'
}

function regionColumnKey(regionId: string) {
  return `region:${regionId}`
}

function renderCostBlock(
  cell: RegionEvalRow['byRegion'][string] | undefined,
  resourceCount = 1,
) {
  const unit = formatRegionMoney(cell?.unitPrice, cell?.currencyCode)
  const monthlyUnit = formatRegionMoney(cell?.monthlyUnitPrice, cell?.currencyCode)
  const monthlyTotal = formatRegionMoney(cell?.monthlyTotalPrice, cell?.currencyCode)
  if (!unit) {
    return <div className="muted region-cost">{cell?.costNote || 'Price n/a'}</div>
  }
  return (
    <div className="region-cost">
      <strong>
        {unit}
        {shortUnitLabel(cell?.unitOfMeasure)}
      </strong>
      {cell?.pricingMode === 'base' ? (
        <div className="muted" title={cell?.costNote || undefined}>
          Base price
        </div>
      ) : null}
      {monthlyUnit ? (
        <div className="muted">
          ~{monthlyUnit}/mo
          {resourceCount > 1 && monthlyTotal ? ` · ×${resourceCount} ≈ ${monthlyTotal}` : ''}
        </div>
      ) : cell?.costNote ? (
        <div className="muted">{cell.costNote}</div>
      ) : null}
    </div>
  )
}

type ResultSortKey = string

export function RegionEvaluationPage() {
  const {
    customers,
    subscriptions,
    inventory,
    portfolioCustomerIds,
    canSeeAllPortfolios,
    azureSessionReady,
    azureConnection,
    azureLocations,
    azureLocationsLoading,
    azureLocationsError,
    ensureAzureSession,
    loadAzureLocations,
    user,
  } = useApp()

  const [customerId, setCustomerId] = useState('')
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<string[]>([])
  const [targetRegionIds, setTargetRegionIds] = useState<string[]>([])
  const [resumingSession, setResumingSession] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusNote, setStatusNote] = useState<string | null>(null)
  const [result, setResult] = useState<RegionEvaluationResponse | null>(null)
  const [savedEvaluationId, setSavedEvaluationId] = useState<string | null>(null)
  const sessionEnsureRef = useRef(false)
  const { sortKey, sortDir, toggleSort } = useSortState<ResultSortKey>('resourceType')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<ResultSortKey>()

  const resultColumns = useMemo(() => {
    if (!result) return [] as Array<[ResultSortKey, string]>
    return [
      ['resourceType', 'Resource type'],
      ['sku', 'SKU / service'],
      ['count', 'Count'],
      ['sourceRegions', 'Source region / cost'],
      ...result.targetRegions.map(
        (region) => [regionColumnKey(region.id), region.label] as [ResultSortKey, string],
      ),
    ]
  }, [result])

  const getResultValue = useCallback(
    (row: RegionEvalRow, key: string) => {
      if (key === 'resourceType') return row.resourceType
      if (key === 'sku') return row.sku
      if (key === 'count') return String(row.resourceCount)
      if (key === 'sourceRegions') {
        if (!row.sourceRegions.length) return '—'
        return row.sourceRegions
          .map((label) => {
            const match = findSourceCostCell(row, label)
            return `${label} · ${regionCostSummary(match?.cell)}`
          })
          .join(' | ')
      }
      if (key.startsWith('region:')) {
        const regionId = key.slice('region:'.length)
        const cell = row.byRegion[regionId]
        const status = statusLabel(cell?.status || 'unknown')
        const cost = regionCostSummary(cell)
        return cost && cost !== '—' ? `${status} · ${cost}` : status
      }
      return ''
    },
    [],
  )

  const getResultSortValue = useCallback(
    (row: RegionEvalRow, key: string) => {
      if (key === 'count') return row.resourceCount
      if (key.startsWith('region:')) {
        const regionId = key.slice('region:'.length)
        const cell = row.byRegion[regionId]
        // Prefer monthly unit price so regions are directly comparable by cost.
        if (cell?.monthlyUnitPrice != null && Number.isFinite(cell.monthlyUnitPrice)) {
          return cell.monthlyUnitPrice
        }
        if (cell?.unitPrice != null && Number.isFinite(cell.unitPrice)) {
          return cell.unitPrice
        }
        const status = cell?.status || 'unknown'
        const rank: Record<RegionEvalStatus, number> = {
          available: 1_000_000,
          restricted: 1_000_001,
          unavailable: 1_000_002,
          unknown: 1_000_003,
        }
        return rank[status] ?? 1_000_009
      }
      return getResultValue(row, key)
    },
    [getResultValue],
  )

  const filteredResultRows = useMemo(() => {
    if (!result) return []
    return result.results.filter((row) =>
      matchesColumnFilters((column) => String(getResultValue(row, column) ?? '')),
    )
  }, [result, matchesColumnFilters, getResultValue])

  const sortedResultRows = useSortedRows(
    filteredResultRows,
    sortKey,
    sortDir,
    getResultSortValue,
  )

  const resultColumnKeys = useMemo(
    () => resultColumns.map(([key]) => key),
    [resultColumns],
  )

  const resultColumnOptions = useMemo(
    () =>
      result
        ? collectCascadingOptions(result.results, resultColumnKeys, filters, getResultValue)
        : {},
    [result, resultColumnKeys, filters, getResultValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(resultColumnOptions)
  }, [resultColumnOptions, pruneFiltersToOptions])

  useEffect(() => {
    clearAllFilters()
  }, [result?.fetchedAt, clearAllFilters])

  const visibleCustomers = useMemo(
    () =>
      customers
        .filter((c) => canSeeAllPortfolios || portfolioCustomerIds.includes(c.id))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [customers, canSeeAllPortfolios, portfolioCustomerIds],
  )

  const customerSubs = useMemo(
    () =>
      subscriptions
        .filter((s) => s.customerId === customerId)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [subscriptions, customerId],
  )

  const selectedInventory = useMemo(() => {
    if (!customerId || selectedSubscriptionIds.length === 0) return []
    const selected = new Set(selectedSubscriptionIds)
    return inventory.filter(
      (item) => item.customerId === customerId && selected.has(item.subscriptionId),
    )
  }, [inventory, customerId, selectedSubscriptionIds])

  const inventoryFingerprint = useMemo(() => {
    const map = new Map<
      string,
      {
        resourceType: string
        sku: string
        size?: string
        resourceCount: number
        sourceRegions: Set<string>
        sourceRegionCounts: Map<string, number>
      }
    >()

    for (const item of selectedInventory) {
      const key = `${item.resourceType}::${item.sku}::${item.size || ''}`
      const existing = map.get(key)
      const region = item.region || ''
      if (existing) {
        existing.resourceCount += 1
        if (region) {
          existing.sourceRegions.add(region)
          existing.sourceRegionCounts.set(
            region,
            (existing.sourceRegionCounts.get(region) || 0) + 1,
          )
        }
      } else {
        map.set(key, {
          resourceType: item.resourceType,
          sku: item.sku,
          size: item.size,
          resourceCount: 1,
          sourceRegions: new Set(region ? [region] : []),
          sourceRegionCounts: new Map(region ? [[region, 1]] : []),
        })
      }
    }

    return [...map.values()]
      .map((row) => ({
        resourceType: row.resourceType,
        sku: row.sku,
        size: row.size,
        resourceCount: row.resourceCount,
        sourceRegions: [...row.sourceRegions].sort((a, b) => a.localeCompare(b)),
        sourceRegionCounts: Object.fromEntries(row.sourceRegionCounts.entries()),
      }))
      .sort(
        (a, b) =>
          a.resourceType.localeCompare(b.resourceType) || a.sku.localeCompare(b.sku),
      )
  }, [selectedInventory])

  useEffect(() => {
    if (sessionEnsureRef.current) return
    sessionEnsureRef.current = true
    void (async () => {
      const ready = await ensureAzureSession()
      if (!ready) return
      if (azureLocations.length > 0) return
      try {
        await loadAzureLocations()
      } catch {
        // Surfaced via azureLocationsError in context.
      }
    })()
    // One-shot on mount — shared session/locations live in AppContext.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setSelectedSubscriptionIds(
      subscriptions.filter((s) => s.customerId === customerId).map((s) => s.id),
    )
    setResult(null)
    setError(null)
    setStatusNote(null)
    setSavedEvaluationId(null)
  }, [customerId, subscriptions])

  useEffect(() => {
    setResult(null)
    setError(null)
    setStatusNote(null)
    setSavedEvaluationId(null)
  }, [selectedSubscriptionIds, targetRegionIds])

  const locationOptions = useMemo(() => {
    const merged = deployableAzureRegions(azureLocations)
    return merged.map((location) => ({
      value: location.id,
      label: location.label,
      hint: location.id,
    }))
  }, [azureLocations])

  const subscriptionOptions = useMemo(
    () =>
      customerSubs.map((sub) => ({
        value: sub.id,
        label: sub.name,
        hint: sub.subscriptionId,
      })),
    [customerSubs],
  )

  async function onResumeSession() {
    setResumingSession(true)
    setError(null)
    try {
      const ready = await ensureAzureSession()
      if (!ready) {
        setError('No active Azure session. Connect a tenant on Azure Connect first.')
        return
      }
      await loadAzureLocations(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResumingSession(false)
    }
  }

  async function onEvaluate() {
    if (!azureSessionReady) {
      setError('Connect an Azure tenant first so region availability can be checked.')
      return
    }
    if (!customerId) {
      setError('Select a customer first.')
      return
    }
    if (selectedSubscriptionIds.length === 0) {
      setError('Select at least one subscription.')
      return
    }
    if (targetRegionIds.length === 0) {
      setError('Select at least one target region.')
      return
    }
    if (inventoryFingerprint.length === 0) {
      setError(
        'No inventory found for the selected subscriptions. Collect inventory from Azure Connect first.',
      )
      return
    }

    const azureSubscriptionId =
      customerSubs.find((s) => selectedSubscriptionIds.includes(s.id))?.subscriptionId || ''
    if (!azureSubscriptionId) {
      setError('Selected subscriptions are missing Azure subscription IDs.')
      return
    }

    setEvaluating(true)
    setError(null)
    setStatusNote(null)
    setSavedEvaluationId(null)
    try {
      const data = await evaluateRegions({
        azureSubscriptionId,
        targetRegions: targetRegionIds.map((id) => {
          const match = locationOptions.find((location) => location.value === id)
          return match ? { id: match.value, label: match.label } : { id, label: id }
        }),
        items: inventoryFingerprint,
      })
      setResult(data)

      const selectedSubs = customerSubs.filter((s) => selectedSubscriptionIds.includes(s.id))
      const lineItems: RegionEvalLineItem[] = selectedInventory.map((item) => {
        const sub = selectedSubs.find((s) => s.id === item.subscriptionId)
        const row = data.results.find(
          (r) =>
            r.resourceType === item.resourceType &&
            r.sku === item.sku &&
            (r.size || '') === (item.size || ''),
        )
        const sourceMatch = row ? findSourceCostCell(row, item.region) : null
        const byRegion: RegionEvalLineItem['byRegion'] = {}
        for (const region of data.targetRegions) {
          const cell = row?.byRegion[region.id]
          if (cell) {
            byRegion[region.id] = {
              ...cell,
              monthlyTotalPrice: cell.monthlyUnitPrice ?? null,
              resourceCount: 1,
            }
            if (cell.monthlyUnitPrice != null) {
              byRegion[region.id].monthlyTotalPrice = cell.monthlyUnitPrice
            }
          }
        }
        const sourceCost = sourceMatch?.cell
          ? {
              ...sourceMatch.cell,
              monthlyTotalPrice: sourceMatch.cell.monthlyUnitPrice ?? null,
              resourceCount: 1,
            }
          : null

        return {
          subscriptionId: item.subscriptionId,
          subscriptionName: sub?.name || item.subscriptionId,
          azureSubscriptionId: sub?.subscriptionId,
          resourceName: item.name,
          resourceType: item.resourceType,
          sku: item.sku,
          size: item.size,
          sourceRegion: item.region,
          sourceRegionId: sourceMatch?.regionId,
          sourceCost,
          byRegion,
        }
      })

      try {
        const customerName =
          visibleCustomers.find((c) => c.id === customerId)?.name || customerId
        const saved = await persistRegionEvaluation({
          customerId,
          customerName,
          createdByUserId: user.id,
          createdByName: user.name,
          azureSubscriptionId,
          subscriptionIds: selectedSubs.map((s) => s.id),
          subscriptionNames: selectedSubs.map((s) => s.name),
          targetRegions: data.targetRegions,
          summary: data.summary,
          results: data.results,
          lineItems,
          errors: data.errors || [],
        })
        setSavedEvaluationId(saved.id)
        setStatusNote(
          `Evaluation saved. Open Evaluations or Cost analysis for customer ${saved.customerName}.`,
        )
      } catch (saveErr) {
        setStatusNote(
          `Evaluation completed but failed to save: ${
            saveErr instanceof Error ? saveErr.message : String(saveErr)
          }`,
        )
      }
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setEvaluating(false)
    }
  }

  const selectedCustomer = visibleCustomers.find((c) => c.id === customerId)
  const sessionLabel =
    azureConnection?.account?.user?.name ||
    azureConnection?.account?.name ||
    azureConnection?.tenantId ||
    'Azure tenant'

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Region evaluation</h3>
          <p>
            Check whether the customer&apos;s current inventory SKUs and services can be deployed in
            preferred target regions — with Azure retail cost for source and target regions.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <Link className="btn btn-ghost" to="/region-evaluation/history">
            Evaluations
          </Link>
          <Link className="btn btn-ghost" to="/region-evaluation/cost-analysis">
            Cost analysis
          </Link>
          <span className={`pill ${azureSessionReady ? 'pill-ok' : 'pill-neutral'}`}>
            {azureSessionReady ? `Session active · ${sessionLabel}` : 'No Azure session'}
          </span>
        </div>
      </div>

      {!azureSessionReady ? (
        <div className="banner banner-error">
          Target regions require the shared Azure Connect session. Connect or resume the tenant on{' '}
          <Link to="/connect">Azure Connect</Link>, then return here — the same session is reused.
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={resumingSession}
              onClick={() => void onResumeSession()}
            >
              {resumingSession ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
              Resume Azure session
            </button>
            <Link className="btn btn-primary" to="/connect">
              <PlugZap size={16} /> Open Azure Connect
            </Link>
          </div>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Evaluation scope</h4>
            <p>Choose customer, subscriptions, and target regions, then run the evaluation.</p>
          </div>
        </div>
        <div className="form-grid" style={{ padding: '0 1rem 1rem' }}>
          <div className="field">
            <label htmlFor="region-eval-customer">Customer</label>
            <select
              id="region-eval-customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">Select customer…</option>
              {visibleCustomers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <CheckboxMultiSelect
              id="region-eval-subscriptions"
              label="Subscriptions"
              options={subscriptionOptions}
              value={selectedSubscriptionIds}
              onChange={setSelectedSubscriptionIds}
              disabled={!customerId || customerSubs.length === 0}
              placeholder="Select subscriptions"
              selectAllLabel="Select all subscriptions"
              emptyLabel={customerId ? 'No subscriptions for this customer' : 'Select a customer first'}
            />
          </div>

          <div className="field full">
            <CheckboxMultiSelect
              id="region-eval-regions"
              label="Target regions"
              options={locationOptions}
              value={targetRegionIds}
              onChange={setTargetRegionIds}
              disabled={locationOptions.length === 0}
              placeholder="Select any Azure target regions"
              selectAllLabel="Select all regions"
              emptyLabel="No Azure regions available"
              searchableFrom={0}
              searchPlaceholder="Search all Azure regions…"
            />
            <p className="field-hint">
              Full Azure region catalog ({locationOptions.length} regions).
              {azureSessionReady
                ? azureLocationsLoading
                  ? ' Refreshing live locations from your Azure session…'
                  : azureLocations.length > 0
                    ? ' Enriched with live locations from your connected Azure session.'
                    : ''
                : ' Showing the standard public-cloud catalog; connect Azure to refresh with live locations.'}
              {azureLocationsError ? ` Live refresh note: ${azureLocationsError}` : ''}
            </p>
          </div>

          <div className="field full">
            <div className="metrics" style={{ margin: 0 }}>
              <div className="metric-card">
                <div className="label">Inventory resources</div>
                <div className="value">{selectedInventory.length}</div>
                <div className="hint">
                  {selectedCustomer ? selectedCustomer.name : 'No customer selected'}
                </div>
              </div>
              <div className="metric-card">
                <div className="label">Distinct SKUs / services</div>
                <div className="value">{inventoryFingerprint.length}</div>
                <div className="hint">Evaluated as unique type + SKU pairs</div>
              </div>
              <div className="metric-card">
                <div className="label">Target regions</div>
                <div className="value">{targetRegionIds.length}</div>
                <div className="hint">Preferred deployment destinations</div>
              </div>
            </div>
          </div>

          <div className="field full" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={evaluating || !azureSessionReady}
              onClick={() => void onEvaluate()}
            >
              {evaluating ? <Loader2 size={16} className="spin" /> : <MapPinned size={16} />}
              {evaluating ? 'Evaluating…' : 'Evaluate'}
            </button>
            {result ? (
              <span className="muted" style={{ alignSelf: 'center' }}>
                Last run {new Date(result.fetchedAt).toLocaleString()}
              </span>
            ) : null}
          </div>

          {error ? (
            <div className="field full">
              <div className="banner banner-error">{error}</div>
            </div>
          ) : null}
          {statusNote ? (
            <div className="field full">
              <div className="banner">
                {statusNote}
                {savedEvaluationId ? (
                  <>
                    {' '}
                    <Link to="/region-evaluation/history">View evaluations</Link>
                    {' · '}
                    <Link to={`/region-evaluation/cost-analysis?evaluationId=${savedEvaluationId}`}>
                      Cost analysis
                    </Link>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {inventoryFingerprint.length > 0 && !result ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Inventory to evaluate</h4>
              <p>Distinct SKUs and services currently deployed in the selected subscriptions.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Resource type</th>
                  <th>SKU / service</th>
                  <th>Count</th>
                  <th>Source regions</th>
                </tr>
              </thead>
              <tbody>
                {inventoryFingerprint.map((item) => (
                  <tr key={`${item.resourceType}-${item.sku}-${item.size || ''}`}>
                    <td>{item.resourceType}</td>
                    <td>
                      <strong>{item.sku}</strong>
                      {item.size ? <div className="muted">{item.size}</div> : null}
                    </td>
                    <td>{item.resourceCount}</td>
                    <td className="muted">{item.sourceRegions.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {result ? (
        <>
          <div className="grid-3">
            <div className="metric-card">
              <div className="label">Fully available</div>
              <div className="value">{result.summary.fullyAvailable}</div>
              <div className="hint">Available in every selected target region</div>
            </div>
            <div className="metric-card">
              <div className="label">Partially available</div>
              <div className="value">{result.summary.partiallyAvailable}</div>
              <div className="hint">Available in some, but not all, target regions</div>
            </div>
            <div className="metric-card">
              <div className="label">Unavailable / unknown</div>
              <div className="value">
                {result.summary.unavailable + result.summary.unknown}
              </div>
              <div className="hint">
                {result.summary.unavailable} unavailable · {result.summary.unknown} unknown
              </div>
            </div>
          </div>

          {result.errors.length > 0 ? (
            <div className="banner banner-error">
              Some Azure metadata calls failed:{' '}
              {result.errors.map((err) => `${err.scope}: ${err.message}`).join(' · ')}
            </div>
          ) : null}

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Evaluation results</h4>
                <p>
                  {sortedResultRows.length} of {result.summary.itemCount} distinct SKU/service
                  {result.summary.itemCount === 1 ? '' : 's'} across{' '}
                  {result.targetRegions.length} target region
                  {result.targetRegions.length === 1 ? '' : 's'}.
                  Availability plus Azure retail cost for source and target regions (pay-as-you-go).
                  Sort a target region column by monthly unit price to compare.
                </p>
              </div>
              {activeFilterCount > 0 ? (
                <button className="btn btn-ghost" type="button" onClick={clearAllFilters}>
                  <X size={16} /> Clear column filters ({activeFilterCount})
                </button>
              ) : null}
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {resultColumns.map(([column, label]) => (
                      <FilterableTh
                        key={column}
                        label={label}
                        column={column}
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={(c) => toggleSort(c as ResultSortKey)}
                        options={resultColumnOptions[column] || []}
                        selected={filters[column]}
                        onFilterChange={(values) => setColumnFilter(column, values)}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedResultRows.map((row) => (
                    <tr key={`${row.resourceType}-${row.sku}-${row.size || ''}`}>
                      <td>{row.resourceType}</td>
                      <td>
                        <strong>{row.sku}</strong>
                        {row.family ? <div className="muted">{row.family}</div> : null}
                      </td>
                      <td>{row.resourceCount}</td>
                      <td>
                        {row.sourceRegions.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <div className="stack" style={{ gap: '0.45rem' }}>
                            {row.sourceRegions.map((label) => {
                              const match = findSourceCostCell(row, label)
                              const count =
                                match?.cell?.resourceCount ??
                                row.sourceRegionCounts?.[match?.regionId || ''] ??
                                row.resourceCount
                              return (
                                <div key={`${row.sku}-${label}`}>
                                  <strong>{label}</strong>
                                  {renderCostBlock(match?.cell, count)}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </td>
                      {result.targetRegions.map((region) => {
                        const cell = row.byRegion[region.id]
                        const status = cell?.status || 'unknown'
                        const tip = [
                          cell?.reason,
                          cell?.productName ? `Meter: ${cell.productName}` : null,
                          cell?.meterName ? `Meter name: ${cell.meterName}` : null,
                          cell?.costNote,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                        return (
                          <td key={region.id} title={tip || undefined}>
                            <span className={`pill ${statusTone(status)}`}>
                              {statusLabel(status)}
                            </span>
                            {renderCostBlock(cell, row.resourceCount)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  {sortedResultRows.length === 0 ? (
                    <tr>
                      <td colSpan={Math.max(resultColumns.length, 1)}>
                        <div className="empty">No rows match the current column filters.</div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
