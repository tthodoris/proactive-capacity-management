import { apiErrorFromResponse } from './apiError'

export type UatIdentity = {
  displayName: string | null
  uniqueName: string | null
  imageUrl?: string | null
}

export type UatFieldRow = {
  name: string
  value: string
}

export type UatWorkItem = {
  id: number | null
  rev: number | null
  url: string | null
  htmlUrl: string | null
  workItemType: string | null
  title: string | null
  state: string | null
  reason: string | null
  assignedTo: UatIdentity | null
  createdBy: UatIdentity | null
  changedBy: UatIdentity | null
  areaPath: string | null
  iterationPath: string | null
  teamProject: string | null
  createdDate: string | null
  changedDate: string | null
  tags: string | null
  priority: number | string | null
  severity: string | null
  description: string | null
  reproSteps: string | null
  acceptanceCriteria: string | null
  priorityFieldNames: string[]
  fields: UatFieldRow[]
  relations: Array<Record<string, unknown>>
  raw?: Record<string, unknown>
}

export type UatListItem = {
  id: number | null
  title: string | null
  state: string | null
  account: string | null
  eou: string | null
  areaField: string | null
  milestoneReason: string | null
  requestors: string | null
  tpid: string | null
  noNaiSku1: string | null
  noNaiUom1: string | null
  noNaiQuantity1: string | null
  estMonthlyUsages: string | null
  requestedDate: string | null
  opportunityId: string | null
  milestoneId: string | null
  azurePreferredRegion: string | null
  azureCapacityTypeMultiline: string | null
  primaryCompetitor: string | null
  actionPriority: string | null
  noNaiRegional: string | null
  changedDate: string | null
  workItemType: string | null
  htmlUrl: string | null
}

export type UatWorkItemFilters = {
  state?: string
  account?: string
  id?: string
  eou?: string
  areaField?: string
}

export type UatWorkItemList = {
  milestoneReason: string
  excludedAreaFields?: string[]
  excludedPreferredRegions?: string[]
  fieldMap?: Record<string, string>
  total: number
  queried: number
  included?: number
  saved?: number
  source?: 'ado' | 'db'
  lastRetrievedAt?: string | null
  filters?: Required<UatWorkItemFilters>
  facets?: {
    state: string[]
    account: string[]
    eou: string[]
    areaField: string[]
    azurePreferredRegion?: string[]
  }
  items: UatListItem[]
}

export type UatConnection = {
  status:
    | 'idle'
    | 'awaiting_device_code'
    | 'authenticating'
    | 'connected'
    | 'error'
    | 'cancelled'
  tenantId: string | null
  organization: string
  organizationUrl: string
  deviceCode: string | null
  verificationUrl: string
  message: string | null
  error: string | null
  account: {
    name?: string
    tenantId?: string
    user?: { name?: string }
  } | null
  startedAt: string | null
  connectedAt: string | null
  authMode: 'azure_cli' | 'pasted_token' | 'pat' | 'none'
  hasPat: boolean
}

export type UatConfig = {
  organization: string
  organizationUrl: string
  tenantId: string
  defaultWorkItemId: number
  authMode: 'azure_cli' | 'pasted_token' | 'pat' | 'none'
  hasPat: boolean
  testWorkItemUrl: string
  connection: UatConnection
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

export function fetchUatConfig() {
  return api<UatConfig>('/api/uat/config')
}

export function fetchUatStatus() {
  return api<UatConnection>('/api/uat/status')
}

export function connectUat() {
  return api<UatConnection>('/api/uat/connect', { method: 'POST', body: '{}' })
}

export function cancelUatLogin() {
  return api<UatConnection>('/api/uat/cancel', { method: 'POST', body: '{}' })
}

export function disconnectUat() {
  return api<UatConnection>('/api/uat/disconnect', { method: 'POST', body: '{}' })
}

export function submitUatAccessToken(accessToken: string, expiresOn?: string | null) {
  return api<UatConnection>('/api/uat/token', {
    method: 'POST',
    body: JSON.stringify({ accessToken, expiresOn: expiresOn || null }),
  })
}

export function fetchUatWorkItemList(
  filters: UatWorkItemFilters & { source?: 'ado' | 'db' } = {},
) {
  const params = new URLSearchParams()
  if (filters.source) params.set('source', filters.source)
  if (filters.state) params.set('state', filters.state)
  if (filters.account) params.set('account', filters.account)
  if (filters.id) params.set('id', filters.id)
  if (filters.eou) params.set('eou', filters.eou)
  if (filters.areaField) params.set('areaField', filters.areaField)
  const qs = params.toString()
  return api<UatWorkItemList>(`/api/uat/workitems${qs ? `?${qs}` : ''}`)
}

export function fetchUatWorkItem(id?: number | string) {
  if (id == null || id === '') {
    return api<UatWorkItemList>('/api/uat/workitems')
  }
  return api<UatWorkItem>(`/api/uat/workitems/${encodeURIComponent(String(id))}`)
}
