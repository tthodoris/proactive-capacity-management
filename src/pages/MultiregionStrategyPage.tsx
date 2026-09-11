import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Compass,
  Download,
  Loader2,
  MapPinned,
  Save,
  Trash2,
} from 'lucide-react'
import { CheckboxMultiSelect } from '../components/CheckboxMultiSelect'
import { useApp } from '../context/AppContext'
import { deployableAzureRegions } from '../data/azureLocations'
import {
  deleteStrategyScenario,
  fetchRegionEvaluations,
  fetchStrategyScenarios,
  persistStrategyScenario,
} from '../lib/dataApi'
import { exportSheetsToExcel } from '../lib/exportExcel'
import { formatDate, prettyRegion } from '../lib/format'
import {
  buildDependencyMap,
  buildFailoverScorecard,
  buildRegionShortlist,
  buildWhatIfPlan,
  buildWorkloadGroups,
  filterInventoryForStrategy,
  type StrategyGroupBy,
  type StrategyScenario,
} from '../lib/multiregionStrategy'
import type { SavedRegionEvaluation } from '../lib/azureApi'

const GROUP_BY_OPTIONS: Array<{ value: StrategyGroupBy; label: string }> = [
  { value: 'resourceGroup', label: 'App / RG heuristic' },
  { value: 'resourceType', label: 'Resource type' },
  { value: 'region', label: 'Region' },
  { value: 'skuFamily', label: 'SKU family' },
]

function rolePillClass(role: string) {
  if (role === 'Primary') return 'pill-ok'
  if (role === 'Secondary') return 'pill-high'
  if (role === 'Tertiary') return 'pill-neutral'
  return 'pill-neutral'
}

function gradePillClass(grade: string) {
  if (grade === 'Strong') return 'pill-ok'
  if (grade === 'Moderate') return 'pill-high'
  return 'pill-critical'
}

export function MultiregionStrategyPage() {
  const {
    customers,
    subscriptions,
    inventory,
    constraints,
    quotas,
    portfolioCustomerIds,
    canSeeAllPortfolios,
    azureLocations,
    user,
  } = useApp()

  const [customerId, setCustomerId] = useState('')
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<string[]>([])
  const [groupBy, setGroupBy] = useState<StrategyGroupBy>('resourceGroup')
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null)
  const [candidateRegionIds, setCandidateRegionIds] = useState<string[]>([])
  const [whatIfPercent, setWhatIfPercent] = useState(50)
  const [scenarioName, setScenarioName] = useState('')
  const [scenarioNotes, setScenarioNotes] = useState('')
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null)
  const [linkedEvaluationIds, setLinkedEvaluationIds] = useState<string[]>([])
  const [scenarios, setScenarios] = useState<StrategyScenario[]>([])
  const [evaluations, setEvaluations] = useState<SavedRegionEvaluation[]>([])
  const [loadingScenarios, setLoadingScenarios] = useState(false)
  const [saving, setSaving] = useState(false)
  const [statusNote, setStatusNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const visibleCustomers = useMemo(
    () =>
      customers
        .filter((c) => canSeeAllPortfolios || portfolioCustomerIds.includes(c.id))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [customers, canSeeAllPortfolios, portfolioCustomerIds],
  )

  const selectedCustomer = useMemo(
    () => visibleCustomers.find((c) => c.id === customerId) || null,
    [visibleCustomers, customerId],
  )

  const customerSubs = useMemo(
    () =>
      subscriptions
        .filter((s) => s.customerId === customerId)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [subscriptions, customerId],
  )

  const regionOptions = useMemo(() => {
    const fromAzure = deployableAzureRegions(azureLocations).map((r) => ({
      value: r.id,
      label: r.label || r.id,
    }))
    if (fromAzure.length) return fromAzure
    const fromInventory = new Map<string, string>()
    for (const item of inventory) {
      if (!item.region) continue
      fromInventory.set(item.region, prettyRegion(item.region))
    }
    return [...fromInventory.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [azureLocations, inventory])

  const scopedInventory = useMemo(
    () => filterInventoryForStrategy(inventory, customerId, selectedSubscriptionIds),
    [inventory, customerId, selectedSubscriptionIds],
  )

  const workloadGroups = useMemo(
    () => buildWorkloadGroups(scopedInventory, groupBy),
    [scopedInventory, groupBy],
  )

  useEffect(() => {
    if (!selectedGroupKey && workloadGroups[0]) {
      setSelectedGroupKey(workloadGroups[0].key)
      return
    }
    if (selectedGroupKey && !workloadGroups.some((g) => g.key === selectedGroupKey)) {
      setSelectedGroupKey(workloadGroups[0]?.key || null)
    }
  }, [workloadGroups, selectedGroupKey])

  const selectedGroup = useMemo(
    () => workloadGroups.find((g) => g.key === selectedGroupKey) || null,
    [workloadGroups, selectedGroupKey],
  )

  const workloadItems = selectedGroup?.items || scopedInventory

  const candidateRegions = useMemo(() => {
    const selected = new Set(candidateRegionIds)
    const picked = regionOptions.filter((r) => selected.has(r.value))
    if (picked.length) {
      return picked.map((r) => ({ id: r.value, label: r.label }))
    }
    // Default candidates: current footprint regions + common pairs already in options.
    const present = new Set(workloadItems.map((i) => i.region).filter(Boolean))
    const defaults = regionOptions.filter(
      (r) => present.has(r.value) || present.has(r.label),
    )
    return (defaults.length ? defaults : regionOptions.slice(0, 6)).map((r) => ({
      id: r.value,
      label: r.label,
    }))
  }, [candidateRegionIds, regionOptions, workloadItems])

  const shortlist = useMemo(
    () =>
      customerId
        ? buildRegionShortlist({
            workloadItems,
            customerId,
            constraints,
            quotas,
            candidateRegions,
          })
        : [],
    [workloadItems, customerId, constraints, quotas, candidateRegions],
  )

  const scorecard = useMemo(
    () =>
      buildFailoverScorecard({
        workloadItems,
        constraints,
        shortlist,
      }),
    [workloadItems, constraints, shortlist],
  )

  const dependencyNodes = useMemo(() => buildDependencyMap(workloadItems), [workloadItems])

  const whatIfTarget = shortlist.find((s) => s.role === 'Secondary') || shortlist[1] || shortlist[0]

  const whatIfPlan = useMemo(
    () =>
      customerId && whatIfTarget
        ? buildWhatIfPlan({
            workloadItems,
            percent: whatIfPercent,
            customerId,
            quotas,
            targetRegionId: whatIfTarget.regionId,
            targetRegionLabel: whatIfTarget.regionLabel,
          })
        : null,
    [workloadItems, whatIfPercent, customerId, quotas, whatIfTarget],
  )

  const refreshScenarios = useCallback(async () => {
    if (!customerId) {
      setScenarios([])
      return
    }
    setLoadingScenarios(true)
    setError(null)
    try {
      const [scenarioData, evalData] = await Promise.all([
        fetchStrategyScenarios(customerId),
        fetchRegionEvaluations(customerId),
      ])
      setScenarios(scenarioData.scenarios || [])
      setEvaluations(evalData.evaluations || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingScenarios(false)
    }
  }, [customerId])

  useEffect(() => {
    void refreshScenarios()
  }, [refreshScenarios])

  const resetScopeForCustomer = (nextCustomerId: string) => {
    setCustomerId(nextCustomerId)
    setSelectedSubscriptionIds([])
    setSelectedGroupKey(null)
    setActiveScenarioId(null)
    setScenarioName('')
    setScenarioNotes('')
    setLinkedEvaluationIds([])
    setCandidateRegionIds([])
    setStatusNote(null)
    setError(null)
  }

  const applyScenario = (scenario: StrategyScenario) => {
    setCustomerId(scenario.customerId)
    setActiveScenarioId(scenario.id)
    setSelectedSubscriptionIds(scenario.subscriptionIds || [])
    setGroupBy(scenario.groupBy || 'resourceGroup')
    setSelectedGroupKey(scenario.selectedGroupKey)
    setCandidateRegionIds(scenario.candidateRegionIds || [])
    setWhatIfPercent(scenario.whatIfPercent || 50)
    setLinkedEvaluationIds(scenario.linkedEvaluationIds || [])
    setScenarioName(scenario.name)
    setScenarioNotes(scenario.notes || '')
    setStatusNote(`Loaded scenario “${scenario.name}”.`)
    setError(null)
  }

  const onSaveScenario = async () => {
    if (!selectedCustomer) {
      setError('Select a customer first.')
      return
    }
    const name = scenarioName.trim() || `Strategy ${formatDate(new Date().toISOString())}`
    setSaving(true)
    setError(null)
    try {
      const { scenario } = await persistStrategyScenario({
        id: activeScenarioId || undefined,
        customerId: selectedCustomer.id,
        customerName: selectedCustomer.name,
        name,
        notes: scenarioNotes,
        subscriptionIds: selectedSubscriptionIds,
        groupBy,
        selectedGroupKey,
        candidateRegionIds,
        whatIfPercent,
        linkedEvaluationIds,
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      })
      setActiveScenarioId(scenario.id)
      setScenarioName(scenario.name)
      setStatusNote(`Saved scenario “${scenario.name}”.`)
      await refreshScenarios()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onDeleteScenario = async (id: string) => {
    if (!window.confirm('Delete this strategy scenario?')) return
    try {
      await deleteStrategyScenario(id)
      if (activeScenarioId === id) setActiveScenarioId(null)
      setStatusNote('Scenario deleted.')
      await refreshScenarios()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onExportBriefing = () => {
    if (!selectedCustomer) return
    const stamp = new Date().toISOString().slice(0, 10)
    const filename = `multiregion-strategy-${selectedCustomer.name.replace(/\s+/g, '-')}-${stamp}.xlsx`

    exportSheetsToExcel(filename, [
      {
        name: 'Briefing',
        columns: [
          { key: 'field', label: 'Field' },
          { key: 'value', label: 'Value' },
        ],
        rows: [
          { field: 'Customer', value: selectedCustomer.name },
          {
            field: 'Subscriptions',
            value:
              selectedSubscriptionIds
                .map((id) => customerSubs.find((s) => s.id === id)?.name || id)
                .join(', ') || 'All for customer',
          },
          { field: 'Grouping lens', value: groupBy },
          { field: 'Selected workload', value: selectedGroup?.label || 'All scoped inventory' },
          { field: 'Resources in scope', value: workloadItems.length },
          { field: 'Est. vCPU weight', value: selectedGroup?.vcpuEstimate ?? '—' },
          {
            field: 'Failover grade',
            value: `${scorecard.grade} (${scorecard.score}/100) — ${scorecard.pattern}`,
          },
          {
            field: 'Primary / Secondary / Tertiary',
            value: shortlist
              .slice(0, 3)
              .map((s) => `${s.role}: ${s.regionLabel} (${s.score})`)
              .join(' · '),
          },
          {
            field: 'What-if',
            value: whatIfPlan
              ? `${whatIfPlan.percent}% into ${whatIfTarget?.regionLabel || 'n/a'} ≈ ${whatIfPlan.projectedItemCount} resources / ${whatIfPlan.projectedVcpu} vCPU`
              : 'n/a',
          },
          { field: 'Scenario', value: scenarioName || '(unsaved)' },
          { field: 'Notes', value: scenarioNotes || '' },
          { field: 'Exported at', value: new Date().toISOString() },
        ],
      },
      {
        name: 'Footprint groups',
        columns: [
          { key: 'label', label: 'Group' },
          { key: 'itemCount', label: 'Resources' },
          { key: 'vcpuEstimate', label: 'Est. vCPU' },
          { key: 'topRegions', label: 'Top regions' },
          { key: 'topTypes', label: 'Top types' },
        ],
        rows: workloadGroups.map((g) => ({
          label: g.label,
          itemCount: g.itemCount,
          vcpuEstimate: g.vcpuEstimate,
          topRegions: g.regions
            .slice(0, 3)
            .map((r) => `${prettyRegion(r.region)} ${r.sharePct}%`)
            .join('; '),
          topTypes: g.resourceTypes
            .slice(0, 3)
            .map((t) => `${t.type} (${t.count})`)
            .join('; '),
        })),
      },
      {
        name: 'Region shortlist',
        columns: [
          { key: 'role', label: 'Role' },
          { key: 'regionLabel', label: 'Region' },
          { key: 'score', label: 'Score' },
          { key: 'currentSharePct', label: 'Current share %' },
          { key: 'openConstraintCount', label: 'Open constraints' },
          { key: 'quotaPressurePct', label: 'Quota pressure %' },
          { key: 'reasons', label: 'Reasons' },
        ],
        rows: shortlist.map((s) => ({
          role: s.role,
          regionLabel: s.regionLabel,
          score: s.score,
          currentSharePct: s.currentSharePct,
          openConstraintCount: s.openConstraintCount,
          quotaPressurePct: s.quotaPressurePct ?? '',
          reasons: s.reasons.join(' | '),
        })),
      },
      {
        name: 'Failover checks',
        columns: [
          { key: 'label', label: 'Check' },
          { key: 'pass', label: 'Pass' },
          { key: 'detail', label: 'Detail' },
        ],
        rows: scorecard.checks.map((c) => ({
          label: c.label,
          pass: c.pass ? 'Yes' : 'No',
          detail: c.detail,
        })),
      },
      {
        name: 'Dependencies',
        columns: [
          { key: 'resourceType', label: 'Service' },
          { key: 'present', label: 'Present' },
          { key: 'count', label: 'Count' },
          { key: 'regions', label: 'Regions' },
          { key: 'pairedWith', label: 'Paired with' },
          { key: 'note', label: 'Note' },
        ],
        rows: dependencyNodes.map((n) => ({
          resourceType: n.resourceType,
          present: n.present ? 'Yes' : 'No',
          count: n.count,
          regions: n.regions.map(prettyRegion).join(', '),
          pairedWith: n.pairedWith.join(', '),
          note: n.note,
        })),
      },
      {
        name: 'What-if',
        columns: [
          { key: 'field', label: 'Field' },
          { key: 'value', label: 'Value' },
        ],
        rows: whatIfPlan
          ? [
              { field: 'Percent', value: whatIfPlan.percent },
              { field: 'Target region', value: whatIfTarget?.regionLabel || '' },
              { field: 'Source resources', value: whatIfPlan.sourceItemCount },
              { field: 'Projected resources', value: whatIfPlan.projectedItemCount },
              { field: 'Source vCPU', value: whatIfPlan.sourceVcpu },
              { field: 'Projected vCPU', value: whatIfPlan.projectedVcpu },
              ...whatIfPlan.bySkuFamily.map((f) => ({
                field: `SKU family: ${f.family}`,
                value: `${f.sourceCount} → ${f.projectedCount}`,
              })),
              ...whatIfPlan.quotaWatch.map((q) => ({
                field: `Quota: ${q.name} (${q.region})`,
                value: `${q.usage}/${q.limit} (${q.usagePct}%) +${q.projectedExtra} — ${q.note}`,
              })),
            ]
          : [{ field: 'Status', value: 'No what-if plan available' }],
      },
      {
        name: 'Next actions',
        columns: [
          { key: 'owner', label: 'Owner' },
          { key: 'action', label: 'Action' },
        ],
        rows: [
          {
            owner: 'CSA',
            action: `Review shortlist with customer; validate ${shortlist[1]?.regionLabel || 'secondary'} as DR/expansion target.`,
          },
          {
            owner: 'CSA + customer',
            action: `Confirm paired services (${dependencyNodes
              .filter((n) => n.present)
              .slice(0, 4)
              .map((n) => n.resourceType)
              .join(', ')}) can land in the secondary region.`,
          },
          {
            owner: 'CSA',
            action: 'Run Region evaluation for primary + secondary candidates and attach to this scenario.',
          },
          {
            owner: 'Customer',
            action: `Decide target pattern: ${scorecard.pattern}.`,
          },
        ],
      },
    ])
    setStatusNote('Briefing pack exported.')
  }

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Multiregion strategy</h3>
          <p>
            Plan primary / secondary region paths from live inventory: footprint, shortlist,
            failover readiness, dependencies, what-if capacity, and saved scenarios.
          </p>
        </div>
        <div className="strategy-hero-actions">
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!selectedCustomer || workloadItems.length === 0}
            onClick={onExportBriefing}
          >
            <Download size={16} />
            Briefing pack
          </button>
          <Link className="btn btn-secondary" to="/region-evaluation">
            <MapPinned size={16} />
            Region evaluation
          </Link>
        </div>
      </div>

      {(error || statusNote) && (
        <div className={`banner ${error ? 'banner-error' : 'banner-ok'}`}>
          {error || statusNote}
        </div>
      )}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>1–2. Scope &amp; landing-zone lens</h4>
            <p>
              Choose customer and subscriptions, then group inventory as an app / RG heuristic,
              type, region, or SKU family (tags are not in inventory today).
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="strategy-scope-grid">
            <label className="field">
              <span>Customer</span>
              <select
                value={customerId}
                onChange={(e) => resetScopeForCustomer(e.target.value)}
              >
                <option value="">Select customer…</option>
                {visibleCustomers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <CheckboxMultiSelect
              label="Subscriptions"
              options={customerSubs.map((s) => ({ value: s.id, label: s.name }))}
              value={selectedSubscriptionIds}
              onChange={setSelectedSubscriptionIds}
              placeholder={customerId ? 'All subscriptions' : 'Select customer first'}
              disabled={!customerId}
              emptyLabel="No subscriptions"
              selectAllLabel="All subscriptions"
            />
            <label className="field">
              <span>Group by</span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as StrategyGroupBy)}
              >
                {GROUP_BY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <CheckboxMultiSelect
              label="Candidate regions (optional)"
              options={regionOptions}
              value={candidateRegionIds}
              onChange={setCandidateRegionIds}
              placeholder="Auto from footprint"
              searchableFrom={0}
              searchPlaceholder="Search regions…"
            />
          </div>
          <p className="muted strategy-scope-meta">
            {customerId
              ? `${scopedInventory.length} resources in scope · ${workloadGroups.length} groups`
              : 'Select a customer to begin.'}
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Workload footprint canvas</h4>
            <p>Where the selected workload runs today — regions, types, and relative weight.</p>
          </div>
        </div>
        <div className="panel-body">
          {!customerId ? (
            <div className="empty">Select a customer to build the footprint.</div>
          ) : workloadGroups.length === 0 ? (
            <div className="empty">No inventory in this scope.</div>
          ) : (
            <div className="strategy-footprint">
              <div className="strategy-group-list" role="list">
                {workloadGroups.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    role="listitem"
                    className={`strategy-group-item${
                      selectedGroupKey === g.key ? ' is-active' : ''
                    }`}
                    onClick={() => setSelectedGroupKey(g.key)}
                  >
                    <strong className="strategy-group-title">{g.label}</strong>
                    <span className="muted strategy-group-meta">
                      {g.itemCount} resources · ~{g.vcpuEstimate} vCPU
                    </span>
                    <div className="strategy-share-bars">
                      {g.regions.slice(0, 3).map((r) => (
                        <div key={r.region} className="strategy-share-row">
                          <span className="strategy-share-label">{prettyRegion(r.region)}</span>
                          <div className="strategy-share-track">
                            <div
                              className="strategy-share-fill"
                              style={{ width: `${Math.min(100, r.sharePct)}%` }}
                            />
                          </div>
                          <span className="strategy-share-pct">{r.sharePct}%</span>
                        </div>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
              <div className="strategy-group-detail">
                {selectedGroup ? (
                  <>
                    <h5>{selectedGroup.label}</h5>
                    <div className="strategy-stat-row">
                      <div className="strategy-stat-card">
                        <span className="muted">Resources</span>
                        <strong>{selectedGroup.itemCount}</strong>
                      </div>
                      <div className="strategy-stat-card">
                        <span className="muted">Est. vCPU</span>
                        <strong>{selectedGroup.vcpuEstimate}</strong>
                      </div>
                      <div className="strategy-stat-card">
                        <span className="muted">Regions</span>
                        <strong>{selectedGroup.regions.length}</strong>
                      </div>
                    </div>
                    <div className="strategy-detail-cols">
                      <div>
                        <h6>Top resource types</h6>
                        <ul className="strategy-plain-list">
                          {selectedGroup.resourceTypes.slice(0, 8).map((t) => (
                            <li key={t.type}>
                              {t.type} <span className="muted">×{t.count}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h6>Top SKU families</h6>
                        <ul className="strategy-plain-list">
                          {selectedGroup.skuFamilies.slice(0, 8).map((f) => (
                            <li key={f.family}>
                              {f.family} <span className="muted">×{f.count}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty">Select a group.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="strategy-two-col">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Region shortlist</h4>
              <p>Primary / secondary / tertiary from constraints, quotas, and pairing hints.</p>
            </div>
          </div>
          <div className="panel-body">
            {shortlist.length === 0 ? (
              <div className="empty">Need scoped inventory and candidate regions.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Region</th>
                      <th>Score</th>
                      <th>Share</th>
                      <th>Constraints</th>
                      <th>Quota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortlist.slice(0, 8).map((entry) => (
                      <tr key={entry.regionId}>
                        <td>
                          <span className={`pill ${rolePillClass(entry.role)}`}>{entry.role}</span>
                        </td>
                        <td>
                          <strong>{entry.regionLabel}</strong>
                          <div className="muted strategy-reason">
                            {entry.reasons[0]}
                          </div>
                        </td>
                        <td>{entry.score}</td>
                        <td>{entry.currentSharePct}%</td>
                        <td>{entry.openConstraintCount}</td>
                        <td>
                          {entry.quotaPressurePct == null ? '—' : `${entry.quotaPressurePct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Failover readiness</h4>
              <p className="strategy-score-line">
                <span className={`pill ${gradePillClass(scorecard.grade)}`}>
                  {scorecard.grade}
                </span>
                <span>
                  {scorecard.score}/100 · {scorecard.pattern}
                </span>
              </p>
            </div>
          </div>
          <div className="panel-body">
            <ul className="strategy-check-list">
              {scorecard.checks.map((check) => (
                <li key={check.id} className={check.pass ? 'is-pass' : 'is-fail'}>
                  <span className={`strategy-check-badge ${check.pass ? 'is-pass' : 'is-fail'}`}>
                    {check.pass ? 'Pass' : 'Gap'}
                  </span>
                  <div className="strategy-check-copy">
                    <strong>{check.label}</strong>
                    <span className="muted">{check.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Dependency &amp; paired-service map</h4>
            <p>Services that typically must move or replicate together.</p>
          </div>
        </div>
        <div className="panel-body">
          {dependencyNodes.length === 0 ? (
            <div className="empty">No dependency signal until inventory is scoped.</div>
          ) : (
            <div className="strategy-dep-grid">
              {dependencyNodes.slice(0, 12).map((node) => (
                <div
                  key={node.resourceType}
                  className={`strategy-dep-card${node.present ? '' : ' is-missing'}`}
                >
                  <div className="strategy-dep-top">
                    <strong>{node.resourceType}</strong>
                    <span className={`pill ${node.present ? 'pill-ok' : 'pill-neutral'}`}>
                      {node.present ? `${node.count} present` : 'Not in scope'}
                    </span>
                  </div>
                  {node.regions.length > 0 && (
                    <div className="muted strategy-dep-regions">
                      {node.regions.map(prettyRegion).join(' · ')}
                    </div>
                  )}
                  {node.pairedWith.length > 0 && (
                    <div className="strategy-dep-pairs">
                      Pairs with: {node.pairedWith.slice(0, 4).join(', ')}
                    </div>
                  )}
                  <p className="muted">{node.note}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>What-if expansion planner</h4>
            <p>
              Simulate standing up a share of this workload in{' '}
              {whatIfTarget ? whatIfTarget.regionLabel : 'the secondary candidate'}.
            </p>
          </div>
          <label className="field strategy-whatif-pct">
            <span>{whatIfPercent}%</span>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={whatIfPercent}
              onChange={(e) => setWhatIfPercent(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="panel-body">
          {!whatIfPlan ? (
            <div className="empty">Select a customer with inventory to run what-if.</div>
          ) : (
            <>
              <div className="strategy-stat-row">
                <div className="strategy-stat-card">
                  <span className="muted">Projected resources</span>
                  <strong>
                    {whatIfPlan.projectedItemCount}
                    <span className="muted"> / {whatIfPlan.sourceItemCount}</span>
                  </strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">Projected vCPU</span>
                  <strong>
                    {whatIfPlan.projectedVcpu}
                    <span className="muted"> / {whatIfPlan.sourceVcpu}</span>
                  </strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">Target</span>
                  <strong>{whatIfTarget?.regionLabel || '—'}</strong>
                </div>
              </div>
              <div className="strategy-detail-cols">
                <div>
                  <h6>SKU family projection</h6>
                  <ul className="strategy-plain-list">
                    {whatIfPlan.bySkuFamily.map((f) => (
                      <li key={f.family}>
                        {f.family}{' '}
                        <span className="muted">
                          {f.sourceCount} → {f.projectedCount}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h6>Quota watch ({whatIfTarget?.regionLabel || 'target'})</h6>
                  {whatIfPlan.quotaWatch.length === 0 ? (
                    <p className="muted">No scoped quotas for this region.</p>
                  ) : (
                    <ul className="strategy-plain-list">
                      {whatIfPlan.quotaWatch.map((q) => (
                        <li key={`${q.region}-${q.name}`}>
                          {q.name}{' '}
                          <span className="muted">
                            {q.usage}/{q.limit} ({q.usagePct}%) +{q.projectedExtra}
                          </span>
                          <div className="muted">{q.note}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4 className="strategy-panel-title">
              <Compass size={18} />
              Strategy scenarios library
            </h4>
            <p>Persist named plans in Postgres for follow-up CSA conversations.</p>
          </div>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!selectedCustomer || saving}
            onClick={() => void onSaveScenario()}
          >
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {activeScenarioId ? 'Update scenario' : 'Save scenario'}
          </button>
        </div>
        <div className="panel-body stack">
          <div className="strategy-scope-grid">
            <label className="field">
              <span>Scenario name</span>
              <input
                value={scenarioName}
                onChange={(e) => setScenarioName(e.target.value)}
                placeholder="e.g. DR West Europe → North Europe"
              />
            </label>
            <label className="field">
              <span>Notes</span>
              <input
                value={scenarioNotes}
                onChange={(e) => setScenarioNotes(e.target.value)}
                placeholder="Workshop context, customer decisions…"
              />
            </label>
            <CheckboxMultiSelect
              label="Linked region evaluations"
              options={evaluations.map((ev) => ({
                value: ev.id,
                label: `${formatDate(ev.createdAt)} · ${(ev.targetRegions || [])
                  .map((r) => r.label || r.id)
                  .slice(0, 3)
                  .join(', ')}`,
              }))}
              value={linkedEvaluationIds}
              onChange={setLinkedEvaluationIds}
              placeholder={customerId ? 'None linked' : 'Select customer first'}
              disabled={!customerId}
              emptyLabel="No saved evaluations"
            />
          </div>

          {loadingScenarios ? (
            <div className="muted">Loading scenarios…</div>
          ) : scenarios.length === 0 ? (
            <div className="empty">No saved scenarios for this customer yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Updated</th>
                    <th>Subs</th>
                    <th>Group</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s) => (
                    <tr key={s.id} className={activeScenarioId === s.id ? 'is-selected-row' : ''}>
                      <td>
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => applyScenario(s)}
                        >
                          {s.name}
                        </button>
                        {s.notes ? <div className="muted">{s.notes}</div> : null}
                      </td>
                      <td>{formatDate(s.updatedAt)}</td>
                      <td>{s.subscriptionIds?.length || 0}</td>
                      <td>{s.groupBy}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          title="Delete"
                          onClick={() => void onDeleteScenario(s.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
