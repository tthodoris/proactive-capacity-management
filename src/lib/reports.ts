import { formatDate } from './format'
import { resolveQuotaProvider } from './quotaProviders'
import type {
  CapacityConstraint,
  ConstraintStatus,
  Customer,
  ImpactResult,
  InventoryItem,
  Quota,
  QuotaGroupLimit,
  Subscription,
  User,
} from '../types'

export type ReportDatasource = 'inventory' | 'quotas' | 'quota-groups' | 'constraints'
export type ReportViewMode = 'detailed' | 'aggregated'
export type AggregationFn = 'count' | 'sum' | 'avg' | 'min' | 'max'
export type SavedReportVisibility = 'private' | 'shared'

export interface SavedReportConfig {
  datasource: ReportDatasource
  viewMode: ReportViewMode
  groupBy: string[]
  aggregations: AggregationSpec[]
}

export interface SavedReport {
  id: string
  name: string
  ownerUserId: string
  visibility: SavedReportVisibility
  config: SavedReportConfig
  createdAt: string
  updatedAt: string
}

export interface ReportFieldDef {
  id: string
  label: string
  kind: 'dimension' | 'measure'
}

export interface AggregationSpec {
  id: string
  fn: AggregationFn
  field?: string
}

export interface ReportContext {
  customers: Customer[]
  subscriptions: Subscription[]
  users?: User[]
  impactResults?: ImpactResult[]
}

export type ReportRow = Record<string, string | number>

const FN_LABELS: Record<AggregationFn, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
}

export const DATASOURCE_LABELS: Record<ReportDatasource, string> = {
  inventory: 'Inventory',
  quotas: 'Quotas',
  'quota-groups': 'Quota groups',
  constraints: 'Constraints',
}

export const REPORT_SCHEMAS: Record<ReportDatasource, ReportFieldDef[]> = {
  inventory: [
    { id: 'customer', label: 'Customer', kind: 'dimension' },
    { id: 'subscription', label: 'Subscription', kind: 'dimension' },
    { id: 'resourceType', label: 'Resource type', kind: 'dimension' },
    { id: 'sku', label: 'SKU', kind: 'dimension' },
    { id: 'region', label: 'Region', kind: 'dimension' },
    { id: 'resourceGroup', label: 'Resource group', kind: 'dimension' },
    { id: 'source', label: 'Source', kind: 'dimension' },
    { id: 'name', label: 'Resource name', kind: 'dimension' },
    { id: 'retrieved', label: 'Retrieved', kind: 'dimension' },
    { id: 'rows', label: 'Rows', kind: 'measure' },
  ],
  quotas: [
    { id: 'customer', label: 'Customer', kind: 'dimension' },
    { id: 'subscription', label: 'Subscription', kind: 'dimension' },
    { id: 'provider', label: 'Provider', kind: 'dimension' },
    { id: 'region', label: 'Region', kind: 'dimension' },
    { id: 'name', label: 'Quota', kind: 'dimension' },
    { id: 'quotaGroup', label: 'Quota group', kind: 'dimension' },
    { id: 'unit', label: 'Unit', kind: 'dimension' },
    { id: 'source', label: 'Source', kind: 'dimension' },
    { id: 'retrieved', label: 'Retrieved', kind: 'dimension' },
    { id: 'usage', label: 'Usage', kind: 'measure' },
    { id: 'limit', label: 'Limit', kind: 'measure' },
    { id: 'usagePct', label: 'Usage %', kind: 'measure' },
    { id: 'rows', label: 'Rows', kind: 'measure' },
  ],
  'quota-groups': [
    { id: 'customer', label: 'Customer', kind: 'dimension' },
    { id: 'group', label: 'Quota group', kind: 'dimension' },
    { id: 'managementGroup', label: 'Management group', kind: 'dimension' },
    { id: 'region', label: 'Region', kind: 'dimension' },
    { id: 'name', label: 'Quota', kind: 'dimension' },
    { id: 'unit', label: 'Unit', kind: 'dimension' },
    { id: 'resourceProvider', label: 'Resource provider', kind: 'dimension' },
    { id: 'subscriptions', label: 'Subscriptions', kind: 'dimension' },
    { id: 'source', label: 'Source', kind: 'dimension' },
    { id: 'retrieved', label: 'Retrieved', kind: 'dimension' },
    { id: 'allocated', label: 'Allocated', kind: 'measure' },
    { id: 'limit', label: 'Group limit', kind: 'measure' },
    { id: 'availableLimit', label: 'Available', kind: 'measure' },
    { id: 'subscriptionCount', label: 'Subscription count', kind: 'measure' },
    { id: 'allocatedPct', label: 'Allocated %', kind: 'measure' },
    { id: 'rows', label: 'Rows', kind: 'measure' },
  ],
  constraints: [
    { id: 'sku', label: 'SKU / type', kind: 'dimension' },
    { id: 'resourceType', label: 'Resource type', kind: 'dimension' },
    { id: 'regions', label: 'Regions', kind: 'dimension' },
    { id: 'scope', label: 'Scope', kind: 'dimension' },
    { id: 'severity', label: 'Severity', kind: 'dimension' },
    { id: 'status', label: 'Current status', kind: 'dimension' },
    { id: 'source', label: 'Source', kind: 'dimension' },
    { id: 'createdBy', label: 'Created by', kind: 'dimension' },
    { id: 'created', label: 'Created', kind: 'dimension' },
    { id: 'updated', label: 'Last updated', kind: 'dimension' },
    { id: 'openDate', label: 'Open date', kind: 'dimension' },
    { id: 'underInvestigationDate', label: 'Under investigation date', kind: 'dimension' },
    { id: 'mitigatingDate', label: 'Mitigating date', kind: 'dimension' },
    { id: 'resolvedDate', label: 'Resolved date', kind: 'dimension' },
    { id: 'affectedCustomers', label: 'Affected customers', kind: 'dimension' },
    { id: 'affectedCustomerCount', label: 'Affected customer count', kind: 'measure' },
    { id: 'matchingResources', label: 'Matching resources', kind: 'measure' },
    { id: 'rows', label: 'Rows', kind: 'measure' },
  ],
}

export const DETAILED_COLUMNS: Record<ReportDatasource, string[]> = {
  inventory: [
    'name',
    'customer',
    'subscription',
    'resourceType',
    'sku',
    'region',
    'resourceGroup',
    'source',
    'retrieved',
  ],
  quotas: [
    'name',
    'provider',
    'customer',
    'subscription',
    'region',
    'usage',
    'limit',
    'usagePct',
    'unit',
    'quotaGroup',
    'source',
    'retrieved',
  ],
  'quota-groups': [
    'group',
    'name',
    'customer',
    'managementGroup',
    'region',
    'allocated',
    'limit',
    'availableLimit',
    'allocatedPct',
    'unit',
    'subscriptions',
    'subscriptionCount',
    'source',
    'retrieved',
  ],
  constraints: [
    'sku',
    'resourceType',
    'regions',
    'scope',
    'severity',
    'status',
    'source',
    'created',
    'createdBy',
    'affectedCustomers',
    'affectedCustomerCount',
    'matchingResources',
    'openDate',
    'underInvestigationDate',
    'mitigatingDate',
    'resolvedDate',
    'updated',
  ],
}

export function defaultGroupBy(datasource: ReportDatasource): string[] {
  if (datasource === 'inventory') return ['customer', 'region', 'resourceType']
  if (datasource === 'quotas') return ['customer', 'region', 'provider']
  if (datasource === 'constraints') return ['status', 'severity', 'source']
  return ['customer', 'group', 'region']
}

export function defaultAggregations(datasource: ReportDatasource): AggregationSpec[] {
  if (datasource === 'inventory') {
    return [{ id: 'agg-count', fn: 'count' }]
  }
  if (datasource === 'quotas') {
    return [
      { id: 'agg-count', fn: 'count' },
      { id: 'agg-usage', fn: 'sum', field: 'usage' },
      { id: 'agg-limit', fn: 'sum', field: 'limit' },
      { id: 'agg-pct', fn: 'avg', field: 'usagePct' },
    ]
  }
  if (datasource === 'constraints') {
    return [
      { id: 'agg-count', fn: 'count' },
      { id: 'agg-customers', fn: 'sum', field: 'affectedCustomerCount' },
      { id: 'agg-resources', fn: 'sum', field: 'matchingResources' },
    ]
  }
  return [
    { id: 'agg-count', fn: 'count' },
    { id: 'agg-allocated', fn: 'sum', field: 'allocated' },
    { id: 'agg-limit', fn: 'sum', field: 'limit' },
    { id: 'agg-available', fn: 'sum', field: 'availableLimit' },
  ]
}

function formatSubscriptions(
  ctx: ReportContext,
  subscriptionIds: string[],
): { label: string; count: number } {
  if (!subscriptionIds.length) return { label: '—', count: 0 }
  const names = subscriptionIds.map(
    (id) => ctx.subscriptions.find((s) => s.subscriptionId === id)?.name || id,
  )
  const preview = names.slice(0, 2).join(', ')
  const suffix = names.length > 2 ? ` +${names.length - 2}` : ''
  return { label: `${preview}${suffix}`, count: names.length }
}

function resolveCustomerName(ctx: ReportContext, customerId?: string | null) {
  return ctx.customers.find((c) => c.id === customerId)?.name || '—'
}

function resolveSubscriptionName(ctx: ReportContext, subscriptionId?: string | null) {
  const sub = ctx.subscriptions.find((s) => s.id === subscriptionId)
  return sub?.name || '—'
}

const CONSTRAINT_STATUSES: ConstraintStatus[] = [
  'Open',
  'Under investigation',
  'Mitigating',
  'Resolved',
]

function normalizeConstraintStatus(value: string): ConstraintStatus | null {
  const match = CONSTRAINT_STATUSES.find((status) => status.toLowerCase() === value.trim().toLowerCase())
  return match || null
}

function parseStatusFromHistoryDetail(detail: string): ConstraintStatus | null {
  const moved = detail.match(/^Moved to (.+?)\.?$/i)
  if (moved) return normalizeConstraintStatus(moved[1])
  const setTo = detail.match(/^Status set to (.+?)\.?$/i)
  if (setTo) return normalizeConstraintStatus(setTo[1])
  return null
}

export function resolveConstraintStatusDates(constraint: CapacityConstraint) {
  const dates: Partial<Record<ConstraintStatus, string>> = {}
  const createdEntry = constraint.history.find((entry) => entry.action === 'Created')
  dates.Open = createdEntry?.at || constraint.reportedDate

  const sortedHistory = [...constraint.history].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  )

  for (const entry of sortedHistory) {
    if (entry.action !== 'Status update') continue
    const status = parseStatusFromHistoryDetail(entry.detail)
    if (status && !dates[status]) {
      dates[status] = entry.at
    }
  }

  if (!dates[constraint.status] && constraint.status !== 'Open') {
    dates[constraint.status] = constraint.updatedAt
  }

  return {
    openDate: dates.Open ? formatDate(dates.Open) : '—',
    underInvestigationDate: dates['Under investigation']
      ? formatDate(dates['Under investigation'])
      : '—',
    mitigatingDate: dates.Mitigating ? formatDate(dates.Mitigating) : '—',
    resolvedDate: dates.Resolved ? formatDate(dates.Resolved) : '—',
  }
}

export function buildConstraintRows(
  constraints: CapacityConstraint[],
  ctx: ReportContext,
): ReportRow[] {
  const impacts = ctx.impactResults || []

  return constraints.map((constraint) => {
    const constraintImpacts = impacts.filter((impact) => impact.constraintId === constraint.id)
    const customerIds = [...new Set(constraintImpacts.map((impact) => impact.customerId))]
    const affectedCustomers = customerIds
      .map((customerId) => resolveCustomerName(ctx, customerId))
      .filter((name) => name !== '—')
      .sort((a, b) => a.localeCompare(b))
      .join(', ')
    const statusDates = resolveConstraintStatusDates(constraint)
    const createdBy =
      ctx.users?.find((user) => user.id === constraint.createdBy)?.name || constraint.createdBy

    return {
      sku: constraint.sku,
      resourceType: constraint.resourceType,
      regions: constraint.regions.join(', '),
      scope: constraint.scope,
      severity: constraint.severity,
      status: constraint.status,
      source: constraint.source,
      created: formatDate(constraint.reportedDate),
      updated: formatDate(constraint.updatedAt),
      createdBy,
      affectedCustomers: affectedCustomers || '—',
      affectedCustomerCount: customerIds.length,
      matchingResources: constraintImpacts.reduce(
        (sum, impact) => sum + impact.matchingResourceCount,
        0,
      ),
      ...statusDates,
      rows: 1,
    }
  })
}

export function buildInventoryRows(
  items: InventoryItem[],
  ctx: ReportContext,
): ReportRow[] {
  return items.map((item) => ({
    name: item.name,
    customer: resolveCustomerName(ctx, item.customerId),
    subscription: resolveSubscriptionName(ctx, item.subscriptionId),
    resourceType: item.resourceType,
    sku: item.sku,
    region: item.region,
    resourceGroup: item.resourceGroup,
    source: item.source,
    retrieved: item.collectedAt ? formatDate(item.collectedAt) : '—',
    rows: 1,
  }))
}

export function buildQuotaRows(quotas: Quota[], ctx: ReportContext): ReportRow[] {
  return quotas.map((q) => {
    const usagePct = q.limit ? Math.round((q.usage / q.limit) * 100) : 0
    return {
      name: q.name,
      customer: resolveCustomerName(ctx, q.customerId),
      subscription: q.subscriptionName || resolveSubscriptionName(ctx, q.subscriptionId),
      provider: resolveQuotaProvider(q),
      region: q.region,
      usage: q.usage,
      limit: q.limit,
      usagePct,
      unit: q.unit,
      quotaGroup: q.quotaGroup || '—',
      source: q.source || 'Stored',
      retrieved: q.collectedAt ? formatDate(q.collectedAt) : '—',
      rows: 1,
    }
  })
}

export function buildQuotaGroupRows(
  rows: QuotaGroupLimit[],
  ctx: ReportContext,
): ReportRow[] {
  return rows.map((row) => {
    const subs = formatSubscriptions(ctx, row.subscriptionIds || [])
    const allocatedPct = row.limit ? Math.round((row.allocated / row.limit) * 100) : 0
    return {
      group: row.groupDisplayName || row.groupQuotaName,
      name: row.name,
      customer: resolveCustomerName(ctx, row.customerId),
      managementGroup: row.managementGroupId,
      region: row.region,
      allocated: row.allocated,
      limit: row.limit,
      availableLimit: row.availableLimit,
      allocatedPct,
      unit: row.unit,
      subscriptions: subs.label,
      subscriptionCount: subs.count,
      resourceProvider: row.resourceProvider,
      source: row.source || 'Stored',
      retrieved: row.collectedAt ? formatDate(row.collectedAt) : '—',
      rows: 1,
    }
  })
}

export function buildReportRows(
  datasource: ReportDatasource,
  data: {
    inventory: InventoryItem[]
    quotas: Quota[]
    quotaGroupLimits: QuotaGroupLimit[]
    constraints: CapacityConstraint[]
  },
  ctx: ReportContext,
): ReportRow[] {
  if (datasource === 'inventory') return buildInventoryRows(data.inventory, ctx)
  if (datasource === 'quotas') return buildQuotaRows(data.quotas, ctx)
  if (datasource === 'constraints') return buildConstraintRows(data.constraints, ctx)
  return buildQuotaGroupRows(data.quotaGroupLimits, ctx)
}

function groupKey(row: ReportRow, groupBy: string[]) {
  return groupBy.map((field) => String(row[field] ?? '—')).join('\u0001')
}

function aggregateValue(values: number[], fn: AggregationFn): number {
  if (!values.length) return 0
  if (fn === 'count') return values.length
  if (fn === 'sum') return values.reduce((a, b) => a + b, 0)
  if (fn === 'avg') return values.reduce((a, b) => a + b, 0) / values.length
  if (fn === 'min') return Math.min(...values)
  if (fn === 'max') return Math.max(...values)
  return 0
}

function formatAggregateValue(fn: AggregationFn, value: number, field?: string) {
  if (fn === 'count') return String(Math.round(value))
  if (field === 'usagePct' || field === 'allocatedPct') {
    return `${Math.round(value * 10) / 10}%`
  }
  if (Number.isInteger(value)) return String(value)
  return (Math.round(value * 100) / 100).toString()
}

export function aggregationColumnLabel(spec: AggregationSpec, schema: ReportFieldDef[]) {
  const fnLabel = FN_LABELS[spec.fn]
  if (spec.fn === 'count') return fnLabel
  const fieldLabel = schema.find((f) => f.id === spec.field)?.label || spec.field || 'Value'
  return `${fnLabel} (${fieldLabel})`
}

export function aggregateReportRows(
  rows: ReportRow[],
  groupBy: string[],
  aggregations: AggregationSpec[],
  schema: ReportFieldDef[],
): { columns: string[]; columnLabels: Record<string, string>; rows: ReportRow[] } {
  const groupColumns = groupBy
  const aggColumns = aggregations.map((_, index) => `agg_${index}`)
  const columnLabels: Record<string, string> = {}
  for (const field of groupColumns) {
    columnLabels[field] = schema.find((f) => f.id === field)?.label || field
  }
  for (let i = 0; i < aggregations.length; i += 1) {
    aggColumns[i] = `agg_${i}`
    columnLabels[aggColumns[i]] = aggregationColumnLabel(aggregations[i], schema)
  }

  const map = new Map<string, ReportRow[]>()
  for (const row of rows) {
    const key = groupKey(row, groupBy)
    const bucket = map.get(key) || []
    bucket.push(row)
    map.set(key, bucket)
  }

  const result: ReportRow[] = []
  for (const bucket of map.values()) {
    const sample = bucket[0]
    const out: ReportRow = {}
    for (const field of groupColumns) {
      out[field] = sample[field] ?? '—'
    }
    aggregations.forEach((spec, index) => {
      const col = `agg_${index}`
      if (spec.fn === 'count') {
        out[col] = formatAggregateValue('count', bucket.length)
        return
      }
      const values = bucket
        .map((row) => Number(row[spec.field || '']))
        .filter((n) => Number.isFinite(n))
      const raw = aggregateValue(values, spec.fn)
      out[col] = formatAggregateValue(spec.fn, raw, spec.field)
    })
    result.push(out)
  }

  result.sort((a, b) => {
    const av = String(a[groupColumns[0]] ?? '')
    const bv = String(b[groupColumns[0]] ?? '')
    return av.localeCompare(bv)
  })

  return {
    columns: [...groupColumns, ...aggColumns],
    columnLabels,
    rows: result,
  }
}

export function getFieldLabel(schema: ReportFieldDef[], fieldId: string) {
  return schema.find((f) => f.id === fieldId)?.label || fieldId
}

export function measureFields(schema: ReportFieldDef[]) {
  return schema.filter((f) => f.kind === 'measure' && f.id !== 'rows')
}

export function dimensionFields(schema: ReportFieldDef[]) {
  return schema.filter((f) => f.kind === 'dimension')
}
