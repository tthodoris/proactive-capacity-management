/** Predefined Azure quota / usages providers used when collecting and grouping quotas. */
export const QUOTA_PROVIDERS = [
  {
    id: 'compute',
    label: 'Compute',
    armProvider: 'Microsoft.Compute',
    apiVersion: '2024-07-01',
  },
  {
    id: 'storage',
    label: 'Storage',
    armProvider: 'Microsoft.Storage',
    apiVersion: '2024-01-01',
  },
  {
    id: 'network',
    label: 'Network',
    armProvider: 'Microsoft.Network',
    apiVersion: '2024-05-01',
  },
  {
    id: 'app-service',
    label: 'App Service',
    armProvider: 'Microsoft.Web',
    apiVersion: '2024-04-01',
  },
  {
    id: 'container-apps',
    label: 'Azure Container Apps',
    armProvider: 'Microsoft.App',
    apiVersion: '2024-03-01',
  },
  {
    id: 'aks',
    label: 'Azure Kubernetes Service',
    armProvider: 'Microsoft.ContainerService',
    apiVersion: '2024-09-01',
  },
  {
    id: 'postgresql',
    label: 'Azure PostgreSQL',
    armProvider: 'Microsoft.DBforPostgreSQL',
    apiVersion: '2023-12-01-preview',
  },
  {
    id: 'mysql',
    label: 'Azure Database for MySQL',
    armProvider: 'Microsoft.DBforMySQL',
    apiVersion: '2023-12-30',
  },
  {
    id: 'sql',
    label: 'Azure SQL',
    armProvider: 'Microsoft.Sql',
    apiVersion: '2023-08-01-preview',
  },
  {
    id: 'cosmos',
    label: 'Azure Cosmos DB',
    armProvider: 'Microsoft.DocumentDB',
    apiVersion: '2024-05-15',
  },
  {
    id: 'databricks',
    label: 'Azure Databricks',
    armProvider: 'Microsoft.Databricks',
    apiVersion: '2024-05-01',
  },
] as const

export type QuotaProviderLabel = (typeof QUOTA_PROVIDERS)[number]['label'] | 'Other'

const LEGACY_GROUP_MAP: Record<string, QuotaProviderLabel> = {
  compute: 'Compute',
  'compute-family': 'Compute',
  storage: 'Storage',
  network: 'Network',
  analytics: 'Azure Databricks',
  web: 'App Service',
  'app-service': 'App Service',
  'container-apps': 'Azure Container Apps',
  aks: 'Azure Kubernetes Service',
  postgresql: 'Azure PostgreSQL',
  mysql: 'Azure Database for MySQL',
  sql: 'Azure SQL',
  cosmos: 'Azure Cosmos DB',
  databricks: 'Azure Databricks',
}

/** Normalize stored quotaGroup / source into a display provider label. */
export function resolveQuotaProvider(input: {
  quotaGroup?: string | null
  source?: string | null
  name?: string | null
}): QuotaProviderLabel {
  const group = String(input.quotaGroup || '').trim()
  if (group) {
    const byLabel = QUOTA_PROVIDERS.find(
      (p) => p.label.toLowerCase() === group.toLowerCase() || p.id === group.toLowerCase(),
    )
    if (byLabel) return byLabel.label
    const legacy = LEGACY_GROUP_MAP[group.toLowerCase()]
    if (legacy) return legacy
    return group as QuotaProviderLabel
  }

  const source = String(input.source || '').toLowerCase()
  if (source.includes('compute')) return 'Compute'
  if (source.includes('storage')) return 'Storage'
  if (source.includes('network')) return 'Network'
  if (source.includes('container app')) return 'Azure Container Apps'
  if (source.includes('kubernetes') || source.includes('aks')) return 'Azure Kubernetes Service'
  if (source.includes('postgres')) return 'Azure PostgreSQL'
  if (source.includes('mysql')) return 'Azure Database for MySQL'
  if (source.includes('sql')) return 'Azure SQL'
  if (source.includes('cosmos')) return 'Azure Cosmos DB'
  if (source.includes('databricks')) return 'Azure Databricks'
  if (source.includes('app service') || source.includes('web')) return 'App Service'

  return 'Other'
}

export function providerSortIndex(label: string) {
  const idx = QUOTA_PROVIDERS.findIndex((p) => p.label === label)
  return idx === -1 ? QUOTA_PROVIDERS.length : idx
}

export function groupQuotasByProvider<T extends { quotaGroup?: string | null; source?: string | null; name?: string }>(
  rows: T[],
): Array<{ provider: QuotaProviderLabel; items: T[] }> {
  const map = new Map<QuotaProviderLabel, T[]>()
  for (const row of rows) {
    const provider = resolveQuotaProvider(row)
    const list = map.get(provider) || []
    list.push(row)
    map.set(provider, list)
  }
  return [...map.entries()]
    .map(([provider, items]) => ({ provider, items }))
    .sort((a, b) => providerSortIndex(a.provider) - providerSortIndex(b.provider))
}

export function groupQuotaGroupLimitsByEntity<
  T extends { groupQuotaName: string; groupDisplayName?: string | null },
>(rows: T[]): Array<{ key: string; label: string; items: T[] }> {
  const map = new Map<string, { label: string; items: T[] }>()
  for (const row of rows) {
    const key = row.groupQuotaName
    const label = row.groupDisplayName?.trim() || row.groupQuotaName
    const entry = map.get(key) || { label, items: [] }
    entry.items.push(row)
    map.set(key, entry)
  }
  return [...map.entries()]
    .map(([key, { label, items }]) => ({ key, label, items }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Prefer VM family-style quota names for the customer family filter. */
export function isQuotaFamilyName(name: string) {
  return /family/i.test(name)
}
