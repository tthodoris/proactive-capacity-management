import type {
  AlertItem,
  CapacityConstraint,
  Customer,
  Engagement,
  ImpactResult,
  InventoryItem,
  QuotaGroupLimit,
  RewardEvent,
  Subscription,
} from '../types'
import type { SavedReport, SavedReportConfig } from './reports'
import type { LiveQuotaRow } from './azureApi'
import { apiErrorFromResponse } from './apiError'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw apiErrorFromResponse(res, data)
  }
  return data as T
}

export interface PersistedQuota {
  id: string
  customerId?: string | null
  subscriptionId?: string | null
  azureSubscriptionId: string
  subscriptionName?: string | null
  tenantId?: string | null
  region: string
  name: string
  nameValue?: string | null
  usage: number
  limit: number
  unit: string
  source: string
  quotaGroup?: string | null
  collectedAt?: string
}

export interface PersistedConnection {
  tenantId?: string | null
  organizationName?: string | null
  selectedSubscriptionId?: string | null
  selectedSubscriptionName?: string | null
  account?: Record<string, unknown> | null
  status?: string
  updatedAt?: string | null
}

export interface BootstrapData {
  customers: Customer[]
  subscriptions: Subscription[]
  inventory: InventoryItem[]
  quotas: PersistedQuota[]
  quotaGroupLimits: QuotaGroupLimit[]
  connection: PersistedConnection | null
  constraints: CapacityConstraint[]
  impactResults: ImpactResult[]
  alerts: AlertItem[]
  engagements: Engagement[]
  rewardEvents: RewardEvent[]
}

export function fetchBootstrap() {
  return api<BootstrapData>('/api/data/bootstrap')
}

export function persistCustomer(customer: Customer) {
  return api<Customer>('/api/data/customers', {
    method: 'POST',
    body: JSON.stringify(customer),
  })
}

export function persistSubscription(subscription: Subscription) {
  return api<Subscription>('/api/data/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription),
  })
}

export function persistInventory(payload: {
  customerId: string
  subscriptionId: string
  items: Array<InventoryItem & { azureSubscriptionId?: string; collectedAt?: string }>
}) {
  return api<{ imported: number }>('/api/data/inventory', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function persistQuotas(payload: {
  azureSubscriptionId: string
  customerId?: string
  subscriptionId?: string
  items: Array<
    PersistedQuota | (LiveQuotaRow & { customerId?: string; collectedAt?: string })
  >
}) {
  return api<{ imported: number }>('/api/data/quotas', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function persistQuotaGroupLimits(payload: {
  customerId: string
  tenantId?: string
  items: QuotaGroupLimit[]
}) {
  return api<{ imported: number }>('/api/data/quota-groups', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function persistConnection(connection: PersistedConnection) {
  return api<PersistedConnection>('/api/data/connection', {
    method: 'PUT',
    body: JSON.stringify(connection),
  })
}

export function clearPersistedConnection() {
  return api<{ ok: boolean }>('/api/data/connection', { method: 'DELETE' })
}

export function persistConstraintBundle(payload: {
  constraint: CapacityConstraint
  impacts?: ImpactResult[]
  alerts?: AlertItem[]
  reward?: RewardEvent | null
}) {
  return api<{
    constraint: CapacityConstraint
    impacts: ImpactResult[]
    alerts: AlertItem[]
    reward: RewardEvent | null
  }>('/api/data/constraints', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function persistConstraint(constraint: CapacityConstraint) {
  return api<CapacityConstraint>(`/api/data/constraints/${encodeURIComponent(constraint.id)}`, {
    method: 'PUT',
    body: JSON.stringify(constraint),
  })
}

export function persistConstraintImpacts(constraintId: string, impacts: ImpactResult[]) {
  return api<{ impacts: ImpactResult[] }>(
    `/api/data/constraints/${encodeURIComponent(constraintId)}/impacts`,
    {
      method: 'POST',
      body: JSON.stringify({ impacts }),
    },
  )
}

export function persistReward(event: RewardEvent) {
  return api<RewardEvent>('/api/data/rewards', {
    method: 'POST',
    body: JSON.stringify(event),
  })
}

export function persistEngagement(payload: {
  engagement: Engagement
  reward?: RewardEvent | null
}) {
  return api<{ engagement: Engagement; reward: RewardEvent | null }>('/api/data/engagements', {
    method: 'POST',
    body: JSON.stringify({ ...payload.engagement, reward: payload.reward || null }),
  })
}

export function persistAlertRead(id: string) {
  return api<AlertItem>(`/api/data/alerts/${encodeURIComponent(id)}/read`, {
    method: 'PATCH',
  })
}

export function fetchSavedReports(userId: string) {
  return api<{ reports: SavedReport[] }>(
    `/api/data/saved-reports?userId=${encodeURIComponent(userId)}`,
  )
}

export function persistSavedReport(payload: {
  id?: string
  name: string
  ownerUserId: string
  visibility: SavedReport['visibility']
  config: SavedReportConfig
}) {
  return api<SavedReport>('/api/data/saved-reports', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function deleteSavedReport(id: string, userId: string) {
  return api<{ ok: boolean }>(`/api/data/saved-reports/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ userId }),
  })
}

export function fetchRegionEvaluations(customerId?: string) {
  const qs = customerId ? `?customerId=${encodeURIComponent(customerId)}` : ''
  return api<{ evaluations: import('./azureApi').SavedRegionEvaluation[] }>(
    `/api/data/region-evaluations${qs}`,
  )
}

export function fetchRegionEvaluation(id: string) {
  return api<import('./azureApi').SavedRegionEvaluation>(
    `/api/data/region-evaluations/${encodeURIComponent(id)}`,
  )
}

export function persistRegionEvaluation(
  payload: Omit<import('./azureApi').SavedRegionEvaluation, 'id' | 'createdAt'> & {
    id?: string
  },
) {
  return api<import('./azureApi').SavedRegionEvaluation>('/api/data/region-evaluations', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function deleteRegionEvaluation(id: string) {
  return api<{ ok: boolean }>(`/api/data/region-evaluations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export interface InventorySkuOption {
  sku: string
  resourceCount: number
  regions: string[]
  sizes: string[]
}

export interface InventoryResourceTypeOption {
  resourceType: string
  resourceCount: number
}

export function fetchInventoryResourceTypes() {
  return api<{ resourceTypes: InventoryResourceTypeOption[] }>(
    '/api/data/inventory/resource-types',
  )
}

export function fetchInventorySkus(resourceType: string) {
  const q = encodeURIComponent(resourceType)
  return api<{ resourceType: string; skus: InventorySkuOption[] }>(
    `/api/data/inventory/skus?resourceType=${q}`,
  )
}

export function runImpactAnalysis(payload: {
  sku: string
  resourceType: string
  regions: string[]
  customerId?: string
  subscriptionId?: string
  constraintId?: string
}) {
  return api<{
    impacts: Array<{
      id: string
      constraintId: string
      customerId: string
      subscriptionId: string
      region: string
      matchingResourceCount: number
      skus: string[]
    }>
    summary: {
      customerCount: number
      resourceCount: number
      rowCount: number
    }
  }>('/api/data/impact-analysis', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
