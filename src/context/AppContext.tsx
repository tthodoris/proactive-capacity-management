import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  currentUser as defaultUser,
  initialAlerts,
  initialConstraints,
  initialEngagements,
  initialImpact,
  syncJobs,
  users,
} from '../data/mockData'
import {
  fetchBootstrap,
  persistAlertRead,
  persistConnection,
  persistConstraint,
  persistConstraintBundle,
  persistConstraintImpacts,
  persistCustomer,
  persistEngagement,
  persistInventory,
  persistQuotas,
  persistReward,
  persistSubscription,
  runImpactAnalysis,
  type PersistedConnection,
} from '../lib/dataApi'
import {
  collectAndPersistQuotaGroups,
  collectAndPersistQuotas,
  fetchAzureLocations,
  fetchLiveInventory,
  getAzureStatus,
  setSubscription,
  type AzureConnection,
  type AzureLocationOption,
  type AzureRegionOption,
  type AzureSubscriptionOption,
} from '../lib/azureApi'
import { prettyRegion } from '../lib/format'
import { toSkuFamily } from '../lib/skuFamily'
import type {
  AlertItem,
  CapacityConstraint,
  ConstraintStatus,
  Customer,
  Engagement,
  ImpactResult,
  InventoryItem,
  Quota,
  QuotaGroupLimit,
  RewardAction,
  RewardEvent,
  Subscription,
  User,
  UserRole,
} from '../types'
import { REWARD_POINTS } from '../types'
import type {
  RetrievalJob,
  RetrievalLogEntry,
  RetrievalLogLevel,
  StartInventoryRetrievalInput,
  StartQuotaRetrievalInput,
} from '../types/retrieval'

interface CreateConstraintInput {
  sku: string
  resourceType: CapacityConstraint['resourceType']
  regions: string[]
  scope: CapacityConstraint['scope']
  subscriptionId?: string
  customerId?: string
  source: string
  severity: CapacityConstraint['severity']
  description: string
}

interface UpsertTenantCustomerInput {
  tenantId: string
  name: string
  domain?: string
}

/** UI workspace for Azure Connect — survives page navigation. */
export interface AzureConnectWorkspace {
  subscriptions: AzureSubscriptionOption[]
  selectedSubscriptionIds: string[]
  availableRegions: AzureRegionOption[]
  selectedRegionIds: string[]
  linkedCustomerId: string | null
  orgName: string | null
}

const EMPTY_AZURE_WORKSPACE: AzureConnectWorkspace = {
  subscriptions: [],
  selectedSubscriptionIds: [],
  availableRegions: [],
  selectedRegionIds: [],
  linkedCustomerId: null,
  orgName: null,
}

interface ImportInventoryInput {
  customerId: string
  subscription: {
    subscriptionId: string
    name: string
    regions: string[]
  }
  items: Array<{
    id: string
    name: string
    /** Live Azure labels may be wider than the UI ResourceType union. */
    resourceType: string
    sku: string
    size?: string
    region: string
    resourceGroup: string
    subscriptionId: string
  }>
}

interface ImportQuotasInput {
  customerId: string
  subscriptionId: string
  azureSubscriptionId: string
  items: Quota[]
}

interface AppContextValue {
  user: User
  setRole: (role: UserRole) => void
  customers: Customer[]
  subscriptions: Subscription[]
  inventory: InventoryItem[]
  quotas: Quota[]
  quotaGroupLimits: QuotaGroupLimit[]
  users: typeof users
  syncJobs: typeof syncJobs
  constraints: CapacityConstraint[]
  impactResults: ImpactResult[]
  alerts: AlertItem[]
  engagements: Engagement[]
  rewardEvents: RewardEvent[]
  latestReward: RewardEvent | null
  dismissRewardToast: () => void
  getUserPoints: (userId: string) => number
  createConstraint: (input: CreateConstraintInput) => Promise<CapacityConstraint>
  updateConstraintStatus: (
    id: string,
    status: ConstraintStatus,
    detail: string,
  ) => Promise<void>
  rerunImpact: (constraintId: string) => Promise<void>
  markAlertRead: (id: string) => Promise<void>
  createEngagement: (constraintId: string, customerId: string, notes: string) => Promise<void>
  upsertTenantCustomer: (input: UpsertTenantCustomerInput) => Promise<Customer>
  ensureSubscription: (
    customerId: string,
    subscription: { subscriptionId: string; name: string; regions?: string[] },
  ) => Promise<Subscription>
  importTenantInventory: (input: ImportInventoryInput) => Promise<{ imported: number; customerId: string }>
  importTenantQuotas: (input: ImportQuotasInput) => Promise<{ imported: number }>
  refreshBootstrap: () => Promise<void>
  dataReady: boolean
  dataError: string | null
  persistedConnection: PersistedConnection | null
  savePersistedConnection: (connection: PersistedConnection) => Promise<void>
  azureConnection: AzureConnection | null
  azureSessionReady: boolean
  azureLocations: AzureLocationOption[]
  azureLocationsLoading: boolean
  azureLocationsError: string | null
  azureConnectWorkspace: AzureConnectWorkspace
  ensureAzureSession: () => Promise<boolean>
  loadAzureLocations: (force?: boolean) => Promise<AzureLocationOption[]>
  setAzureSession: (connection: AzureConnection | null, ready?: boolean) => void
  clearAzureSession: () => void
  patchAzureConnectWorkspace: (patch: Partial<AzureConnectWorkspace>) => void
  resetAzureConnectWorkspace: () => void
  portfolioCustomerIds: string[]
  canSeeAllPortfolios: boolean
  retrievalJobs: RetrievalJob[]
  retrievalLog: RetrievalLogEntry[]
  activeRetrievalCount: number
  isRetrievalRunning: (kind?: 'inventory' | 'quotas') => boolean
  startInventoryRetrieval: (input: StartInventoryRetrievalInput) => string | null
  startQuotaRetrieval: (input: StartQuotaRetrievalInput) => string | null
  collectQuotaGroups: (input: {
    customerId: string
    customerName: string
    tenantId?: string
    regions?: string[]
    managementGroupId?: string
  }) => Promise<{
    saved: number
    discoveredGroups?: Array<{
      managementGroupId: string
      groupQuotaName: string
      groupDisplayName?: string
    }>
    errors?: Array<Record<string, string>>
    hint?: string
  }>
}

const AppContext = createContext<AppContextValue | null>(null)

const RETRIEVAL_JOBS_KEY = 'pcm.retrievalJobs.v1'

function loadStoredRetrievalJobs(): RetrievalJob[] {
  try {
    const raw = sessionStorage.getItem(RETRIEVAL_JOBS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistRetrievalJobs(jobs: RetrievalJob[]) {
  try {
    sessionStorage.setItem(RETRIEVAL_JOBS_KEY, JSON.stringify(jobs.slice(0, 40)))
  } catch {
    // ignore quota / private mode failures
  }
}

function makeLogEntry(
  job: Pick<
    RetrievalJob,
    'id' | 'kind' | 'initiatedByUserId' | 'initiatedByName' | 'customerId' | 'customerName'
  >,
  level: RetrievalLogLevel,
  message: string,
  extra?: Partial<RetrievalLogEntry>,
): RetrievalLogEntry {
  return {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    level,
    message,
    kind: job.kind,
    jobId: job.id,
    initiatedByUserId: job.initiatedByUserId,
    initiatedByName: job.initiatedByName,
    customerId: job.customerId,
    customerName: job.customerName,
    ...extra,
  }
}

const fallbackRewards: RewardEvent[] = [
  {
    id: 'rw-seed-1',
    userId: 'u-theo',
    action: 'constraint_created',
    points: REWARD_POINTS.constraint_created,
    label: 'Recorded Dsv5 VM series constraint',
    relatedId: 'cc-dsv5-eu',
    createdAt: '2026-07-22T10:00:00Z',
  },
  {
    id: 'rw-seed-2',
    userId: 'u-alex',
    action: 'constraint_created',
    points: REWARD_POINTS.constraint_created,
    label: 'Recorded ADX Standard_D14_v2 constraint',
    relatedId: 'cc-adx-we',
    createdAt: '2026-07-18T14:30:00Z',
  },
  {
    id: 'rw-seed-3',
    userId: 'u-maria',
    action: 'constraint_created',
    points: REWARD_POINTS.constraint_created,
    label: 'Recorded SQL GP_Gen5 constraint',
    relatedId: 'cc-sql-ne',
    createdAt: '2026-07-10T11:00:00Z',
  },
  {
    id: 'rw-seed-4',
    userId: 'u-maria',
    action: 'engagement_started',
    points: REWARD_POINTS.engagement_started,
    label: 'Engaged Capacity for Nova Retail EU',
    relatedId: 'e1',
    createdAt: '2026-07-15T17:00:00Z',
  },
]

function tenantCustomerId(tenantId: string) {
  return `c-tenant-${tenantId.toLowerCase()}`
}

function localSubscriptionId(subscriptionId: string) {
  return `s-live-${subscriptionId.toLowerCase()}`
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User>(defaultUser)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [quotas, setQuotas] = useState<Quota[]>([])
  const [quotaGroupLimits, setQuotaGroupLimits] = useState<QuotaGroupLimit[]>([])
  const [constraints, setConstraints] = useState<CapacityConstraint[]>([])
  const [impactResults, setImpactResults] = useState<ImpactResult[]>([])
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [rewardEvents, setRewardEvents] = useState<RewardEvent[]>([])
  const [latestReward, setLatestReward] = useState<RewardEvent | null>(null)
  const [dataReady, setDataReady] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [persistedConnection, setPersistedConnection] = useState<PersistedConnection | null>(null)
  const [azureConnection, setAzureConnection] = useState<AzureConnection | null>(null)
  const [azureSessionReady, setAzureSessionReady] = useState(false)
  const [azureLocations, setAzureLocations] = useState<AzureLocationOption[]>([])
  const [azureLocationsLoading, setAzureLocationsLoading] = useState(false)
  const [azureLocationsError, setAzureLocationsError] = useState<string | null>(null)
  const [azureConnectWorkspace, setAzureConnectWorkspace] =
    useState<AzureConnectWorkspace>(EMPTY_AZURE_WORKSPACE)
  const [retrievalJobs, setRetrievalJobs] = useState<RetrievalJob[]>(() => loadStoredRetrievalJobs())
  const azureLocationsRef = useRef<AzureLocationOption[]>([])
  const azureLocationsLoadedRef = useRef(false)
  const azureSessionReadyRef = useRef(false)
  const sessionProbeStartedRef = useRef(false)
  const toastTimer = useRef<number | null>(null)
  const customersRef = useRef(customers)
  const constraintsRef = useRef(constraints)
  const userRef = useRef(user)
  const importTenantInventoryRef = useRef<
    (input: ImportInventoryInput) => Promise<{ imported: number; customerId: string }>
  >(async () => ({ imported: 0, customerId: '' }))
  const ensureSubscriptionRef = useRef<
    (
      customerId: string,
      subscription: { subscriptionId: string; name: string; regions?: string[] },
    ) => Promise<Subscription>
  >(async () => {
    throw new Error('ensureSubscription not ready')
  })
  const refreshBootstrapRef = useRef<() => Promise<void>>(async () => undefined)
  const azureJobQueueRef = useRef(Promise.resolve())
  const cleanedStaleJobsRef = useRef(false)
  const retrievalJobsRef = useRef(retrievalJobs)
  const retrievalStartLocksRef = useRef<{ inventory: boolean; quotas: boolean }>({
    inventory: false,
    quotas: false,
  })

  const enqueueAzureJob = useCallback((task: () => Promise<void>) => {
    azureJobQueueRef.current = azureJobQueueRef.current.then(task, task)
    return azureJobQueueRef.current
  }, [])

  useEffect(() => {
    customersRef.current = customers
  }, [customers])

  useEffect(() => {
    constraintsRef.current = constraints
  }, [constraints])

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    retrievalJobsRef.current = retrievalJobs
  }, [retrievalJobs])

  useEffect(() => {
    persistRetrievalJobs(retrievalJobs)
  }, [retrievalJobs])

  // Mark any leftover "running" jobs from a previous page session as interrupted.
  useEffect(() => {
    if (cleanedStaleJobsRef.current) return
    cleanedStaleJobsRef.current = true
    setRetrievalJobs((prev) => {
      const hasRunning = prev.some((j) => j.status === 'running' || j.status === 'queued')
      if (!hasRunning) return prev
      const now = new Date().toISOString()
      return prev.map((job) => {
        if (job.status !== 'running' && job.status !== 'queued') return job
        const entry = makeLogEntry(
          job,
          'warn',
          'Previous retrieval was interrupted by a browser refresh. Start again from Azure Connect if needed.',
        )
        return {
          ...job,
          status: 'failed' as const,
          updatedAt: now,
          finishedAt: now,
          error: 'Interrupted by page reload',
          log: [...job.log, entry],
        }
      })
    })
  }, [])

  const applyBootstrap = useCallback((bootstrap: Awaited<ReturnType<typeof fetchBootstrap>>) => {
    setCustomers(bootstrap.customers)
    setSubscriptions(bootstrap.subscriptions)
    setInventory(bootstrap.inventory)
    setQuotas(bootstrap.quotas)
    setQuotaGroupLimits(bootstrap.quotaGroupLimits || [])
    setPersistedConnection(bootstrap.connection)
    setConstraints(bootstrap.constraints || [])
    setImpactResults(bootstrap.impactResults || [])
    setAlerts(bootstrap.alerts || [])
    setEngagements(bootstrap.engagements || [])
    setRewardEvents(bootstrap.rewardEvents || [])
  }, [])

  const refreshBootstrap = useCallback(async () => {
    const bootstrap = await fetchBootstrap()
    applyBootstrap(bootstrap)
  }, [applyBootstrap])

  useEffect(() => {
    refreshBootstrapRef.current = refreshBootstrap
  }, [refreshBootstrap])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const bootstrap = await fetchBootstrap()
        if (cancelled) return
        applyBootstrap(bootstrap)
        setDataError(null)
      } catch (err) {
        if (cancelled) return
        // Fall back to in-memory demo domain data if API/DB is unavailable.
        setConstraints(initialConstraints)
        setImpactResults(initialImpact)
        setAlerts(initialAlerts)
        setEngagements(initialEngagements)
        setRewardEvents(fallbackRewards)
        setDataError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setDataReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyBootstrap])

  const canSeeAllPortfolios = user.role === 'Capacity Manager' || user.role === 'Administrator'

  const portfolioCustomerIds = useMemo(() => {
    if (canSeeAllPortfolios) return customers.map((c) => c.id)
    return customers.filter((c) => c.csaOwnerId === user.id).map((c) => c.id)
  }, [canSeeAllPortfolios, user.id, customers])

  const dismissRewardToast = useCallback(() => {
    setLatestReward(null)
    if (toastTimer.current) {
      window.clearTimeout(toastTimer.current)
      toastTimer.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const awardPoints = useCallback(
    (action: RewardAction, label: string, relatedId?: string) => {
      const event: RewardEvent = {
        id: `rw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId: user.id,
        action,
        points: REWARD_POINTS[action],
        label,
        relatedId,
        createdAt: new Date().toISOString(),
      }
      setRewardEvents((prev) => [event, ...prev])
      setLatestReward(event)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setLatestReward(null), 4200)
      void persistReward(event).catch((err) => {
        console.error('Failed to persist reward event', err)
      })
      return event
    },
    [user.id],
  )

  const getUserPoints = useCallback(
    (userId: string) =>
      rewardEvents.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.points, 0),
    [rewardEvents],
  )

  const setRole = useCallback((role: UserRole) => {
    setUser((prev) => ({ ...prev, role }))
  }, [])

  const upsertTenantCustomer = useCallback(
    async (input: UpsertTenantCustomerInput) => {
      const id = tenantCustomerId(input.tenantId)
      const now = new Date().toISOString()
      const existing = customersRef.current.find((c) => c.id === id || c.tenantId === input.tenantId)
      const customer: Customer = existing
        ? {
            ...existing,
            name: input.name || existing.name,
            tenantId: input.tenantId,
            lastSyncedAt: now,
            syncSource: 'Customer tenant',
          }
        : {
            id,
            name: input.name,
            tenantId: input.tenantId,
            csaOwnerId: user.id,
            segment: 'Connected tenant',
            industry: input.domain || 'Azure tenant',
            regionFocus: [],
            lastSyncedAt: now,
            syncSource: 'Customer tenant',
          }

      const saved = await persistCustomer(customer)
      const finalCustomer = { ...customer, id: saved.id }
      setCustomers((prev) => {
        const idx = prev.findIndex(
          (c) => c.id === finalCustomer.id || c.tenantId === finalCustomer.tenantId,
        )
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = finalCustomer
          return next
        }
        return [finalCustomer, ...prev]
      })
      return finalCustomer
    },
    [user.id],
  )

  const ensureSubscription = useCallback(
    async (
      customerId: string,
      subscription: { subscriptionId: string; name: string; regions?: string[] },
    ) => {
      const id = localSubscriptionId(subscription.subscriptionId)
      const existing = subscriptions.find(
        (s) => s.subscriptionId === subscription.subscriptionId || s.id === id,
      )
      const row: Subscription = existing
        ? {
            ...existing,
            customerId,
            name: subscription.name || existing.name,
            regions: subscription.regions?.length ? subscription.regions : existing.regions,
          }
        : {
            id,
            customerId,
            name: subscription.name,
            subscriptionId: subscription.subscriptionId,
            regions: subscription.regions ?? [],
          }

      const saved = await persistSubscription(row)
      const finalRow = { ...row, id: saved.id }
      setSubscriptions((prev) => {
        const idx = prev.findIndex(
          (s) => s.id === finalRow.id || s.subscriptionId === finalRow.subscriptionId,
        )
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = finalRow
          return next
        }
        return [finalRow, ...prev]
      })
      return finalRow
    },
    [subscriptions],
  )

  const importTenantInventory = useCallback(
    async (input: ImportInventoryInput) => {
      const localSub = await ensureSubscription(input.customerId, input.subscription)
      const now = new Date().toISOString()
      const mapped: InventoryItem[] = input.items.map((item) => ({
        // Keep the full ARM resource id — truncating caused duplicate PK collisions
        // on large subscriptions (e.g. long Synapse/SQL resource paths).
        id: `inv-live-${item.id}`,
        customerId: input.customerId,
        subscriptionId: localSub.id,
        resourceType: item.resourceType as InventoryItem['resourceType'],
        sku: item.sku,
        size: toSkuFamily(item.sku, item.size) || item.size,
        region: item.region,
        resourceGroup: item.resourceGroup,
        name: item.name,
        source: 'Customer tenant',
      }))

      await persistInventory({
        customerId: input.customerId,
        subscriptionId: localSub.id,
        items: mapped.map((item) => ({
          ...item,
          azureSubscriptionId: input.subscription.subscriptionId,
          collectedAt: now,
        })),
      })

      setInventory((prev) => {
        const retained = prev.filter(
          (item) =>
            !(item.customerId === input.customerId && item.subscriptionId === localSub.id),
        )
        return [...mapped, ...retained]
      })

      const regions = [
        ...new Set([
          ...(customersRef.current.find((c) => c.id === input.customerId)?.regionFocus || []),
          ...mapped.map((m) => m.region).filter(Boolean),
        ]),
      ].slice(0, 8)

      const customer = customersRef.current.find((c) => c.id === input.customerId)
      if (customer) {
        const updated = {
          ...customer,
          lastSyncedAt: now,
          syncSource: 'Customer tenant' as const,
          regionFocus: regions,
        }
        await persistCustomer(updated)
        setCustomers((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      }

      return { imported: mapped.length, customerId: input.customerId }
    },
    [ensureSubscription],
  )

  useEffect(() => {
    ensureSubscriptionRef.current = ensureSubscription
  }, [ensureSubscription])

  useEffect(() => {
    importTenantInventoryRef.current = importTenantInventory
  }, [importTenantInventory])

  const importTenantQuotas = useCallback(async (input: ImportQuotasInput) => {
    const now = new Date().toISOString()
    const items = input.items.map((item) => ({
      ...item,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      azureSubscriptionId: input.azureSubscriptionId,
      source: item.source || 'Azure Compute Usage API',
      collectedAt: now,
    }))
    await persistQuotas({
      azureSubscriptionId: input.azureSubscriptionId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      items,
    })
    setQuotas((prev) => {
      const retained = prev.filter((q) => q.azureSubscriptionId !== input.azureSubscriptionId)
      return [...items, ...retained]
    })
    return { imported: items.length }
  }, [])

  const savePersistedConnection = useCallback(async (connection: PersistedConnection) => {
    const saved = await persistConnection(connection)
    setPersistedConnection(saved)
  }, [])

  const setAzureSession = useCallback((connection: AzureConnection | null, ready?: boolean) => {
    setAzureConnection(connection)
    const nextReady =
      typeof ready === 'boolean' ? ready : connection ? connection.status === 'connected' : false
    azureSessionReadyRef.current = nextReady
    setAzureSessionReady(nextReady)
  }, [])

  const patchAzureConnectWorkspace = useCallback((patch: Partial<AzureConnectWorkspace>) => {
    setAzureConnectWorkspace((prev) => ({ ...prev, ...patch }))
  }, [])

  const resetAzureConnectWorkspace = useCallback(() => {
    setAzureConnectWorkspace(EMPTY_AZURE_WORKSPACE)
  }, [])

  const clearAzureSession = useCallback(() => {
    setAzureConnection(null)
    azureSessionReadyRef.current = false
    setAzureSessionReady(false)
    setAzureLocations([])
    azureLocationsRef.current = []
    setAzureLocationsError(null)
    azureLocationsLoadedRef.current = false
    setAzureConnectWorkspace(EMPTY_AZURE_WORKSPACE)
  }, [])

  const loadAzureLocations = useCallback(async (force = false) => {
    if (!force && azureLocationsLoadedRef.current && azureLocationsRef.current.length > 0) {
      return azureLocationsRef.current
    }
    setAzureLocationsLoading(true)
    setAzureLocationsError(null)
    try {
      const data = await fetchAzureLocations()
      const locations = data.locations || []
      azureLocationsRef.current = locations
      setAzureLocations(locations)
      azureLocationsLoadedRef.current = true
      if (data.connection?.status === 'connected') {
        setAzureConnection(data.connection)
        azureSessionReadyRef.current = true
        setAzureSessionReady(true)
      }
      return locations
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAzureLocationsError(message)
      // Keep any previously loaded catalog instead of wiping it on a transient failure.
      if (!azureLocationsRef.current.length) {
        setAzureLocations([])
        azureLocationsLoadedRef.current = false
      }
      throw err
    } finally {
      setAzureLocationsLoading(false)
    }
  }, [])

  const ensureAzureSession = useCallback(async () => {
    try {
      const status = await getAzureStatus()
      setAzureConnection(status)
      const ready = status.status === 'connected'
      azureSessionReadyRef.current = ready
      setAzureSessionReady(ready)
      if (ready && (!azureLocationsLoadedRef.current || azureLocationsRef.current.length === 0)) {
        try {
          await loadAzureLocations()
        } catch {
          // Session can be ready while location catalog still fails; surface via azureLocationsError.
        }
      }
      return ready
    } catch (err) {
      // Do not clear an already-ready session on a transient probe failure.
      if (azureSessionReadyRef.current) return true
      setAzureSessionReady(false)
      setAzureConnection((prev) =>
        prev
          ? {
              ...prev,
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            }
          : prev,
      )
      return false
    }
  }, [loadAzureLocations])

  useEffect(() => {
    if (!dataReady || sessionProbeStartedRef.current) return
    sessionProbeStartedRef.current = true
    void ensureAzureSession()
  }, [dataReady, ensureAzureSession])

  const patchRetrievalJob = useCallback(
    (jobId: string, updater: (job: RetrievalJob) => RetrievalJob) => {
      setRetrievalJobs((prev) => prev.map((job) => (job.id === jobId ? updater(job) : job)))
    },
    [],
  )

  const appendRetrievalLog = useCallback(
    (
      jobId: string,
      level: RetrievalLogLevel,
      message: string,
      extra?: Partial<RetrievalLogEntry>,
    ) => {
      patchRetrievalJob(jobId, (job) => {
        const entry = makeLogEntry(job, level, message, extra)
        return {
          ...job,
          updatedAt: entry.at,
          log: [...job.log, entry],
        }
      })
    },
    [patchRetrievalJob],
  )

  const startInventoryRetrieval = useCallback(
    (input: StartInventoryRetrievalInput) => {
      const hasActive = retrievalJobsRef.current.some(
        (job) =>
          job.kind === 'inventory' && (job.status === 'queued' || job.status === 'running'),
      )
      if (hasActive || retrievalStartLocksRef.current.inventory) {
        return null
      }
      retrievalStartLocksRef.current.inventory = true

      const currentUser = userRef.current
      const now = new Date().toISOString()
      const jobId = `ret-inv-${Date.now()}`
      const job: RetrievalJob = {
        id: jobId,
        kind: 'inventory',
        status: 'queued',
        initiatedByUserId: currentUser.id,
        initiatedByName: currentUser.name,
        customerId: input.customerId,
        customerName: input.customerName,
        tenantId: input.tenantId,
        regions: input.regions,
        subscriptionIds: input.subscriptions.map((s) => s.id),
        subscriptionNames: input.subscriptions.map((s) => s.name),
        startedAt: now,
        updatedAt: now,
        progressCurrent: 0,
        progressTotal: Math.max(input.subscriptions.length, 1),
        log: [
          makeLogEntry(
            {
              id: jobId,
              kind: 'inventory',
              initiatedByUserId: currentUser.id,
              initiatedByName: currentUser.name,
              customerId: input.customerId,
              customerName: input.customerName,
            },
            'info',
            `Inventory retrieval queued for ${input.customerName} across ${input.subscriptions.length} subscription(s).`,
            {
              details: `${input.subscriptions.map((s) => s.name).join(', ')}${
                input.regions?.length ? ` · regions ${input.regions.join(', ')}` : ''
              }`,
            },
          ),
        ],
      }

      setRetrievalJobs((prev) => [job, ...prev].slice(0, 40))

      void enqueueAzureJob(async () => {
        try {
          patchRetrievalJob(jobId, (j) => ({
            ...j,
            status: 'running',
            updatedAt: new Date().toISOString(),
          }))
          appendRetrievalLog(
            jobId,
            'info',
            `Started inventory retrieval in background for ${input.customerName}. You can leave Azure Connect safely.`,
          )

          let importedTotal = 0
          let failures = 0
          const failureReasons: string[] = []

          for (let index = 0; index < input.subscriptions.length; index += 1) {
            const sub = input.subscriptions[index]
            appendRetrievalLog(
              jobId,
              'info',
              `Collecting inventory for subscription ${sub.name}`,
              {
                subscriptionId: sub.id,
                subscriptionName: sub.name,
                details: `Step ${index + 1} of ${input.subscriptions.length}${
                  input.regions?.length ? ` · regions ${input.regions.join(', ')}` : ''
                }`,
              },
            )
            try {
              await setSubscription(sub.id)
              const data = await fetchLiveInventory(sub.id, input.regions)
              const regionsFound = [
                ...new Set(data.resources.map((r) => prettyRegion(r.region)).filter(Boolean)),
              ]
              const result = await importTenantInventoryRef.current({
                customerId: input.customerId,
                subscription: {
                  subscriptionId: sub.id,
                  name: sub.name,
                  regions: regionsFound,
                },
                items: data.resources.map((r) => ({
                  id: r.id,
                  name: r.name,
                  resourceType: r.resourceType,
                  sku: r.sku,
                  size: r.size,
                  region: prettyRegion(r.region),
                  resourceGroup: r.resourceGroup,
                  subscriptionId: r.subscriptionId,
                })),
              })
              importedTotal += result.imported
              appendRetrievalLog(
                jobId,
                'success',
                `Saved ${result.imported} inventory resource(s) for ${sub.name}`,
                {
                  subscriptionId: sub.id,
                  subscriptionName: sub.name,
                  details: regionsFound.length
                    ? `Regions: ${regionsFound.join(', ')}`
                    : undefined,
                },
              )
            } catch (err) {
              failures += 1
              const reason = err instanceof Error ? err.message : String(err)
              failureReasons.push(`${sub.name}: ${reason}`)
              appendRetrievalLog(
                jobId,
                'error',
                `Inventory collection failed for ${sub.name}`,
                {
                  subscriptionId: sub.id,
                  subscriptionName: sub.name,
                  details: reason,
                },
              )
            }
            patchRetrievalJob(jobId, (j) => ({
              ...j,
              progressCurrent: index + 1,
              updatedAt: new Date().toISOString(),
            }))
          }

          try {
            await refreshBootstrapRef.current()
          } catch {
            // bootstrap refresh is best-effort after background collect
          }

          const finishedAt = new Date().toISOString()
          const status =
            failures === 0
              ? 'succeeded'
              : failures === input.subscriptions.length
                ? 'failed'
                : 'partial'
          const summary = `Imported ${importedTotal} resource(s) across ${input.subscriptions.length} subscription(s)${
            failures ? ` · ${failures} failed` : ''
          }`
          const errorDetail = failureReasons.slice(0, 5).join(' | ')
          appendRetrievalLog(
            jobId,
            status === 'failed' ? 'error' : status === 'partial' ? 'warn' : 'success',
            `Inventory retrieval ${status}: ${summary}`,
            errorDetail ? { details: errorDetail } : undefined,
          )
          patchRetrievalJob(jobId, (j) => ({
            ...j,
            status,
            summary,
            error: failures ? errorDetail || summary : undefined,
            finishedAt,
            updatedAt: finishedAt,
            progressCurrent: j.progressTotal,
          }))
        } finally {
          retrievalStartLocksRef.current.inventory = false
        }
      })

      return jobId
    },
    [appendRetrievalLog, enqueueAzureJob, patchRetrievalJob],
  )

  const startQuotaRetrieval = useCallback(
    (input: StartQuotaRetrievalInput) => {
      const hasActive = retrievalJobsRef.current.some(
        (job) => job.kind === 'quotas' && (job.status === 'queued' || job.status === 'running'),
      )
      if (hasActive || retrievalStartLocksRef.current.quotas) {
        return null
      }
      retrievalStartLocksRef.current.quotas = true

      const currentUser = userRef.current
      const now = new Date().toISOString()
      const jobId = `ret-qta-${Date.now()}`
      const job: RetrievalJob = {
        id: jobId,
        kind: 'quotas',
        status: 'queued',
        initiatedByUserId: currentUser.id,
        initiatedByName: currentUser.name,
        customerId: input.customerId,
        customerName: input.customerName,
        tenantId: input.tenantId,
        regions: input.regions,
        subscriptionIds: input.subscriptions.map((s) => s.id),
        subscriptionNames: input.subscriptions.map((s) => s.name),
        startedAt: now,
        updatedAt: now,
        progressCurrent: 0,
        progressTotal: Math.max(input.subscriptions.length, 1),
        log: [
          makeLogEntry(
            {
              id: jobId,
              kind: 'quotas',
              initiatedByUserId: currentUser.id,
              initiatedByName: currentUser.name,
              customerId: input.customerId,
              customerName: input.customerName,
            },
            'info',
            `Quota retrieval queued for ${input.customerName} across ${input.subscriptions.length} subscription(s).`,
            {
              details: `Regions: ${input.regions.join(', ') || 'default'} · ${input.subscriptions
                .map((s) => s.name)
                .join(', ')}`,
            },
          ),
        ],
      }

      setRetrievalJobs((prev) => [job, ...prev].slice(0, 40))

      void enqueueAzureJob(async () => {
        try {
          patchRetrievalJob(jobId, (j) => ({
            ...j,
            status: 'running',
            updatedAt: new Date().toISOString(),
          }))
          appendRetrievalLog(
            jobId,
            'info',
            `Started quota retrieval in background for ${input.customerName}. You can leave Azure Connect safely.`,
          )

          let savedTotal = 0
          let failures = 0
          const failureReasons: string[] = []

          for (let index = 0; index < input.subscriptions.length; index += 1) {
            const sub = input.subscriptions[index]
            appendRetrievalLog(jobId, 'info', `Collecting quotas for subscription ${sub.name}`, {
              subscriptionId: sub.id,
              subscriptionName: sub.name,
              details: `Step ${index + 1} of ${input.subscriptions.length} · regions ${input.regions.join(', ')}`,
            })
            try {
              const localSub = await ensureSubscriptionRef.current(input.customerId, {
                subscriptionId: sub.id,
                name: sub.name,
                regions: [],
              })
              const data = await collectAndPersistQuotas({
                subscriptionId: sub.id,
                customerId: input.customerId,
                localSubscriptionId: localSub.id,
                regions: input.regions,
              })
              const saved =
                typeof data.saved === 'number' ? data.saved : data.quotas?.length || 0
              savedTotal += saved
              const providerCount = new Set(
                (data.quotas || []).map((q) => q.quotaGroup).filter(Boolean),
              ).size
              appendRetrievalLog(
                jobId,
                'success',
                `Saved ${saved} quota row(s) for ${sub.name}`,
                {
                  subscriptionId: sub.id,
                  subscriptionName: sub.name,
                  details: providerCount
                    ? `${providerCount} provider group(s)`
                    : data.errors?.length
                      ? `${data.errors.length} provider warning(s)`
                      : undefined,
                },
              )
            } catch (err) {
              failures += 1
              const reason = err instanceof Error ? err.message : String(err)
              failureReasons.push(`${sub.name}: ${reason}`)
              appendRetrievalLog(jobId, 'error', `Quota collection failed for ${sub.name}`, {
                subscriptionId: sub.id,
                subscriptionName: sub.name,
                details: reason,
              })
            }
            patchRetrievalJob(jobId, (j) => ({
              ...j,
              progressCurrent: index + 1,
              updatedAt: new Date().toISOString(),
            }))
          }

          try {
            await refreshBootstrapRef.current()
          } catch {
            // best-effort
          }

          const finishedAt = new Date().toISOString()
          const status =
            failures === 0
              ? 'succeeded'
              : failures === input.subscriptions.length
                ? 'failed'
                : 'partial'
          const summary = `Saved ${savedTotal} quota row(s) across ${input.subscriptions.length} subscription(s)${
            failures ? ` · ${failures} failed` : ''
          }`
          const errorDetail = failureReasons.slice(0, 5).join(' | ')
          appendRetrievalLog(
            jobId,
            status === 'failed' ? 'error' : status === 'partial' ? 'warn' : 'success',
            `Quota retrieval ${status}: ${summary}`,
            errorDetail ? { details: errorDetail } : undefined,
          )
          patchRetrievalJob(jobId, (j) => ({
            ...j,
            status,
            summary,
            error: failures ? errorDetail || summary : undefined,
            finishedAt,
            updatedAt: finishedAt,
            progressCurrent: j.progressTotal,
          }))
        } finally {
          retrievalStartLocksRef.current.quotas = false
        }
      })

      return jobId
    },
    [appendRetrievalLog, enqueueAzureJob, patchRetrievalJob],
  )

  const collectQuotaGroups = useCallback(
    async (input: {
      customerId: string
      customerName: string
      tenantId?: string
      regions?: string[]
      managementGroupId?: string
    }) => {
      const data = await collectAndPersistQuotaGroups({
        customerId: input.customerId,
        tenantId: input.tenantId,
        regions: input.regions,
        managementGroupId: input.managementGroupId,
      })
      await refreshBootstrapRef.current()
      return {
        saved: data.saved,
        discoveredGroups: data.discoveredGroups,
        errors: data.errors,
        hint: data.hint,
      }
    },
    [],
  )

  const isRetrievalRunning = useCallback(
    (kind?: 'inventory' | 'quotas') => {
      return retrievalJobs.some(
        (job) =>
          (job.status === 'running' || job.status === 'queued') &&
          (!kind || job.kind === kind),
      )
    },
    [retrievalJobs],
  )

  const retrievalLog = useMemo(() => {
    return retrievalJobs
      .flatMap((job) => job.log)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }, [retrievalJobs])

  const activeRetrievalCount = useMemo(
    () => retrievalJobs.filter((j) => j.status === 'running' || j.status === 'queued').length,
    [retrievalJobs],
  )

  const createConstraint = useCallback(
    async (input: CreateConstraintInput) => {
      const id = `cc-${Date.now()}`
      const now = new Date().toISOString()
      const constraint: CapacityConstraint = {
        id,
        ...input,
        reportedDate: now,
        status: 'Open',
        createdBy: user.id,
        updatedAt: now,
        history: [
          {
            id: `h-${Date.now()}`,
            at: now,
            by: user.id,
            action: 'Created',
            detail: `Constraint recorded from ${input.source}.`,
          },
        ],
      }

      const analysis = await runImpactAnalysis({
        sku: input.sku,
        resourceType: input.resourceType,
        regions: input.regions,
        customerId: input.customerId,
        subscriptionId: input.subscriptionId,
        constraintId: id,
      })
      const impacts: ImpactResult[] = analysis.impacts

      const newAlerts: AlertItem[] = impacts.map((imp, index) => {
        const customer = customersRef.current.find((c) => c.id === imp.customerId)
        return {
          id: `a-${Date.now()}-${index}`,
          constraintId: id,
          customerId: imp.customerId,
          csaOwnerId: customer?.csaOwnerId || user.id,
          channel: index % 2 === 0 ? 'In-app' : 'Teams',
          title: `${input.sku} capacity risk — ${customer?.name ?? 'Customer'}`,
          message: `${customer?.name ?? 'Customer'} has ${imp.matchingResourceCount} matching resource(s) in ${imp.region}.`,
          createdAt: now,
          read: false,
        }
      })

      const withAnalysis: CapacityConstraint = {
        ...constraint,
        history: [
          ...constraint.history,
          {
            id: `h-${Date.now()}-imp`,
            at: now,
            by: 'system',
            action: 'Impact analysis',
            detail: `Impact analysis completed against inventory database — ${analysis.summary.customerCount} customers, ${analysis.summary.resourceCount} resources matched.`,
          },
        ],
      }

      await persistConstraintBundle({
        constraint: withAnalysis,
        impacts,
        alerts: newAlerts,
      })

      setConstraints((prev) => [withAnalysis, ...prev])
      setImpactResults((prev) => [...impacts, ...prev])
      setAlerts((prev) => [...newAlerts, ...prev])
      awardPoints('constraint_created', `Recorded ${input.sku} constraint`, id)
      return withAnalysis
    },
    [user.id, awardPoints],
  )

  const updateConstraintStatus = useCallback(
    async (id: string, status: ConstraintStatus, detail: string) => {
      const current = constraintsRef.current.find((c) => c.id === id)
      if (!current) return
      const now = new Date().toISOString()
      const updated: CapacityConstraint = {
        ...current,
        status,
        updatedAt: now,
        history: [
          ...current.history,
          {
            id: `h-${Date.now()}`,
            at: now,
            by: user.id,
            action: 'Status update',
            detail,
          },
        ],
      }
      await persistConstraint(updated)
      setConstraints((prev) => prev.map((c) => (c.id === id ? updated : c)))
      if (status === 'Resolved' && current.status !== 'Resolved') {
        awardPoints('constraint_resolved', `Resolved ${current.sku}`, id)
      }
    },
    [user.id, awardPoints],
  )

  const rerunImpact = useCallback(async (constraintId: string) => {
    const constraint = constraintsRef.current.find((c) => c.id === constraintId)
    if (!constraint) return
    const analysis = await runImpactAnalysis({
      sku: constraint.sku,
      resourceType: constraint.resourceType,
      regions: constraint.regions,
      customerId: constraint.customerId,
      subscriptionId: constraint.subscriptionId,
      constraintId: constraint.id,
    })
    const impacts: ImpactResult[] = analysis.impacts
    const now = new Date().toISOString()
    const updated: CapacityConstraint = {
      ...constraint,
      updatedAt: now,
      history: [
        ...constraint.history,
        {
          id: `h-${Date.now()}`,
          at: now,
          by: 'system',
          action: 'Impact analysis',
          detail: `Re-ran impact analysis against inventory database — ${analysis.summary.customerCount} customers, ${analysis.summary.resourceCount} resources matched.`,
        },
      ],
    }
    await persistConstraint(updated)
    await persistConstraintImpacts(constraintId, impacts)
    setImpactResults((prev) => [...impacts, ...prev.filter((i) => i.constraintId !== constraintId)])
    setConstraints((prev) => prev.map((c) => (c.id === constraintId ? updated : c)))
  }, [])

  const markAlertRead = useCallback(async (id: string) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, read: true } : a)))
    try {
      await persistAlertRead(id)
    } catch (err) {
      console.error('Failed to persist alert read state', err)
    }
  }, [])

  const createEngagement = useCallback(
    async (constraintId: string, customerId: string, notes: string) => {
      const engagement: Engagement = {
        id: `e-${Date.now()}`,
        constraintId,
        customerId,
        initiatedBy: user.id,
        status: 'Requested',
        notes,
        createdAt: new Date().toISOString(),
      }
      const customer = customersRef.current.find((c) => c.id === customerId)
      awardPoints(
        'engagement_started',
        `Engaged Capacity for ${customer?.name ?? 'customer'}`,
        engagement.id,
      )
      setEngagements((prev) => [engagement, ...prev])
      try {
        await persistEngagement({ engagement, reward: null })
      } catch (err) {
        console.error('Failed to persist engagement', err)
      }
    },
    [user.id, awardPoints],
  )

  const value: AppContextValue = {
    user,
    setRole,
    customers,
    subscriptions,
    inventory,
    quotas,
    quotaGroupLimits,
    users,
    syncJobs,
    constraints,
    impactResults,
    alerts,
    engagements,
    rewardEvents,
    latestReward,
    dismissRewardToast,
    getUserPoints,
    createConstraint,
    updateConstraintStatus,
    rerunImpact,
    markAlertRead,
    createEngagement,
    upsertTenantCustomer,
    ensureSubscription,
    importTenantInventory,
    importTenantQuotas,
    refreshBootstrap,
    dataReady,
    dataError,
    persistedConnection,
    savePersistedConnection,
    azureConnection,
    azureSessionReady,
    azureLocations,
    azureLocationsLoading,
    azureLocationsError,
    azureConnectWorkspace,
    ensureAzureSession,
    loadAzureLocations,
    setAzureSession,
    clearAzureSession,
    patchAzureConnectWorkspace,
    resetAzureConnectWorkspace,
    portfolioCustomerIds,
    canSeeAllPortfolios,
    retrievalJobs,
    retrievalLog,
    activeRetrievalCount,
    isRetrievalRunning,
    startInventoryRetrieval,
    startQuotaRetrieval,
    collectQuotaGroups,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
