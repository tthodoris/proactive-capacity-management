/**
 * Normalize inventory SKU/size values to a capacity "family / series" label.
 * Exact sizes like Standard_D8s_v5 collapse to Dsv5.
 *
 * @param {string | null | undefined} sku
 * @param {string | null | undefined} size
 */
export function toSkuFamily(sku, size) {
  const sizeVal = String(size || '').trim()
  if (sizeVal) {
    const cleanedSize = sizeVal.replace(/\s+(family|series)\s*$/i, '').trim()
    // Prefer explicit family/series stored in size (e.g. Dsv5, GP_Gen5).
    if (cleanedSize && !/^Standard_/i.test(cleanedSize) && !/^\w+\d+[a-z]*_v?\d+$/i.test(cleanedSize)) {
      return cleanedSize
    }
    if (cleanedSize && !/^Standard_/i.test(cleanedSize) && !/_\d+$/.test(cleanedSize)) {
      return cleanedSize
    }
  }

  const raw = String(sku || '').trim()
  if (!raw) return ''

  const cleaned = raw.replace(/\s+(family|series)\s*$/i, '').trim()

  // Standard_E8-4s_v5 (constrained vCPU) → Esv5
  const constrained = cleaned.match(/^Standard_([A-Za-z]+)\d+-\d+([a-z]*)_?(v\d+)?$/i)
  if (constrained) {
    return `${constrained[1]}${constrained[2] || ''}${constrained[3] || ''}`
  }

  // Standard_NC4as_T4_v3 → NCasT4_v3
  const gpu = cleaned.match(/^Standard_([A-Za-z]+)(\d+)([a-z]*)_([A-Za-z]+\d+)_?(v\d+)?$/i)
  if (gpu) {
    return `${gpu[1]}${gpu[3] || ''}${gpu[4]}${gpu[5] ? `_${gpu[5]}` : ''}`
  }

  // Standard_D8s_v5 / Standard_E16ads_v5 → Dsv5 / Eadsv5
  const vm = cleaned.match(/^Standard_([A-Za-z]+?)(\d+)([a-z]*)_?(v\d+)?$/i)
  if (vm) {
    const series = vm[1]
    const suffix = vm[3] || ''
    const version = vm[4] || ''
    return `${series}${suffix}${version}`
  }

  // GP_Gen5_8 / MO_Gen5_4 / BC_Gen5_2 → GP_Gen5 / MO_Gen5
  const genSized = cleaned.match(/^([A-Za-z]+)_Gen(\d+)(?:_\d+)?$/i)
  if (genSized) {
    return `${genSized[1]}_Gen${genSized[2]}`
  }

  // BurstableB1ms → BurstableB, PremiumP1 → PremiumP (best-effort)
  const burstable = cleaned.match(/^(Burstable|Premium|GeneralPurpose|MemoryOptimized)([A-Za-z]*)\d+/i)
  if (burstable) {
    return `${burstable[1]}${burstable[2] || ''}`
  }

  // Strip trailing capacity number: Something_16 → Something
  const stripped = cleaned.replace(/_\d+$/, '')
  if (stripped && stripped !== cleaned) return stripped

  return cleaned
}

/** Canonical resource types always offered on the constraint form. */
export const CANONICAL_RESOURCE_TYPES = [
  'Virtual Machine',
  'Azure SQL Database',
  'Azure SQL Managed Instance',
  'Azure Database for MySQL',
  'Azure Database for PostgreSQL',
  'Azure Cosmos DB',
  'Azure Kubernetes Service',
  'Container Instances',
  'Azure Container Apps',
  'Azure Databricks',
  'Azure Data Explorer',
  'Azure Cache for Redis',
  'Azure Managed Redis',
  'Key Vault',
  'Storage Account',
  'Application Gateway',
  'API Management',
  'VPN Gateway',
]

/** Suggested families shown when inventory has no rows for a type yet. */
export const SUGGESTED_SKU_FAMILIES = {
  'Virtual Machine': ['Dsv5', 'Dasv5', 'Esv5', 'Fsv2', 'Bsv2', 'NCasT4_v3'],
  'Azure SQL Database': ['GP_Gen5', 'BC_Gen5', 'HS_Gen5', 'GP_S_Gen5'],
  'Azure SQL Managed Instance': ['GP_Gen5', 'BC_Gen5'],
  'Azure Database for MySQL': ['BurstableB', 'GeneralPurpose', 'MemoryOptimized'],
  'Azure Database for PostgreSQL': ['BurstableB', 'GeneralPurpose', 'MemoryOptimized'],
  'Azure Cosmos DB': ['Standard', 'Autoscale'],
  'Azure Kubernetes Service': ['Standard', 'Premium'],
  'Container Instances': ['Standard'],
  'Azure Container Apps': ['Consumption', 'Dedicated', 'WorkloadProfiles'],
  'Azure Databricks': ['Standard_DS3_v2', 'Dsv5', 'Esv5'],
  'Azure Data Explorer': ['Standard_D14_v2', 'Eadsv5', 'Lsv3'],
  'Azure Cache for Redis': ['Basic', 'Standard', 'Premium', 'Enterprise'],
  'Azure Managed Redis': ['Balanced', 'MemoryOptimized', 'ComputeOptimized'],
  'Key Vault': ['Standard', 'Premium'],
  'Storage Account': ['Standard_LRS', 'Standard_GRS', 'Standard_ZRS', 'Premium_LRS'],
  'Application Gateway': ['Standard_v2', 'WAF_v2'],
  'API Management': ['Developer', 'Basic', 'Standard', 'Premium', 'Consumption'],
  'VPN Gateway': ['VpnGw1', 'VpnGw2', 'VpnGw3', 'VpnGw1AZ', 'VpnGw2AZ'],
}
