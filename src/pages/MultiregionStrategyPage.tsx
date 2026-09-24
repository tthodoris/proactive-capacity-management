import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Compass,
  Download,
  Link2,
  Loader2,
  MapPinned,
  Plus,
  Save,
  ShieldAlert,
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
  buildStrategyEvalCoverage,
  buildStrategyQuotaRecommendations,
  buildWhatIfPlan,
  buildWorkloadGroups,
  collectStrategySkuGaps,
  dependencyNoteForType,
  emptyWhatIfSelection,
  filterInventoryForStrategy,
  filterLinkableEvaluations,
  groupInventoryByServiceCategory,
  pruneLinkedEvaluationIds,
  resolveStrategyRegionIds,
  suggestDependencyItems,
  type StrategyEvalLaunchState,
  type StrategyGroupBy,
  type StrategyScenario,
  type WhatIfExpansionAdd,
  type WhatIfSelection,
} from '../lib/multiregionStrategy'
import type { SavedRegionEvaluation } from '../lib/azureApi'

const GROUP_BY_OPTIONS: Array<{ value: StrategyGroupBy; label: string }> = [
  { value: 'resourceGroup', label: 'App / RG heuristic' },
  { value: 'resourceType', label: 'Resource type' },
  { value: 'region', label: 'Region' },
  { value: 'skuFamily', label: 'SKU family' },
]

export function MultiregionStrategyPage() {
  const navigate = useNavigate()
  const {
    customers,
    subscriptions,
    inventory,
    constraints,
    quotas,
    quotaGroupLimits,
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
  const [whatIfSelection, setWhatIfSelection] = useState<WhatIfSelection>(() => emptyWhatIfSelection())
  const [expansionDraft, setExpansionDraft] = useState<Record<string, { sku: string; size: string; count: string }>>(
    {},
  )
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

  const effectiveSubscriptionIds = useMemo(() => {
    if (selectedSubscriptionIds.length > 0) return selectedSubscriptionIds
    return customerSubs.map((s) => s.id)
  }, [selectedSubscriptionIds, customerSubs])

  const serviceCategories = useMemo(
    () => groupInventoryByServiceCategory(workloadItems),
    [workloadItems],
  )

  const selectedMoveItems = useMemo(
    () => workloadItems.filter((item) => whatIfSelection.selectedItemIds.includes(item.id)),
    [workloadItems, whatIfSelection.selectedItemIds],
  )

  const suggestedDependencies = useMemo(
    () => suggestDependencyItems(selectedMoveItems, workloadItems),
    [selectedMoveItems, workloadItems],
  )

  const whatIfTarget = useMemo(() => {
    const id = whatIfSelection.targetRegionId
    if (id) {
      const fromCandidates = candidateRegions.find((r) => r.id === id)
      if (fromCandidates) return fromCandidates
      const fromOptions = regionOptions.find((r) => r.value === id)
      if (fromOptions) return { id: fromOptions.value, label: fromOptions.label }
    }
    return candidateRegions[0] || null
  }, [whatIfSelection.targetRegionId, candidateRegions, regionOptions])

  useEffect(() => {
    if (!whatIfSelection.targetRegionId && candidateRegions[0]) {
      setWhatIfSelection((prev) => ({ ...prev, targetRegionId: candidateRegions[0].id }))
    }
  }, [candidateRegions, whatIfSelection.targetRegionId])

  useEffect(() => {
    const validIds = new Set(workloadItems.map((item) => item.id))
    setWhatIfSelection((prev) => {
      const selectedItemIds = prev.selectedItemIds.filter((id) => validIds.has(id))
      const ignoredDependencyIds = prev.ignoredDependencyIds.filter((id) => validIds.has(id))
      if (
        selectedItemIds.length === prev.selectedItemIds.length &&
        ignoredDependencyIds.length === prev.ignoredDependencyIds.length
      ) {
        return prev
      }
      return { ...prev, selectedItemIds, ignoredDependencyIds }
    })
  }, [workloadItems])

  const dependencySlices = useMemo(
    () => buildDependencyMap(workloadItems, customerSubs),
    [workloadItems, customerSubs],
  )

  const evaluationTargetRegionIds = useMemo(() => {
    const currentRegions = workloadItems.map((item) => item.region).filter(Boolean)
    const candidateIds = candidateRegions.map((r) => r.id)
    return resolveStrategyRegionIds([...currentRegions, ...candidateIds], regionOptions)
  }, [workloadItems, candidateRegions, regionOptions])

  const canLaunchEvaluation =
    Boolean(customerId) &&
    effectiveSubscriptionIds.length > 0 &&
    evaluationTargetRegionIds.length > 0

  const launchRegionEvaluation = useCallback(() => {
    if (!customerId || effectiveSubscriptionIds.length === 0) {
      setError('Select a customer and at least one subscription before running evaluation.')
      return
    }
    if (evaluationTargetRegionIds.length === 0) {
      setError(
        'Select candidate regions (or ensure the workload has current regions) before running evaluation.',
      )
      return
    }
    const state: StrategyEvalLaunchState = {
      fromStrategy: true,
      customerId,
      subscriptionIds: effectiveSubscriptionIds,
      targetRegionIds: evaluationTargetRegionIds,
      autoEvaluate: true,
    }
    navigate('/region-evaluation', { state })
  }, [customerId, effectiveSubscriptionIds, evaluationTargetRegionIds, navigate])

  const whatIfPlan = useMemo(
    () =>
      customerId && whatIfTarget
        ? buildWhatIfPlan({
            workloadItems,
            selection: {
              ...whatIfSelection,
              targetRegionId: whatIfTarget.id,
            },
            customerId,
            quotas,
            targetRegionId: whatIfTarget.id,
            targetRegionLabel: whatIfTarget.label,
          })
        : null,
    [workloadItems, whatIfSelection, customerId, quotas, whatIfTarget],
  )

  const strategyRegionIds = useMemo(
    () => candidateRegions.map((r) => r.id),
    [candidateRegions],
  )

  const linkableEvaluations = useMemo(
    () =>
      customerId
        ? filterLinkableEvaluations(evaluations, {
            customerId,
            subscriptionIds: effectiveSubscriptionIds,
            regionIds: strategyRegionIds,
          })
        : [],
    [evaluations, customerId, effectiveSubscriptionIds, strategyRegionIds],
  )

  useEffect(() => {
    setLinkedEvaluationIds((prev) => {
      const next = pruneLinkedEvaluationIds(prev, linkableEvaluations)
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev
      return next
    })
  }, [linkableEvaluations])

  const linkedMatchingEvaluations = useMemo(() => {
    const linked = new Set(linkedEvaluationIds)
    const fromLinked = linkableEvaluations.filter((e) => linked.has(e.id))
    return fromLinked.length > 0 ? fromLinked : linkableEvaluations.slice(0, 3)
  }, [linkableEvaluations, linkedEvaluationIds])

  const evalCoverage = useMemo(
    () =>
      buildStrategyEvalCoverage({
        subscriptionIds: effectiveSubscriptionIds,
        regionIds: candidateRegions,
        matchingEvaluations: linkableEvaluations,
        linkedEvaluationIds,
      }),
    [effectiveSubscriptionIds, candidateRegions, linkableEvaluations, linkedEvaluationIds],
  )

  const skuGaps = useMemo(
    () =>
      collectStrategySkuGaps({
        evaluations: linkedMatchingEvaluations,
        constraints,
        regionIds: candidateRegions,
      }),
    [linkedMatchingEvaluations, constraints, candidateRegions],
  )

  const quotaRecommendations = useMemo(
    () =>
      customerId
        ? buildStrategyQuotaRecommendations({
            customerId,
            subscriptionIds: effectiveSubscriptionIds,
            regionIds: candidateRegions,
            quotas,
            quotaGroupLimits,
            projectedExtraVcpu: whatIfPlan?.projectedVcpu,
          })
        : [],
    [
      customerId,
      effectiveSubscriptionIds,
      candidateRegions,
      quotas,
      quotaGroupLimits,
      whatIfPlan?.projectedVcpu,
    ],
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
    setWhatIfSelection(emptyWhatIfSelection())
    setExpansionDraft({})
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
    setWhatIfSelection(
      scenario.whatIfSelection && typeof scenario.whatIfSelection === 'object'
        ? {
            targetRegionId: scenario.whatIfSelection.targetRegionId || '',
            selectedItemIds: scenario.whatIfSelection.selectedItemIds || [],
            ignoredDependencyIds: scenario.whatIfSelection.ignoredDependencyIds || [],
            expansionAdds: scenario.whatIfSelection.expansionAdds || [],
          }
        : emptyWhatIfSelection(scenario.candidateRegionIds?.[0] || ''),
    )
    setExpansionDraft({})
    setLinkedEvaluationIds(scenario.linkedEvaluationIds || [])
    setScenarioName(scenario.name)
    setScenarioNotes(scenario.notes || '')
    setStatusNote(`Loaded scenario “${scenario.name}”.`)
    setError(null)
  }

  const toggleMoveItem = (itemId: string) => {
    setWhatIfSelection((prev) => {
      const selected = new Set(prev.selectedItemIds)
      if (selected.has(itemId)) selected.delete(itemId)
      else selected.add(itemId)
      return { ...prev, selectedItemIds: [...selected] }
    })
  }

  const toggleIgnoreDependency = (itemId: string) => {
    setWhatIfSelection((prev) => {
      const ignored = new Set(prev.ignoredDependencyIds)
      if (ignored.has(itemId)) ignored.delete(itemId)
      else ignored.add(itemId)
      return { ...prev, ignoredDependencyIds: [...ignored] }
    })
  }

  const selectAllInCategory = (resourceType: string, select: boolean) => {
    const ids = workloadItems
      .filter((item) => item.resourceType === resourceType)
      .map((item) => item.id)
    setWhatIfSelection((prev) => {
      const selected = new Set(prev.selectedItemIds)
      for (const id of ids) {
        if (select) selected.add(id)
        else selected.delete(id)
      }
      return { ...prev, selectedItemIds: [...selected] }
    })
  }

  const addExpansionResource = (resourceType: string) => {
    const draft = expansionDraft[resourceType] || { sku: '', size: '', count: '1' }
    const sku = draft.sku.trim()
    const count = Math.max(1, Math.floor(Number(draft.count) || 0))
    if (!sku) {
      setError(`Enter a SKU to add an expansion resource for ${resourceType}.`)
      return
    }
    const add: WhatIfExpansionAdd = {
      id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      resourceType,
      sku,
      size: draft.size.trim() || undefined,
      count,
    }
    setWhatIfSelection((prev) => ({
      ...prev,
      expansionAdds: [...prev.expansionAdds, add],
    }))
    setExpansionDraft((prev) => ({
      ...prev,
      [resourceType]: { sku: '', size: '', count: '1' },
    }))
    setError(null)
  }

  const removeExpansionResource = (id: string) => {
    setWhatIfSelection((prev) => ({
      ...prev,
      expansionAdds: prev.expansionAdds.filter((row) => row.id !== id),
    }))
  }

  const onSaveScenario = async () => {
    if (!selectedCustomer) {
      setError('Select a customer first.')
      return
    }
    const name = scenarioName.trim() || `Strategy ${formatDate(new Date().toISOString())}`
    const safeLinkedIds = pruneLinkedEvaluationIds(linkedEvaluationIds, linkableEvaluations)
    const selectionToSave: WhatIfSelection = {
      ...whatIfSelection,
      targetRegionId: whatIfTarget?.id || whatIfSelection.targetRegionId,
    }
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
        whatIfPercent: 0,
        whatIfSelection: selectionToSave,
        linkedEvaluationIds: safeLinkedIds,
        createdByUserId: user?.id || null,
        createdByName: user?.name || null,
      })
      setActiveScenarioId(scenario.id)
      setScenarioName(scenario.name)
      setLinkedEvaluationIds(scenario.linkedEvaluationIds || safeLinkedIds)
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
            field: 'What-if target',
            value: whatIfTarget?.label || 'n/a',
          },
          {
            field: 'What-if',
            value: whatIfPlan
              ? `Move ${whatIfPlan.moveItemCount} + deps ${whatIfPlan.dependencyItemCount} + expansion ${whatIfPlan.expansionItemCount} → ${whatIfPlan.projectedItemCount} resources / ${whatIfPlan.projectedVcpu} vCPU in ${whatIfTarget?.label || 'n/a'}`
              : 'n/a',
          },
          {
            field: 'Matching evaluations',
            value: `${evalCoverage.matchingCount} match · ${evalCoverage.linkedMatchingCount} linked`,
          },
          {
            field: 'SKU gaps',
            value: `${skuGaps.filter((g) => g.status !== 'available').length} unavailable/restricted · ${skuGaps.filter((g) => g.constrained).length} constrained`,
          },
          {
            field: 'Quota recommendations',
            value: quotaRecommendations.length,
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
        name: 'Dependencies',
        columns: [
          { key: 'subscriptionName', label: 'Subscription' },
          { key: 'regionLabel', label: 'Region' },
          { key: 'resourceType', label: 'Service' },
          { key: 'count', label: 'Count' },
          { key: 'pairedWithPresent', label: 'Paired present' },
          { key: 'note', label: 'Note' },
        ],
        rows: dependencySlices.flatMap((slice) =>
          slice.services.map((service) => ({
            subscriptionName: slice.subscriptionName,
            regionLabel: slice.regionLabel,
            resourceType: service.resourceType,
            count: service.count,
            pairedWithPresent: service.pairedWithPresent.join(', '),
            note: service.note,
          })),
        ),
      },
      {
        name: 'What-if',
        columns: [
          { key: 'field', label: 'Field' },
          { key: 'value', label: 'Value' },
        ],
        rows: whatIfPlan
          ? [
              { field: 'Target region', value: whatIfTarget?.label || '' },
              { field: 'Selected to move', value: whatIfPlan.moveItemCount },
              { field: 'Dependencies included', value: whatIfPlan.dependencyItemCount },
              { field: 'Dependencies ignored', value: whatIfPlan.ignoredDependencyCount },
              { field: 'Expansion adds', value: whatIfPlan.expansionItemCount },
              { field: 'Projected resources', value: whatIfPlan.projectedItemCount },
              { field: 'Projected vCPU', value: whatIfPlan.projectedVcpu },
              ...whatIfPlan.byServiceCategory.map((c) => ({
                field: `Category: ${c.resourceType}`,
                value: `move ${c.moveCount} · deps ${c.dependencyCount} · expansion ${c.expansionCount} · total ${c.projectedCount}`,
              })),
              ...whatIfPlan.bySkuFamily.map((f) => ({
                field: `SKU family: ${f.family}`,
                value: f.projectedCount,
              })),
              ...whatIfPlan.quotaWatch.map((q) => ({
                field: `Quota: ${q.name} (${q.region})`,
                value: `${q.usage}/${q.limit} (${q.usagePct}%) +${q.projectedExtra} — ${q.note}`,
              })),
            ]
          : [{ field: 'Status', value: 'No what-if plan available' }],
      },
      {
        name: 'SKU gaps',
        columns: [
          { key: 'regionLabel', label: 'Region' },
          { key: 'resourceType', label: 'Resource type' },
          { key: 'sku', label: 'SKU' },
          { key: 'status', label: 'Availability' },
          { key: 'constrained', label: 'Constrained' },
          { key: 'resourceCount', label: 'Count' },
          { key: 'reason', label: 'Reason' },
        ],
        rows: skuGaps.map((g) => ({
          regionLabel: g.regionLabel,
          resourceType: g.resourceType,
          sku: g.sku,
          status: g.status,
          constrained: g.constrained ? 'Yes' : 'No',
          resourceCount: g.resourceCount,
          reason: g.reason,
        })),
      },
      {
        name: 'Quota recommendations',
        columns: [
          { key: 'priority', label: 'Priority' },
          { key: 'source', label: 'Source' },
          { key: 'name', label: 'Quota' },
          { key: 'region', label: 'Region' },
          { key: 'usagePct', label: 'Usage %' },
          { key: 'limit', label: 'Current limit' },
          { key: 'suggestedLimit', label: 'Suggested limit' },
          { key: 'increaseBy', label: 'Increase by' },
          { key: 'rationale', label: 'Rationale' },
        ],
        rows: quotaRecommendations.map((r) => ({
          priority: r.priority,
          source: r.source === 'quotaGroup' ? 'Quota group' : 'Quota',
          name: r.name,
          region: r.region,
          usagePct: r.usagePct,
          limit: r.limit,
          suggestedLimit: r.suggestedLimit,
          increaseBy: r.increaseBy,
          rationale: r.rationale,
        })),
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
            action: evalCoverage.hasMatchingEvaluation
              ? `Link matching evaluation(s) covering ${evalCoverage.coveredRegions.join(', ') || 'candidate regions'}.`
              : 'Run Region evaluation for the selected subscriptions and candidate regions, then link it here.',
          },
          {
            owner: 'CSA + customer',
            action: `Validate what-if move set (${whatIfPlan?.moveItemCount || 0} selected, ${whatIfPlan?.dependencyItemCount || 0} deps) into ${whatIfTarget?.label || 'target region'}.`,
          },
          {
            owner: 'CSA + customer',
            action: `Confirm paired services in each subscription/region slice (${dependencySlices
              .slice(0, 3)
              .map((s) => `${s.subscriptionName}/${s.regionLabel}`)
              .join(', ') || 'current scope'}).`,
          },
          {
            owner: 'CSA',
            action:
              quotaRecommendations.length > 0
                ? `Request quota adjustments: ${quotaRecommendations
                    .slice(0, 3)
                    .map((r) => `${r.name} in ${r.region} → ${r.suggestedLimit}`)
                    .join('; ')}.`
                : 'Confirm quota headroom in candidate regions before expansion.',
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
            Plan multiregion paths from live inventory: footprint, dependencies, selective
            what-if moves with dependencies and expansion adds, and saved scenarios.
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
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!canLaunchEvaluation}
            onClick={launchRegionEvaluation}
          >
            <MapPinned size={16} />
            Run evaluation
          </button>
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

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Dependency &amp; paired-service map</h4>
            <p>
              Only services found in each selected subscription + region pair. Pairing hints are
              limited to other services present in that same pair.
            </p>
          </div>
        </div>
        <div className="panel-body">
          {dependencySlices.length === 0 ? (
            <div className="empty">No inventory services in the current subscription / region scope.</div>
          ) : (
            <div className="strategy-dep-grid">
              {dependencySlices.map((slice) => (
                <div key={slice.key} className="strategy-dep-card">
                  <div className="strategy-dep-top">
                    <strong>
                      {slice.subscriptionName}
                      <span className="muted"> · {slice.regionLabel}</span>
                    </strong>
                    <span className="pill pill-ok">
                      {slice.services.length} service{slice.services.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="muted strategy-dep-regions">
                    {slice.itemCount} resource{slice.itemCount === 1 ? '' : 's'} in this pair
                  </div>
                  <ul className="strategy-dep-service-list">
                    {slice.services.map((service) => (
                      <li key={service.resourceType}>
                        <div className="strategy-dep-service-row">
                          <strong>{service.resourceType}</strong>
                          <span className="muted">×{service.count}</span>
                        </div>
                        {service.pairedWithPresent.length > 0 ? (
                          <div className="strategy-dep-pairs">
                            Pairs with here: {service.pairedWithPresent.join(', ')}
                          </div>
                        ) : (
                          <div className="muted strategy-dep-pairs">No paired services in this pair</div>
                        )}
                      </li>
                    ))}
                  </ul>
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
              Choose a target region, select resources by service category to move, review auto-
              selected dependencies (ignore any that should stay), and add expansion capacity per
              category.
            </p>
          </div>
          <label className="field strategy-whatif-target">
            <span>Target region</span>
            <select
              value={whatIfTarget?.id || ''}
              onChange={(e) =>
                setWhatIfSelection((prev) => ({ ...prev, targetRegionId: e.target.value }))
              }
              disabled={candidateRegions.length === 0}
            >
              {candidateRegions.length === 0 ? (
                <option value="">Select candidate regions first</option>
              ) : (
                candidateRegions.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.label}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>
        <div className="panel-body stack">
          {!customerId || workloadItems.length === 0 ? (
            <div className="empty">Select a customer with inventory to plan what-if moves.</div>
          ) : (
            <>
              <div className="strategy-stat-row">
                <div className="strategy-stat-card">
                  <span className="muted">Selected to move</span>
                  <strong>{whatIfPlan?.moveItemCount || 0}</strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">Dependencies included</span>
                  <strong>
                    {whatIfPlan?.dependencyItemCount || 0}
                    {(whatIfPlan?.ignoredDependencyCount || 0) > 0 ? (
                      <span className="muted"> · {whatIfPlan?.ignoredDependencyCount} ignored</span>
                    ) : null}
                  </strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">Expansion adds</span>
                  <strong>{whatIfPlan?.expansionItemCount || 0}</strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">Projected vCPU</span>
                  <strong>{whatIfPlan?.projectedVcpu || 0}</strong>
                </div>
              </div>

              {suggestedDependencies.length > 0 ? (
                <div className="strategy-whatif-deps">
                  <h6>Dependencies from selection</h6>
                  <p className="muted">
                    Included automatically with selected moves. Ignore any dependency that should
                    not move to {whatIfTarget?.label || 'the target region'}.
                  </p>
                  <ul className="strategy-whatif-dep-list">
                    {suggestedDependencies.map((item) => {
                      const ignored = whatIfSelection.ignoredDependencyIds.includes(item.id)
                      return (
                        <li key={item.id} className={ignored ? 'is-ignored' : ''}>
                          <label className="strategy-whatif-check">
                            <input
                              type="checkbox"
                              checked={!ignored}
                              onChange={() => toggleIgnoreDependency(item.id)}
                            />
                            <span>
                              <strong>{item.name}</strong>
                              <span className="muted">
                                {' '}
                                · {item.resourceType} · {item.sku}
                                {item.resourceGroup ? ` · ${item.resourceGroup}` : ''}
                              </span>
                            </span>
                          </label>
                          <span className="muted strategy-whatif-dep-note">
                            {dependencyNoteForType(item.resourceType)}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ) : null}

              <div className="strategy-whatif-categories">
                {serviceCategories.map((category) => {
                  const selectedInCategory = category.items.filter((item) =>
                    whatIfSelection.selectedItemIds.includes(item.id),
                  ).length
                  const draft = expansionDraft[category.resourceType] || {
                    sku: '',
                    size: '',
                    count: '1',
                  }
                  const adds = whatIfSelection.expansionAdds.filter(
                    (row) => row.resourceType === category.resourceType,
                  )
                  return (
                    <div key={category.resourceType} className="strategy-whatif-category">
                      <div className="strategy-whatif-category-head">
                        <div>
                          <strong>{category.resourceType}</strong>
                          <div className="muted">
                            {selectedInCategory}/{category.count} selected · ~{category.vcpuEstimate}{' '}
                            vCPU in inventory
                          </div>
                        </div>
                        <div className="strategy-whatif-category-actions">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => selectAllInCategory(category.resourceType, true)}
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => selectAllInCategory(category.resourceType, false)}
                          >
                            Clear
                          </button>
                        </div>
                      </div>

                      <ul className="strategy-whatif-resource-list">
                        {category.items.map((item) => (
                          <li key={item.id}>
                            <label className="strategy-whatif-check">
                              <input
                                type="checkbox"
                                checked={whatIfSelection.selectedItemIds.includes(item.id)}
                                onChange={() => toggleMoveItem(item.id)}
                              />
                              <span>
                                <strong>{item.name}</strong>
                                <span className="muted">
                                  {' '}
                                  · {item.sku}
                                  {item.size ? ` / ${item.size}` : ''} · {prettyRegion(item.region)}
                                  {item.resourceGroup ? ` · ${item.resourceGroup}` : ''}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>

                      <div className="strategy-whatif-expansion">
                        <h6>Expansion adds</h6>
                        {adds.length > 0 ? (
                          <ul className="strategy-plain-list">
                            {adds.map((row) => (
                              <li key={row.id} className="strategy-whatif-expansion-row">
                                <span>
                                  {row.count}× {row.sku}
                                  {row.size ? ` / ${row.size}` : ''}
                                </span>
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  onClick={() => removeExpansionResource(row.id)}
                                >
                                  <Trash2 size={14} /> Remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">No expansion capacity added for this category yet.</p>
                        )}
                        <div className="strategy-whatif-add-grid">
                          <label className="field">
                            <span>SKU</span>
                            <input
                              value={draft.sku}
                              onChange={(e) =>
                                setExpansionDraft((prev) => ({
                                  ...prev,
                                  [category.resourceType]: { ...draft, sku: e.target.value },
                                }))
                              }
                              placeholder="e.g. Standard_D4s_v5"
                            />
                          </label>
                          <label className="field">
                            <span>Size (optional)</span>
                            <input
                              value={draft.size}
                              onChange={(e) =>
                                setExpansionDraft((prev) => ({
                                  ...prev,
                                  [category.resourceType]: { ...draft, size: e.target.value },
                                }))
                              }
                              placeholder="Optional"
                            />
                          </label>
                          <label className="field">
                            <span>Count</span>
                            <input
                              type="number"
                              min={1}
                              value={draft.count}
                              onChange={(e) =>
                                setExpansionDraft((prev) => ({
                                  ...prev,
                                  [category.resourceType]: { ...draft, count: e.target.value },
                                }))
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => addExpansionResource(category.resourceType)}
                          >
                            <Plus size={16} /> Add to scenario
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {whatIfPlan && whatIfPlan.quotaWatch.length > 0 ? (
                <div>
                  <h6>Quota watch ({whatIfTarget?.label || 'target'})</h6>
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
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4 className="strategy-panel-title">
              <ShieldAlert size={18} />
              Evaluation, quotas &amp; SKU gaps
            </h4>
            <p>
              Strategies use matching region evaluations (same subscription + candidate region) plus
              quotas / quota groups to surface unavailability, constraints, and quota raises.
            </p>
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!canLaunchEvaluation}
            onClick={launchRegionEvaluation}
          >
            <MapPinned size={16} />
            Run evaluation
          </button>
        </div>
        <div className="panel-body stack">
          {!customerId ? (
            <div className="empty">Select a customer and subscriptions to assess evaluation coverage.</div>
          ) : (
            <>
              <div className="strategy-stat-row">
                <div className="strategy-stat-card">
                  <span className="muted">Matching evaluations</span>
                  <strong>{evalCoverage.matchingCount}</strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">Linked (matching)</span>
                  <strong>{evalCoverage.linkedMatchingCount}</strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">SKU gaps</span>
                  <strong>{skuGaps.length}</strong>
                </div>
                <div className="strategy-stat-card">
                  <span className="muted">Quota raises</span>
                  <strong>{quotaRecommendations.length}</strong>
                </div>
              </div>

              <div
                className={`banner ${
                  evalCoverage.hasMatchingEvaluation ? 'banner-ok' : 'banner-error'
                }`}
              >
                {evalCoverage.hasMatchingEvaluation ? (
                  <>
                    {evalCoverage.matchingCount} evaluation
                    {evalCoverage.matchingCount === 1 ? '' : 's'} match this strategy’s subscriptions
                    and candidate regions
                    {evalCoverage.linkedMatchingCount === 0
                      ? ' — link one below to pin it to the scenario.'
                      : '.'}
                    {evalCoverage.uncoveredRegions.length > 0
                      ? ` Uncovered regions: ${evalCoverage.uncoveredRegions.join(', ')}.`
                      : ''}
                    {evalCoverage.uncoveredSubscriptions.length > 0
                      ? ` Uncovered subscriptions: ${evalCoverage.uncoveredSubscriptions.length}.`
                      : ''}
                  </>
                ) : (
                  <>
                    No saved evaluation matches the selected subscription(s) and candidate region(s).
                    Run a region evaluation for this scope, then link it here.
                  </>
                )}
              </div>

              <CheckboxMultiSelect
                label="Linked evaluations (subscription + region match only)"
                options={linkableEvaluations.map((ev) => ({
                  value: ev.id,
                  label: `${formatDate(ev.createdAt)} · ${(ev.subscriptionNames || [])
                    .slice(0, 2)
                    .join(', ') || `${ev.subscriptionIds?.length || 0} sub(s)`} · ${(
                    ev.targetRegions || []
                  )
                    .map((r) => r.label || r.id)
                    .slice(0, 3)
                    .join(', ')}`,
                }))}
                value={linkedEvaluationIds}
                onChange={setLinkedEvaluationIds}
                placeholder={
                  !customerId
                    ? 'Select customer first'
                    : linkableEvaluations.length === 0
                      ? 'No matching evaluations'
                      : 'None linked yet'
                }
                disabled={!customerId || linkableEvaluations.length === 0}
                emptyLabel="No evaluations match this subscription + region scope"
              />

              <div className="strategy-detail-cols">
                <div>
                  <h6 className="strategy-section-heading">
                    <Link2 size={14} /> SKU unavailability &amp; constraints
                  </h6>
                  {skuGaps.length === 0 ? (
                    <p className="muted">
                      {evalCoverage.hasMatchingEvaluation
                        ? 'No availability or constraint gaps in matching evaluation results for candidate regions.'
                        : 'Gaps appear after a matching evaluation exists for this scope.'}
                    </p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Region</th>
                            <th>SKU</th>
                            <th>Status</th>
                            <th>Issue</th>
                          </tr>
                        </thead>
                        <tbody>
                          {skuGaps.slice(0, 12).map((gap) => (
                            <tr key={`${gap.evaluationId}-${gap.regionId}-${gap.sku}-${gap.size || ''}`}>
                              <td>{gap.regionLabel}</td>
                              <td>
                                <strong>{gap.sku}</strong>
                                <div className="muted">{gap.resourceType}</div>
                              </td>
                              <td>
                                <span
                                  className={`pill ${
                                    gap.status === 'available' ? 'pill-ok' : 'pill-critical'
                                  }`}
                                >
                                  {gap.status}
                                </span>
                                {gap.constrained ? (
                                  <span className="pill pill-high" style={{ marginLeft: '0.35rem' }}>
                                    Constrained
                                  </span>
                                ) : null}
                              </td>
                              <td className="muted">{gap.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div>
                  <h6 className="strategy-section-heading">Quota &amp; quota-group adjustments</h6>
                  {quotaRecommendations.length === 0 ? (
                    <p className="muted">
                      No elevated quota or quota-group pressure for the selected subscriptions and
                      candidate regions
                      {whatIfPlan ? ' (including what-if projection)' : ''}.
                    </p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Priority</th>
                            <th>Quota</th>
                            <th>Usage</th>
                            <th>Suggest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {quotaRecommendations.slice(0, 10).map((rec) => (
                            <tr key={`${rec.source}-${rec.name}-${rec.region}`}>
                              <td>
                                <span
                                  className={`pill ${
                                    rec.priority === 'critical'
                                      ? 'pill-critical'
                                      : rec.priority === 'high'
                                        ? 'pill-high'
                                        : 'pill-neutral'
                                  }`}
                                >
                                  {rec.priority}
                                </span>
                              </td>
                              <td>
                                <strong>{rec.name}</strong>
                                <div className="muted">
                                  {rec.source === 'quotaGroup' ? 'Quota group' : 'Quota'} ·{' '}
                                  {rec.region}
                                  {rec.subscriptionHint ? ` · ${rec.subscriptionHint}` : ''}
                                </div>
                              </td>
                              <td>
                                {rec.usage}/{rec.limit} ({rec.usagePct}%)
                              </td>
                              <td>
                                → {rec.suggestedLimit}
                                {rec.increaseBy > 0 ? (
                                  <span className="muted"> (+{rec.increaseBy})</span>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
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
                    <th>Linked evals</th>
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
                      <td>{s.linkedEvaluationIds?.length || 0}</td>
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
