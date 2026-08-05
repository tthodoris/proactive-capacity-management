import { apiErrorFromResponse } from './apiError'

export type AzureConnectionStatus =
  | 'idle'
  | 'awaiting_device_code'
  | 'authenticating'
  | 'connected'
  | 'error'
  | 'cancelled'

export interface AzureConnection {
  status: AzureConnectionStatus
  tenantId: string | null
  deviceCode: string | null
  verificationUrl: string | null
  message: string | null
  error: string | null
  account: {
    id?: string
    name?: string
    tenantId?: string
    user?: { name?: string }
  } | null
  startedAt: string | null
  connectedAt: string | null
}

export interface AzureSubscriptionOption {
  id: string
  name: string
  tenantId?: string
  state?: string
  isDefault?: boolean
}

export interface TenantInfoResponse {
  account: AzureConnection['account']
  organization: {
    id?: string
    displayName?: string
    verifiedDomains?: Array<{ name?: string; isDefault?: boolean }>
  } | null
  graphError?: string | null
  fetchedAt: string
}

export interface LiveQuotaRow {
  id: string
  name: string
  nameValue: string | null
  subscriptionId: string
  subscriptionName: string
  tenantId: string
  region: string
  usage: number
  limit: number
  unit: string
  source: string
  quotaGroup: string
}

export interface LiveQuotasResponse {
  fetchedAt: string
  account: AzureConnection['account']
  organization: TenantInfoResponse['organization']
  subscriptions: Array<{ id: string; name: string; isDefault?: boolean }>
  regions: string[]
  quotas: LiveQuotaRow[]
  resourceGraphSummary: Array<{
    subscriptionId?: string
    location?: string
    type?: string
    sku?: string
    resourceCount?: number
  }>
  errors: Array<Record<string, string>>
}

export interface LiveInventoryResource {
  id: string
  name: string
  type: string
  resourceType: string
  sku: string
  size?: string
  region: string
  resourceGroup: string
  subscriptionId: string
  source: 'Customer tenant'
}

export interface LiveInventoryResponse {
  fetchedAt: string
  account: AzureConnection['account']
  subscriptionId: string
  count: number
  resources: LiveInventoryResource[]
  query: string
}

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

export function getAzureStatus() {
  return api<AzureConnection>('/api/azure/status')
}

export function connectTenant(tenantId: string) {
  return api<AzureConnection>('/api/azure/connect', {
    method: 'POST',
    body: JSON.stringify({ tenantId }),
  })
}

export function cancelAzureLogin() {
  return api<AzureConnection>('/api/azure/cancel', { method: 'POST' })
}

export function disconnectTenant() {
  return api<AzureConnection>('/api/azure/disconnect', { method: 'POST' })
}

export function fetchTenantInfo() {
  return api<TenantInfoResponse>('/api/azure/tenant-info')
}

export function fetchSubscriptions() {
  return api<{
    account: AzureConnection['account']
    subscriptions: AzureSubscriptionOption[]
    selectedSubscriptionId: string
    fetchedAt: string
  }>('/api/azure/subscriptions')
}

export function setSubscription(subscriptionId: string) {
  return api<{
    ok: boolean
    account: AzureConnection['account']
    selectedSubscriptionId: string
  }>('/api/azure/subscription', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId }),
  })
}

export function fetchLiveQuotas(regions?: string[], subscriptionId?: string) {
  const params = new URLSearchParams()
  if (regions?.length) params.set('regions', regions.join(','))
  if (subscriptionId) params.set('subscriptionId', subscriptionId)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return api<LiveQuotasResponse>(`/api/azure/quotas${qs}`)
}

export function collectAndPersistQuotas(payload: {
  subscriptionId: string
  customerId: string
  localSubscriptionId: string
  regions?: string[]
}) {
  return api<LiveQuotasResponse & { saved: number }>('/api/azure/quotas/collect', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface LiveQuotaGroupLimitRow {
  id: string
  customerId?: string
  tenantId?: string
  managementGroupId: string
  groupQuotaName: string
  groupDisplayName?: string | null
  subscriptionIds: string[]
  region: string
  name: string
  nameValue?: string | null
  limit: number
  availableLimit: number
  allocated: number
  unit: string
  resourceProvider: string
  source?: string
  collectedAt?: string
}

export interface LiveQuotaGroupsResponse {
  fetchedAt: string
  account: AzureConnection['account']
  regions: string[]
  quotaGroupLimits: LiveQuotaGroupLimitRow[]
  discoveredGroups?: Array<{
    managementGroupId: string
    groupQuotaName: string
    groupDisplayName?: string
  }>
  saved: number
  errors: Array<Record<string, string>>
  hint?: string
}

export function collectAndPersistQuotaGroups(payload: {
  customerId: string
  tenantId?: string
  managementGroupId?: string
  regions?: string[]
}) {
  return api<LiveQuotaGroupsResponse>('/api/azure/quota-groups/collect', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function fetchLiveInventory(subscriptionId: string, regions?: string[]) {
  const params = new URLSearchParams()
  params.set('subscriptionId', subscriptionId)
  if (regions?.length) params.set('regions', regions.join(','))
  return api<LiveInventoryResponse>(`/api/azure/inventory?${params.toString()}`)
}

export interface AzureRegionOption {
  id: string
  label: string
  resourceCount: number
}

export interface DeployedRegionsResponse {
  fetchedAt: string
  account: AzureConnection['account']
  subscriptionIds: string[]
  regions: AzureRegionOption[]
  hint?: string
}

export function fetchDeployedRegions(subscriptionIds?: string[]) {
  const params = new URLSearchParams()
  if (subscriptionIds?.length) params.set('subscriptionIds', subscriptionIds.join(','))
  const qs = params.toString() ? `?${params.toString()}` : ''
  return api<DeployedRegionsResponse>(`/api/azure/regions${qs}`)
}

export interface AzureLocationOption {
  id: string
  label: string
}

export interface AzureLocationsResponse {
  fetchedAt: string
  locations: AzureLocationOption[]
  connection?: AzureConnection
}

export function fetchAzureLocations() {
  return api<AzureLocationsResponse>('/api/azure/locations')
}

export type RegionEvalStatus = 'available' | 'unavailable' | 'restricted' | 'unknown'

export interface RegionEvalItemInput {
  resourceType: string
  sku: string
  size?: string
  resourceCount: number
  sourceRegions: string[]
  sourceRegionCounts?: Record<string, number>
}

export interface RegionEvalRegionResult {
  available: boolean | null
  status: RegionEvalStatus
  reason: string
  label?: string
  /** Retail unit price for this SKU in the region (when available). */
  unitPrice?: number | null
  /** Estimated monthly unit price (hour meters × 730). */
  monthlyUnitPrice?: number | null
  /** monthlyUnitPrice × resourceCount for the inventory fingerprint. */
  monthlyTotalPrice?: number | null
  currencyCode?: string | null
  unitOfMeasure?: string | null
  productName?: string | null
  meterName?: string | null
  costNote?: string | null
  pricingMode?: string | null
  resourceCount?: number | null
}

export interface RegionEvalRow {
  resourceType: string
  sku: string
  size: string | null
  family: string | null
  resourceCount: number
  sourceRegions: string[]
  sourceRegionMeta?: Array<{ id: string; label: string }>
  sourceRegionCounts?: Record<string, number> | null
  bySourceRegion?: Record<string, RegionEvalRegionResult>
  byRegion: Record<string, RegionEvalRegionResult>
}

export interface RegionEvalLineItem {
  subscriptionId: string
  subscriptionName: string
  azureSubscriptionId?: string
  resourceName: string
  resourceType: string
  sku: string
  size?: string
  sourceRegion: string
  sourceRegionId?: string
  sourceCost: RegionEvalRegionResult | null
  byRegion: Record<string, RegionEvalRegionResult>
}

export interface SavedRegionEvaluation {
  id: string
  customerId: string
  customerName: string
  createdByUserId?: string | null
  createdByName?: string | null
  azureSubscriptionId?: string | null
  subscriptionIds: string[]
  subscriptionNames: string[]
  targetRegions: AzureLocationOption[]
  summary: RegionEvaluationResponse['summary']
  results: RegionEvalRow[]
  lineItems: RegionEvalLineItem[]
  errors: Array<{ scope: string; message: string }>
  createdAt: string
}

export interface RegionEvaluationResponse {
  fetchedAt: string
  account: AzureConnection['account']
  azureSubscriptionId: string
  targetRegions: AzureLocationOption[]
  results: RegionEvalRow[]
  summary: {
    itemCount: number
    fullyAvailable: number
    partiallyAvailable: number
    unavailable: number
    unknown: number
  }
  errors: Array<{ scope: string; message: string }>
}

export function evaluateRegions(payload: {
  azureSubscriptionId: string
  targetRegions: Array<string | AzureLocationOption>
  items: RegionEvalItemInput[]
}) {
  return api<RegionEvaluationResponse>('/api/azure/region-evaluation', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
