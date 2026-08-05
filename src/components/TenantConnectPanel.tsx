import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Copy,
  Gauge,
  Layers,
  Link2,
  LoaderCircle,
  LogOut,
  PlugZap,
} from 'lucide-react'
import { CheckboxMultiSelect } from './CheckboxMultiSelect'
import { RetrievalLogEntryView } from './RetrievalLogEntryView'
import { useApp } from '../context/AppContext'
import {
  cancelAzureLogin,
  connectTenant,
  disconnectTenant,
  fetchDeployedRegions,
  fetchSubscriptions,
  fetchTenantInfo,
  getAzureStatus,
  setSubscription,
  type AzureConnection,
  type AzureRegionOption,
  type AzureSubscriptionOption,
} from '../lib/azureApi'
import { clearPersistedConnection } from '../lib/dataApi'
import { formatDate, formatHoursAgo, isWithinDays, maxIsoDate } from '../lib/format'
import type { Customer } from '../types'

const RECENT_RETRIEVAL_DAYS = 2

export function TenantConnectPanel() {
  const {
    customers,
    subscriptions: pcmSubscriptions,
    inventory,
    quotas,
    upsertTenantCustomer,
    ensureSubscription,
    savePersistedConnection,
    setAzureSession,
    clearAzureSession,
    loadAzureLocations,
    ensureAzureSession,
    azureSessionReady,
    azureConnection,
    azureConnectWorkspace,
    patchAzureConnectWorkspace,
    resetAzureConnectWorkspace,
    persistedConnection,
    refreshBootstrap,
    startInventoryRetrieval,
    startQuotaRetrieval,
    collectQuotaGroups,
    isRetrievalRunning,
    retrievalJobs,
    retrievalLog,
  } = useApp()

  const [tenantId, setTenantId] = useState(persistedConnection?.tenantId || '')
  const [connection, setConnection] = useState<AzureConnection | null>(azureConnection)
  const [busy, setBusy] = useState(false)
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusNote, setStatusNote] = useState<string | null>(null)
  const [regions, setRegions] = useState<string[]>(azureConnectWorkspace.selectedRegionIds)
  const [availableRegions, setAvailableRegions] = useState<AzureRegionOption[]>(
    azureConnectWorkspace.availableRegions,
  )
  const [loadingRegions, setLoadingRegions] = useState(false)
  const [copied, setCopied] = useState(false)
  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionOption[]>(
    azureConnectWorkspace.subscriptions,
  )
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<string[]>(
    azureConnectWorkspace.selectedSubscriptionIds.length > 0
      ? azureConnectWorkspace.selectedSubscriptionIds
      : persistedConnection?.selectedSubscriptionId
        ? [persistedConnection.selectedSubscriptionId]
        : [],
  )
  const [linkedCustomer, setLinkedCustomer] = useState<Customer | null>(() => {
    if (!azureConnectWorkspace.linkedCustomerId) return null
    return customers.find((c) => c.id === azureConnectWorkspace.linkedCustomerId) || null
  })
  const [orgName, setOrgName] = useState<string | null>(
    azureConnectWorkspace.orgName || persistedConnection?.organizationName || null,
  )
  const [sessionReady, setSessionReady] = useState(
    Boolean(azureSessionReady && azureConnectWorkspace.subscriptions.length > 0),
  )
  const [startingInventory, setStartingInventory] = useState(false)
  const [startingQuotas, setStartingQuotas] = useState(false)
  const [startingQuotaGroups, setStartingQuotaGroups] = useState(false)
  const [activityExpanded, setActivityExpanded] = useState(false)
  const pollRef = useRef<number | null>(null)
  const restoreAttemptedRef = useRef(false)
  const collectLockRef = useRef<{ inventory: boolean; quotas: boolean }>({
    inventory: false,
    quotas: false,
  })

  function syncWorkspace(patch: {
    subscriptions?: AzureSubscriptionOption[]
    selectedSubscriptionIds?: string[]
    availableRegions?: AzureRegionOption[]
    selectedRegionIds?: string[]
    linkedCustomerId?: string | null
    orgName?: string | null
  }) {
    patchAzureConnectWorkspace(patch)
  }

  const loadingInventory = startingInventory || isRetrievalRunning('inventory')
  const loadingQuotas = startingQuotas || isRetrievalRunning('quotas')
  const loadingQuotaGroups = startingQuotaGroups

  const customerJobs = useMemo(() => {
    if (!linkedCustomer) return []
    return retrievalJobs
      .filter((job) => job.customerId === linkedCustomer.id)
      .slice(0, 6)
  }, [retrievalJobs, linkedCustomer])

  const customerLog = useMemo(() => {
    if (!linkedCustomer) return []
    return retrievalLog
      .filter((entry) => entry.customerId === linkedCustomer.id)
      .slice(0, 80)
  }, [retrievalLog, linkedCustomer])

  const hasActiveCustomerJobs = customerJobs.some(
    (job) => job.status === 'running' || job.status === 'queued',
  )

  useEffect(() => {
    if (hasActiveCustomerJobs) setActivityExpanded(true)
  }, [hasActiveCustomerJobs])

  const lastSurfacedFailRef = useRef<string | null>(null)
  useEffect(() => {
    const failed = customerJobs.find(
      (job) =>
        job.error &&
        (job.status === 'failed' || job.status === 'partial') &&
        job.finishedAt,
    )
    if (!failed?.error || lastSurfacedFailRef.current === failed.id) return
    lastSurfacedFailRef.current = failed.id
    setActivityExpanded(true)
    setError(failed.error)
    setStatusNote(
      `${failed.kind === 'inventory' ? 'Inventory' : 'Quota'} retrieval ${failed.status}. See activity log for details.`,
    )
  }, [customerJobs])

  const subscriptionRetrievalDates = useMemo(() => {
    const byAzureId = new Map<
      string,
      { inventoryAt: string | null; quotasAt: string | null }
    >()

    function resolveAzureId(pcmOrAzureId: string | null | undefined): string | null {
      if (!pcmOrAzureId) return null
      const pcmSub = pcmSubscriptions.find(
        (s) =>
          s.id === pcmOrAzureId ||
          s.subscriptionId.toLowerCase() === pcmOrAzureId.toLowerCase(),
      )
      if (pcmSub) return pcmSub.subscriptionId
      if (pcmOrAzureId.startsWith('s-live-')) return pcmOrAzureId.slice('s-live-'.length)
      // Likely already an Azure GUID
      if (pcmOrAzureId.includes('-') && pcmOrAzureId.length >= 32) return pcmOrAzureId
      return null
    }

    function touch(
      azureId: string,
      kind: 'inventoryAt' | 'quotasAt',
      collectedAt: string,
    ) {
      const key = azureId.toLowerCase()
      const prev = byAzureId.get(key) || { inventoryAt: null, quotasAt: null }
      prev[kind] = maxIsoDate([prev[kind], collectedAt])
      byAzureId.set(key, prev)
    }

    for (const item of inventory) {
      if (linkedCustomer && item.customerId !== linkedCustomer.id) continue
      if (!item.collectedAt) continue
      const azureId = resolveAzureId(item.subscriptionId)
      if (azureId) touch(azureId, 'inventoryAt', item.collectedAt)
    }

    for (const q of quotas) {
      if (linkedCustomer && q.customerId && q.customerId !== linkedCustomer.id) continue
      if (!q.collectedAt) continue
      const azureId = resolveAzureId(q.azureSubscriptionId) || resolveAzureId(q.subscriptionId)
      if (azureId) touch(azureId, 'quotasAt', q.collectedAt)
    }

    return byAzureId
  }, [inventory, quotas, pcmSubscriptions, linkedCustomer])

  const subscriptionOptions = useMemo(
    () =>
      subscriptions.map((sub) => {
        const dates = subscriptionRetrievalDates.get(sub.id.toLowerCase())
        const invLabel = dates?.inventoryAt
          ? `Inventory ${formatDate(dates.inventoryAt)}`
          : 'Inventory never'
        const quotaLabel = dates?.quotasAt
          ? `Quotas ${formatDate(dates.quotasAt)}`
          : 'Quotas never'
        return {
          value: sub.id,
          label: `${sub.name}${sub.isDefault ? ' (default)' : ''}`,
          hint: `${sub.id} · ${invLabel} · ${quotaLabel}`,
        }
      }),
    [subscriptions, subscriptionRetrievalDates],
  )

  const regionOptions = useMemo(
    () =>
      availableRegions.map((region) => ({
        value: region.id,
        label: region.label,
        hint: `${region.resourceCount.toLocaleString()} resource${
          region.resourceCount === 1 ? '' : 's'
        }`,
      })),
    [availableRegions],
  )

  const loadDeployedRegions = useCallback(async (subscriptionIds: string[]) => {
    if (subscriptionIds.length === 0) {
      setAvailableRegions([])
      setRegions([])
      patchAzureConnectWorkspace({ availableRegions: [], selectedRegionIds: [] })
      return
    }
    setLoadingRegions(true)
    try {
      const data = await fetchDeployedRegions(subscriptionIds)
      const nextRegions = data.regions || []
      setAvailableRegions(nextRegions)
      setRegions((prev) => {
        const ids = nextRegions.map((r) => r.id)
        const kept = prev.filter((id) => ids.includes(id))
        const nextSelected = kept.length > 0 ? kept : ids
        patchAzureConnectWorkspace({
          availableRegions: nextRegions,
          selectedRegionIds: nextSelected,
        })
        return nextSelected
      })
      if (data.hint && nextRegions.length === 0) {
        setStatusNote(data.hint)
      }
    } catch (err) {
      setAvailableRegions([])
      setError(
        `Region discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setLoadingRegions(false)
    }
  }, [patchAzureConnectWorkspace])

  const selectedInventoryLastAt = useMemo(() => {
    return maxIsoDate(
      selectedSubscriptionIds.map(
        (id) => subscriptionRetrievalDates.get(id.toLowerCase())?.inventoryAt,
      ),
    )
  }, [selectedSubscriptionIds, subscriptionRetrievalDates])

  const selectedQuotasLastAt = useMemo(() => {
    return maxIsoDate(
      selectedSubscriptionIds.map(
        (id) => subscriptionRetrievalDates.get(id.toLowerCase())?.quotasAt,
      ),
    )
  }, [selectedSubscriptionIds, subscriptionRetrievalDates])

  const inventoryRecentTip =
    selectedInventoryLastAt && isWithinDays(selectedInventoryLastAt, RECENT_RETRIEVAL_DAYS)
      ? `Last inventory retrieval was ${formatHoursAgo(selectedInventoryLastAt)}.`
      : null

  const quotasRecentTip =
    selectedQuotasLastAt && isWithinDays(selectedQuotasLastAt, RECENT_RETRIEVAL_DAYS)
      ? `Last quota retrieval was ${formatHoursAgo(selectedQuotasLastAt)}.`
      : null

  useEffect(() => {
    if (!persistedConnection?.tenantId) return
    setTenantId(persistedConnection.tenantId)
    setOrgName((prev) => prev || persistedConnection.organizationName || null)
    if (persistedConnection.selectedSubscriptionId) {
      setSelectedSubscriptionIds((prev) =>
        prev.length > 0 ? prev : [persistedConnection.selectedSubscriptionId!],
      )
    }
    const match = customers.find((c) => c.tenantId === persistedConnection.tenantId)
    if (match) setLinkedCustomer((prev) => prev || match)
  }, [persistedConnection, customers])

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  const finalizeLogin = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const info = await fetchTenantInfo()
      const tenant =
        info.account?.tenantId ||
        info.organization?.id ||
        connection?.tenantId ||
        tenantId
      if (!tenant) throw new Error('Could not resolve tenant id after login')

      const displayName =
        info.organization?.displayName ||
        info.account?.name ||
        `Tenant ${tenant.slice(0, 8)}`
      const domain =
        info.organization?.verifiedDomains?.find((d) => d.isDefault)?.name ||
        info.organization?.verifiedDomains?.[0]?.name

      const customer = await upsertTenantCustomer({
        tenantId: tenant,
        name: displayName,
        domain,
      })
      setLinkedCustomer(customer)
      setOrgName(displayName)

      setLoadingSubscriptions(true)
      const subData = await fetchSubscriptions()
      setSubscriptions(subData.subscriptions)
      const cachedIds = azureConnectWorkspace.selectedSubscriptionIds.filter((id) =>
        subData.subscriptions.some((s) => s.id === id),
      )
      const savedId = persistedConnection?.selectedSubscriptionId
      const initialIds =
        cachedIds.length > 0
          ? cachedIds
          : savedId && subData.subscriptions.some((s) => s.id === savedId)
            ? [savedId]
            : subData.selectedSubscriptionId
              ? [subData.selectedSubscriptionId]
              : subData.subscriptions.map((s) => s.id)
      setSelectedSubscriptionIds(initialIds)
      syncWorkspace({
        subscriptions: subData.subscriptions,
        selectedSubscriptionIds: initialIds,
        linkedCustomerId: customer.id,
        orgName: displayName,
      })

      for (const subscriptionId of initialIds) {
        const sub = subData.subscriptions.find((s) => s.id === subscriptionId)
        await ensureSubscription(customer.id, {
          subscriptionId,
          name: sub?.name || subscriptionId,
          regions: [],
        })
      }

      const primaryId = initialIds[0] || ''
      if (primaryId) {
        await setSubscription(primaryId)
      }

      await loadDeployedRegions(initialIds)

      await savePersistedConnection({
        tenantId: customer.tenantId,
        organizationName: customer.name,
        selectedSubscriptionId: primaryId || null,
        selectedSubscriptionName:
          initialIds.length > 1
            ? `${initialIds.length} subscriptions`
            : subData.subscriptions.find((s) => s.id === primaryId)?.name || null,
        account: info.account || null,
        status: 'connected',
      })

      const nextConnection: AzureConnection = {
        status: 'connected',
        tenantId: customer.tenantId,
        deviceCode: null,
        verificationUrl: 'https://microsoft.com/devicelogin',
        message:
          'Tenant connected. Select subscriptions and regions, then collect inventory, quotas, or quota groups.',
        error: null,
        account: info.account || null,
        startedAt: null,
        connectedAt: new Date().toISOString(),
      }
      setConnection(nextConnection)
      setSessionReady(true)
      setAzureSession(nextConnection, true)
      void loadAzureLocations(true)
      await refreshBootstrap()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSessionReady(false)
      setAzureSession(null, false)
    } finally {
      setLoadingSubscriptions(false)
      setBusy(false)
    }
  }, [
    connection?.tenantId,
    tenantId,
    upsertTenantCustomer,
    ensureSubscription,
    savePersistedConnection,
    setAzureSession,
    loadAzureLocations,
    patchAzureConnectWorkspace,
    azureConnectWorkspace.selectedSubscriptionIds,
    persistedConnection?.selectedSubscriptionId,
    refreshBootstrap,
    loadDeployedRegions,
  ])

  useEffect(() => {
    if (restoreAttemptedRef.current) return
    if (sessionReady && subscriptions.length > 0) {
      restoreAttemptedRef.current = true
      return
    }

    let cancelled = false
    restoreAttemptedRef.current = true

    ;(async () => {
      // Prefer cached workspace from a previous visit in this browser session.
      if (azureConnectWorkspace.subscriptions.length > 0 && azureSessionReady) {
        setSubscriptions(azureConnectWorkspace.subscriptions)
        setSelectedSubscriptionIds(azureConnectWorkspace.selectedSubscriptionIds)
        setAvailableRegions(azureConnectWorkspace.availableRegions)
        setRegions(azureConnectWorkspace.selectedRegionIds)
        setOrgName(azureConnectWorkspace.orgName)
        if (azureConnectWorkspace.linkedCustomerId) {
          const match = customers.find((c) => c.id === azureConnectWorkspace.linkedCustomerId)
          if (match) setLinkedCustomer(match)
        }
        if (azureConnection) setConnection(azureConnection)
        setSessionReady(true)
        return
      }

      const ready = azureSessionReady || (await ensureAzureSession())
      if (cancelled || !ready) return

      try {
        await finalizeLogin()
      } catch {
        restoreAttemptedRef.current = false
      }
    })()

    return () => {
      cancelled = true
    }
    // One-shot restore when remounting Azure Connect after navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onConnect(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setStatusNote(null)
    setLinkedCustomer(null)
    setSessionReady(false)
    setAzureSession(null, false)
    resetAzureConnectWorkspace()
    setSubscriptions([])
    setSelectedSubscriptionIds([])
    setAvailableRegions([])
    setRegions([])
    restoreAttemptedRef.current = false
    try {
      const status = await connectTenant(tenantId.trim())
      setConnection(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onCancel() {
    setBusy(true)
    try {
      const status = await cancelAzureLogin()
      setConnection(status)
      setSessionReady(false)
      setAzureSession(status, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onResumeSession() {
    setBusy(true)
    setError(null)
    try {
      const ready = await ensureAzureSession()
      if (ready) {
        await finalizeLogin()
      } else {
        setError('No active Azure CLI session. Connect with a tenant ID first.')
        setSessionReady(false)
        setAzureSession(null, false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onDisconnect() {
    setBusy(true)
    try {
      const status = await disconnectTenant()
      setConnection(status)
      setSubscriptions([])
      setSelectedSubscriptionIds([])
      setAvailableRegions([])
      setRegions([])
      setLinkedCustomer(null)
      setOrgName(null)
      setSessionReady(false)
      clearAzureSession()
      setStatusNote(null)
      await clearPersistedConnection()
      await savePersistedConnection({ status: 'idle' })
      await refreshBootstrap()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function onSubscriptionsChange(nextIds: string[]) {
    setSelectedSubscriptionIds(nextIds)
    syncWorkspace({ selectedSubscriptionIds: nextIds })
    setError(null)
    void loadDeployedRegions(nextIds)
  }

  function onRegionsChange(nextIds: string[]) {
    setRegions(nextIds)
    syncWorkspace({ selectedRegionIds: nextIds })
  }

  async function persistSelectedSubscriptions(nextIds: string[]) {
    if (nextIds.length === 0 || !linkedCustomer) return
    const primaryId = nextIds[0]
    const result = await setSubscription(primaryId)
    setConnection((prev) =>
      prev
        ? {
            ...prev,
            account: result.account,
            status: 'connected',
          }
        : prev,
    )

    for (const subscriptionId of nextIds) {
      const sub = subscriptions.find((s) => s.id === subscriptionId)
      await ensureSubscription(linkedCustomer.id, {
        subscriptionId,
        name: sub?.name || subscriptionId,
        regions: regions.map((id) => {
          const match = availableRegions.find((r) => r.id === id)
          return match?.label || id
        }),
      })
    }

    const names = nextIds
      .map((id) => subscriptions.find((s) => s.id === id)?.name || id)
      .filter(Boolean)

    await savePersistedConnection({
      tenantId: linkedCustomer.tenantId || connection?.tenantId || null,
      organizationName: orgName || linkedCustomer.name || null,
      selectedSubscriptionId: primaryId,
      selectedSubscriptionName:
        nextIds.length > 1 ? `${nextIds.length} subscriptions` : names[0] || primaryId,
      account: result.account || null,
      status: 'connected',
    })
  }

  async function onCollectInventory() {
    if (collectLockRef.current.inventory || loadingInventory) return
    if (selectedSubscriptionIds.length === 0 || !linkedCustomer) {
      setError('Select at least one subscription and ensure the tenant customer has been created.')
      return
    }
    if (regions.length === 0) {
      setError('Select at least one region for inventory collection.')
      return
    }
    collectLockRef.current.inventory = true
    setStartingInventory(true)
    setError(null)
    try {
      await persistSelectedSubscriptions(selectedSubscriptionIds)
      const jobId = startInventoryRetrieval({
        customerId: linkedCustomer.id,
        customerName: linkedCustomer.name,
        tenantId: linkedCustomer.tenantId,
        regions,
        subscriptions: selectedSubscriptionIds.map((id) => ({
          id,
          name: subscriptions.find((s) => s.id === id)?.name || id,
        })),
      })
      if (!jobId) {
        setStatusNote(
          'Inventory retrieval is already running. Wait for it to finish before starting another.',
        )
        return
      }
      setStatusNote(
        'Inventory retrieval started in the background. You can navigate away — progress is on the Dashboard.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      collectLockRef.current.inventory = false
      setStartingInventory(false)
    }
  }

  async function onCollectQuotas() {
    if (collectLockRef.current.quotas || loadingQuotas) return
    if (selectedSubscriptionIds.length === 0 || !linkedCustomer) {
      setError('Select at least one subscription and ensure the tenant customer has been created.')
      return
    }
    if (regions.length === 0) {
      setError('Select at least one region for quota collection.')
      return
    }
    collectLockRef.current.quotas = true
    setStartingQuotas(true)
    setError(null)
    try {
      await persistSelectedSubscriptions(selectedSubscriptionIds)
      const jobId = startQuotaRetrieval({
        customerId: linkedCustomer.id,
        customerName: linkedCustomer.name,
        tenantId: linkedCustomer.tenantId,
        regions,
        subscriptions: selectedSubscriptionIds.map((id) => ({
          id,
          name: subscriptions.find((s) => s.id === id)?.name || id,
        })),
      })
      if (!jobId) {
        setStatusNote(
          'Quota retrieval is already running. Wait for it to finish before starting another.',
        )
        return
      }
      setStatusNote(
        'Quota retrieval started in the background. You can navigate away — progress is on the Dashboard.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      collectLockRef.current.quotas = false
      setStartingQuotas(false)
    }
  }

  async function onCollectQuotaGroups() {
    if (loadingQuotaGroups || !linkedCustomer) {
      if (!linkedCustomer) {
        setError('Connect a tenant and ensure the customer record exists before collecting quota groups.')
      }
      return
    }
    if (regions.length === 0) {
      setError('Select at least one region for quota group collection.')
      return
    }
    setStartingQuotaGroups(true)
    setError(null)
    try {
      const data = await collectQuotaGroups({
        customerId: linkedCustomer.id,
        customerName: linkedCustomer.name,
        tenantId: linkedCustomer.tenantId,
        regions,
      })
      const groupNames = (data.discoveredGroups || [])
        .map((g) => g.groupDisplayName || g.groupQuotaName)
        .join(', ')
      if (data.saved > 0) {
        setStatusNote(
          `Saved ${data.saved} row(s) for ${linkedCustomer.name}${
            groupNames ? ` · groups: ${groupNames}` : ''
          }${data.hint ? ` · ${data.hint}` : ''}`,
        )
      } else if ((data.discoveredGroups || []).length > 0) {
        setStatusNote(
          data.hint ||
            `Found ${data.discoveredGroups?.length} quota group(s) (${groupNames}) but nothing was saved.`,
        )
      } else {
        setStatusNote(
          data.hint ||
            'No Azure Quota Groups were returned. Confirm GroupQuota permissions and that quota groups exist in accessible management groups.',
        )
      }
      if (data.errors?.length) {
        setError(
          data.errors
            .slice(0, 3)
            .map((e) => Object.values(e).join(' · '))
            .join(' | '),
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStartingQuotaGroups(false)
    }
  }

  async function copyCode() {
    if (!connection?.deviceCode) return
    await navigator.clipboard.writeText(connection.deviceCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  useEffect(() => {
    if (
      connection?.status === 'awaiting_device_code' ||
      connection?.status === 'authenticating'
    ) {
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        try {
          const status = await getAzureStatus()
          setConnection(status)
          if (status.status === 'connected') {
            if (pollRef.current) window.clearInterval(pollRef.current)
            pollRef.current = null
            void finalizeLogin()
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, 2500)
    } else if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [connection?.status, finalizeLogin])

  const pending =
    connection?.status === 'awaiting_device_code' || connection?.status === 'authenticating'
  const connected = sessionReady || connection?.status === 'connected'
  const savedOnly = !sessionReady && Boolean(persistedConnection?.tenantId)

  return (
    <div className="stack">
      <section className="panel tenant-connect-panel">
        <div className="panel-header">
          <div>
            <h4>Connect Azure tenant</h4>
            <p>
              Collect inventory or quotas in the background — you can leave this page while retrieval
              continues. Progress is in Retrieval activity below (and on the Dashboard).
            </p>
          </div>
          <span
            className={`pill ${
              connected
                ? 'pill-ok'
                : pending
                  ? 'pill-investigation'
                  : connection?.status === 'error'
                    ? 'pill-critical'
                    : savedOnly
                      ? 'pill-medium'
                      : 'pill-neutral'
            }`}
          >
            {connected ? 'session ready' : pending ? connection?.status : savedOnly ? 'saved' : 'idle'}
          </span>
        </div>

        <div className="panel-body stack">
          {!connected && !pending ? (
            <form className="tenant-connect-form" onSubmit={onConnect}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="tenantId">Tenant ID (directory GUID)</label>
                <input
                  id="tenantId"
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  required
                  pattern="[0-9a-fA-F-]{36}"
                  title="Enter a valid tenant GUID"
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy || !tenantId.trim()}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <PlugZap size={16} />}
                Connect with az login
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void onResumeSession()}
                disabled={busy}
              >
                Use existing az session
              </button>
            </form>
          ) : null}

          {savedOnly && !pending ? (
            <div className="list-row">
              <div style={{ flex: 1 }}>
                <strong>Last saved connection</strong>
                <div className="muted">
                  {persistedConnection?.organizationName || 'Tenant'} ·{' '}
                  {persistedConnection?.tenantId}
                  {persistedConnection?.selectedSubscriptionName
                    ? ` · ${persistedConnection.selectedSubscriptionName}`
                    : ''}
                </div>
                <div className="muted" style={{ marginTop: '0.25rem' }}>
                  Stored in PostgreSQL. Click <strong>Use existing az session</strong> or Connect
                  before collecting data.
                </div>
              </div>
            </div>
          ) : null}

          {pending ? (
            <div className="device-code-card">
              <div>
                <div className="muted">Device code for tenant</div>
                <strong style={{ fontSize: '1.05rem' }}>{connection?.tenantId}</strong>
              </div>
              <div className="device-code-value">
                <span>{connection?.deviceCode || 'Waiting for Azure CLI…'}</span>
                {connection?.deviceCode ? (
                  <button type="button" className="btn btn-ghost" onClick={() => void copyCode()}>
                    <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                ) : (
                  <LoaderCircle size={18} className="spin" />
                )}
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {connection?.message}
              </p>
              <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
                <a
                  className="btn btn-primary"
                  href={connection?.verificationUrl || 'https://microsoft.com/devicelogin'}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Link2 size={16} /> Open microsoft.com/devicelogin
                </a>
                <button className="btn btn-secondary" type="button" onClick={() => void onCancel()} disabled={busy}>
                  Cancel login
                </button>
              </div>
            </div>
          ) : null}

          {connected ? (
            <div className="stack">
              <div className="connected-card">
                <div>
                  <strong>{orgName || connection?.account?.name || 'Connected tenant'}</strong>
                  <div className="muted">
                    Tenant {connection?.tenantId || linkedCustomer?.tenantId} · Signed in as{' '}
                    {connection?.account?.user?.name || 'current user'}
                  </div>
                  {linkedCustomer ? (
                    <div style={{ marginTop: '0.45rem' }}>
                      <span className="pill pill-ok">Customer saved</span>{' '}
                      <Link to={`/customers/${linkedCustomer.id}`}>
                        <strong>{linkedCustomer.name}</strong>
                      </Link>
                    </div>
                  ) : null}
                </div>
                <button className="btn btn-danger" type="button" onClick={() => void onDisconnect()} disabled={busy}>
                  <LogOut size={16} /> Disconnect
                </button>
              </div>

              <div className="form-grid">
                <div className="field">
                  <CheckboxMultiSelect
                    id="subscription"
                    label="Subscriptions"
                    options={subscriptionOptions}
                    value={selectedSubscriptionIds}
                    onChange={onSubscriptionsChange}
                    disabled={busy || loadingSubscriptions || subscriptions.length === 0}
                    placeholder={
                      loadingSubscriptions ? 'Loading subscriptions…' : 'Select subscriptions'
                    }
                    emptyLabel="No subscriptions loaded"
                    selectAllLabel="Select all subscriptions"
                    searchableFrom={0}
                    searchPlaceholder="Search by name or subscription ID…"
                  />
                </div>
                <div className="field">
                  <CheckboxMultiSelect
                    id="regions"
                    label="Regions with deployed resources"
                    options={regionOptions}
                    value={regions}
                    onChange={onRegionsChange}
                    disabled={
                      busy ||
                      loadingRegions ||
                      selectedSubscriptionIds.length === 0 ||
                      availableRegions.length === 0
                    }
                    placeholder={
                      loadingRegions
                        ? 'Discovering regions…'
                        : selectedSubscriptionIds.length === 0
                          ? 'Select subscriptions first'
                          : availableRegions.length === 0
                            ? 'No regions with resources found'
                            : 'Select regions…'
                    }
                    selectAllLabel="Select all regions"
                    emptyLabel={
                      loadingRegions
                        ? 'Discovering regions from Azure Resource Graph…'
                        : 'No regions with deployed resources in the selected subscriptions.'
                    }
                    searchableFrom={0}
                    searchPlaceholder="Search regions…"
                  />
                  <p className="muted" style={{ margin: '0.45rem 0 0' }}>
                    {loadingRegions
                      ? 'Scanning selected subscriptions for resource locations…'
                      : availableRegions.length > 0
                        ? `${availableRegions.length} region${
                            availableRegions.length === 1 ? '' : 's'
                          } with resources · used for inventory, quotas, and quota groups`
                        : 'Select subscriptions to discover regions with deployed resources.'}
                  </p>
                </div>
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <label>&nbsp;</label>
                  <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
                    <span
                      className={`btn-tooltip-wrap${inventoryRecentTip ? ' has-tip' : ''}`}
                      data-tip={inventoryRecentTip || undefined}
                    >
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => void onCollectInventory()}
                        disabled={
                          loadingInventory ||
                          selectedSubscriptionIds.length === 0 ||
                          !linkedCustomer ||
                          busy ||
                          regions.length === 0
                        }
                        aria-busy={loadingInventory}
                        aria-describedby={
                          inventoryRecentTip ? 'inventory-recent-tip' : undefined
                        }
                      >
                        {loadingInventory ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <Boxes size={16} />
                        )}
                        {loadingInventory ? 'Collecting inventory…' : 'Collect inventory'}
                      </button>
                      {inventoryRecentTip ? (
                        <span id="inventory-recent-tip" className="btn-tooltip" role="tooltip">
                          {inventoryRecentTip}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`btn-tooltip-wrap${quotasRecentTip ? ' has-tip' : ''}`}
                      data-tip={quotasRecentTip || undefined}
                    >
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => void onCollectQuotas()}
                        disabled={
                          loadingQuotas ||
                          selectedSubscriptionIds.length === 0 ||
                          !linkedCustomer ||
                          busy ||
                          regions.length === 0
                        }
                        aria-busy={loadingQuotas}
                        aria-describedby={quotasRecentTip ? 'quotas-recent-tip' : undefined}
                      >
                        {loadingQuotas ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <Gauge size={16} />
                        )}
                        {loadingQuotas ? 'Collecting quotas…' : 'Collect quotas'}
                      </button>
                      {quotasRecentTip ? (
                        <span id="quotas-recent-tip" className="btn-tooltip" role="tooltip">
                          {quotasRecentTip}
                        </span>
                      ) : null}
                    </span>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void onCollectQuotaGroups()}
                      disabled={loadingQuotaGroups || !linkedCustomer || busy || regions.length === 0}
                      aria-busy={loadingQuotaGroups}
                    >
                      {loadingQuotaGroups ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        <Layers size={16} />
                      )}
                      {loadingQuotaGroups ? 'Collecting quota groups…' : 'Collect quota groups'}
                    </button>
                  </div>
                </div>
              </div>

              {statusNote ? (
                <div className="list-row">
                  <div style={{ flex: 1 }}>
                    <strong>Background retrieval started</strong>
                    <div className="muted">{statusNote}</div>
                  </div>
                  <Link className="btn btn-secondary" to="/">
                    Open dashboard log
                  </Link>
                </div>
              ) : null}

              {customerJobs.length > 0 || customerLog.length > 0 ? (
                <div className="collapsible-block">
                  <button
                    type="button"
                    className="collapsible-trigger"
                    aria-expanded={activityExpanded}
                    onClick={() => setActivityExpanded((prev) => !prev)}
                  >
                    <span className="collapsible-trigger-main">
                      {activityExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <strong>Retrieval activity</strong>
                      <span className="muted">
                        {customerJobs.length} job{customerJobs.length === 1 ? '' : 's'}
                        {customerLog.length > 0
                          ? ` · ${customerLog.length} log entr${customerLog.length === 1 ? 'y' : 'ies'}`
                          : ''}
                      </span>
                    </span>
                    {hasActiveCustomerJobs ? (
                      <span className="pill pill-investigation">running</span>
                    ) : (
                      <span className="pill pill-neutral">
                        {activityExpanded ? 'Hide' : 'Show'}
                      </span>
                    )}
                  </button>

                  {activityExpanded ? (
                    <div className="collapsible-body stack" style={{ gap: '0.55rem' }}>
                      {customerJobs.map((job) => {
                        const pct = job.progressTotal
                          ? Math.round((job.progressCurrent / job.progressTotal) * 100)
                          : 0
                        return (
                          <div key={job.id} className="list-row">
                            <div style={{ flex: 1 }}>
                              <strong>
                                {job.kind === 'inventory' ? 'Inventory' : 'Quotas'} · {job.status}
                              </strong>
                              <div className="muted">
                                {job.progressCurrent}/{job.progressTotal} subscriptions ·{' '}
                                {job.initiatedByName}
                                {job.summary ? ` · ${job.summary}` : ''}
                              </div>
                              {job.error ? (
                                <div className="inline-error" style={{ marginTop: '0.45rem' }}>
                                  {job.error}
                                </div>
                              ) : null}
                              {(job.status === 'running' || job.status === 'queued') && (
                                <div className="progress" style={{ marginTop: '0.45rem' }}>
                                  <span style={{ width: `${Math.min(pct, 100)}%` }} />
                                </div>
                              )}
                            </div>
                            <span
                              className={`pill ${
                                job.status === 'succeeded'
                                  ? 'pill-ok'
                                  : job.status === 'failed'
                                    ? 'pill-critical'
                                    : job.status === 'partial'
                                      ? 'pill-medium'
                                      : 'pill-investigation'
                              }`}
                            >
                              {job.status}
                            </span>
                          </div>
                        )
                      })}

                      {customerLog.length > 0 ? (
                        <div
                          className="retrieval-log"
                          aria-live="polite"
                          aria-relevant="additions"
                        >
                          {customerLog.map((entry) => (
                            <RetrievalLogEntryView key={entry.id} entry={entry} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <div className="inline-error">{error}</div> : null}
        </div>
      </section>
    </div>
  )
}
