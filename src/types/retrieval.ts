export type RetrievalKind = 'inventory' | 'quotas'

export type RetrievalJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'partial'

export type RetrievalLogLevel = 'info' | 'success' | 'warn' | 'error'

export interface RetrievalLogEntry {
  id: string
  at: string
  level: RetrievalLogLevel
  message: string
  kind: RetrievalKind
  jobId: string
  initiatedByUserId: string
  initiatedByName: string
  customerId?: string
  customerName?: string
  subscriptionId?: string
  subscriptionName?: string
  details?: string
}

export interface RetrievalJob {
  id: string
  kind: RetrievalKind
  status: RetrievalJobStatus
  initiatedByUserId: string
  initiatedByName: string
  customerId: string
  customerName: string
  tenantId?: string
  regions?: string[]
  subscriptionIds: string[]
  subscriptionNames: string[]
  startedAt: string
  updatedAt: string
  finishedAt?: string
  progressCurrent: number
  progressTotal: number
  summary?: string
  error?: string
  log: RetrievalLogEntry[]
}

export interface StartInventoryRetrievalInput {
  customerId: string
  customerName: string
  tenantId?: string
  subscriptions: Array<{ id: string; name: string }>
  regions?: string[]
}

export interface StartQuotaRetrievalInput {
  customerId: string
  customerName: string
  tenantId?: string
  subscriptions: Array<{ id: string; name: string }>
  regions: string[]
}
