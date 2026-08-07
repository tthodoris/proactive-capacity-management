export type UserRole = 'CSA' | 'Capacity Manager' | 'Administrator'

export type ConstraintSeverity = 'Critical' | 'High' | 'Medium' | 'Low'
export type ConstraintStatus = 'Open' | 'Under investigation' | 'Mitigating' | 'Resolved'
export type ConstraintScope = 'Region' | 'Subscription' | 'Customer'
export type AlertChannel = 'Teams' | 'Email' | 'In-app'
export type ResourceType =
  | 'Virtual Machine'
  | 'Azure SQL Database'
  | 'Azure SQL Managed Instance'
  | 'Azure SQL Server'
  | 'Azure Database for MySQL'
  | 'Azure Database for PostgreSQL'
  | 'Azure Cosmos DB'
  | 'Azure Kubernetes Service'
  | 'Container Instances'
  | 'Azure Container Apps'
  | 'Azure Container Apps Environment'
  | 'Azure Databricks'
  | 'Azure Data Explorer'
  | 'Azure Cache for Redis'
  | 'Azure Managed Redis'
  | 'Key Vault'
  | 'Storage Account'
  | 'Application Gateway'
  | 'API Management'
  | 'VPN Gateway'
  /** @deprecated legacy inventory labels */
  | 'PaaS Database'
  | 'Container'
  | 'Azure SQL'
  | 'MySQL'
  | 'PostgreSQL'

export interface User {
  id: string
  name: string
  email: string
  role: UserRole
  avatarInitials: string
}

export type RewardAction = 'constraint_created' | 'engagement_started' | 'constraint_resolved'

export interface RewardEvent {
  id: string
  userId: string
  action: RewardAction
  points: number
  label: string
  relatedId?: string
  createdAt: string
}

export const REWARD_POINTS: Record<RewardAction, number> = {
  constraint_created: 50,
  engagement_started: 30,
  constraint_resolved: 75,
}

export interface Customer {
  id: string
  name: string
  tenantId: string
  csaOwnerId: string
  segment: string
  industry: string
  regionFocus: string[]
  lastSyncedAt: string
  syncSource: 'Internal system' | 'Customer tenant' | 'Both'
}

export interface Subscription {
  id: string
  customerId: string
  name: string
  subscriptionId: string
  regions: string[]
}

export interface InventoryItem {
  id: string
  customerId: string
  subscriptionId: string
  resourceType: ResourceType
  sku: string
  size?: string
  region: string
  resourceGroup: string
  name: string
  source: 'Internal system' | 'Customer tenant'
  collectedAt?: string
}

export interface Quota {
  id: string
  customerId?: string | null
  subscriptionId?: string | null
  azureSubscriptionId?: string | null
  subscriptionName?: string | null
  tenantId?: string | null
  region: string
  name: string
  nameValue?: string | null
  limit: number
  usage: number
  unit: string
  source?: string
  quotaGroup?: string | null
  collectedAt?: string
}

/** Azure Quota Group limit row — shared quota pool across subscriptions under a management group. */
export interface QuotaGroupLimit {
  id: string
  customerId?: string | null
  tenantId?: string | null
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

export interface CapacityConstraint {
  id: string
  sku: string
  resourceType: ResourceType
  regions: string[]
  scope: ConstraintScope
  subscriptionId?: string
  customerId?: string
  reportedDate: string
  source: string
  severity: ConstraintSeverity
  status: ConstraintStatus
  description: string
  createdBy: string
  updatedAt: string
  history: ConstraintHistoryEntry[]
}

export interface ConstraintHistoryEntry {
  id: string
  at: string
  by: string
  action: string
  detail: string
}

export interface ImpactResult {
  id: string
  constraintId: string
  customerId: string
  subscriptionId: string
  region: string
  matchingResourceCount: number
  skus: string[]
}

export interface AlertItem {
  id: string
  constraintId: string
  customerId: string
  csaOwnerId: string
  channel: AlertChannel
  title: string
  message: string
  createdAt: string
  read: boolean
}

export interface Engagement {
  id: string
  constraintId: string
  customerId: string
  initiatedBy: string
  status: 'Requested' | 'In progress' | 'Closed'
  notes: string
  createdAt: string
}

export interface SyncJob {
  id: string
  source: string
  status: 'Succeeded' | 'Running' | 'Failed'
  startedAt: string
  finishedAt?: string
  recordsProcessed: number
}
