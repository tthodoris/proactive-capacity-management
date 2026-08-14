import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearConnection,
  getBootstrap,
  initDb,
  listInventoryResourceTypes,
  listInventorySkus,
  replaceInventory,
  replaceQuotaGroupLimits,
  replaceQuotas,
  runInventoryImpactAnalysis,
  saveConnection,
  seedIfEmpty,
  upsertCustomer,
  upsertSubscription,
  listSavedReportsForUser,
  createSavedReport,
  deleteSavedReport,
  listRegionEvaluations,
  getRegionEvaluation,
  createRegionEvaluation,
  deleteRegionEvaluation,
} from './db.mjs'
import { toSkuFamily } from './skuFamily.mjs'
import { enrichResultsWithRetailPrices } from './retailPrices.mjs'
import {
  insertRewardEvent,
  markAlertReadDb,
  persistConstraintBundle,
  replaceImpactsForConstraint,
  seedDomainIfEmpty,
  upsertConstraint,
  upsertEngagement,
} from './domain-db.mjs'

const app = express()
const PORT = Number(process.env.PCM_API_PORT || 8787)

function sendRouteError(res, status, err, hint) {
  const message = err instanceof Error ? err.message : String(err)
  const code =
    err && typeof err === 'object' && 'code' in err && err.code != null
      ? String(err.code)
      : undefined
  let resolvedHint = hint
  if (code === '23505') {
    resolvedHint =
      hint ||
      'Database rejected the save due to a duplicate key. Inventory resource IDs must be unique.'
  } else if (code === '23503') {
    resolvedHint =
      hint ||
      'Database rejected the save because a related customer or subscription record is missing.'
  } else if (code === '57014') {
    resolvedHint = hint || 'Database statement timed out while saving. Retry the collection.'
  }
  res.status(status).json({
    error: message,
    ...(resolvedHint ? { hint: resolvedHint } : {}),
    ...(code ? { code } : {}),
  })
}

app.use(cors())
app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: true, limit: '25mb' }))

/** @type {{
 *  status: 'idle' | 'awaiting_device_code' | 'authenticating' | 'connected' | 'error' | 'cancelled'
 *  tenantId: string | null
 *  deviceCode: string | null
 *  verificationUrl: string | null
 *  message: string | null
 *  error: string | null
 *  account: object | null
 *  startedAt: string | null
 *  connectedAt: string | null
 *  loginPid: number | null
 * }} */
const connection = {
  status: 'idle',
  tenantId: null,
  deviceCode: null,
  verificationUrl: 'https://microsoft.com/devicelogin',
  message: null,
  error: null,
  account: null,
  startedAt: null,
  connectedAt: null,
  loginPid: null,
}

/** @type {import('node:child_process').ChildProcess | null} */
let loginProcess = null

const DEFAULT_REGIONS = ['westeurope', 'northeurope', 'francecentral', 'swedencentral', 'uksouth']

/** Azure usages APIs grouped under predefined quota providers. */
const QUOTA_PROVIDERS = [
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
]

function isCapacityRelevantUsage(name, current) {
  const lower = String(name || '').toLowerCase()
  return (
    lower.includes('family') ||
    lower.includes('cores') ||
    lower.includes('vcpus') ||
    lower.includes('standard d') ||
    lower.includes('standard e') ||
    lower.includes('standard f') ||
    lower.includes('availability') ||
    lower.includes('virtual machines') ||
    lower.includes('storage') ||
    lower.includes('account') ||
    lower.includes('server') ||
    lower.includes('cluster') ||
    lower.includes('environment') ||
    lower.includes('workload') ||
    Number(current) > 0
  )
}

/**
 * Collect usages for one subscription across predefined Azure quota providers.
 * @param {{
 *   subscriptionId: string
 *   subscriptionName: string
 *   tenantId?: string
 *   locations: string[]
 * }} input
 */
async function collectProviderQuotas(input) {
  const { subscriptionId, subscriptionName, tenantId, locations } = input
  const quotaRows = []
  const errors = []

  for (const location of locations) {
    // Prefer az vm list-usage for Compute (stable + includes family quotas).
    try {
      const { stdout } = await runAz(
        [
          'vm',
          'list-usage',
          '--location',
          location,
          '--subscription',
          subscriptionId,
          '-o',
          'json',
        ],
        { timeoutMs: 60_000 },
      )
      const usages = JSON.parse(stdout)
      for (const usage of usages) {
        const limit = Number(usage.limit ?? 0)
        const current = Number(usage.currentValue ?? 0)
        if (!limit && !current) continue
        const name = usage.name?.localizedValue || usage.name?.value || 'Unknown'
        if (!isCapacityRelevantUsage(name, current)) continue
        quotaRows.push({
          id: randomUUID(),
          name,
          nameValue: usage.name?.value ?? null,
          subscriptionId,
          subscriptionName,
          tenantId,
          region: location,
          usage: current,
          limit,
          unit: usage.unit || 'Count',
          source: 'Azure Compute Usage API',
          quotaGroup: 'Compute',
        })
      }
    } catch (err) {
      errors.push({
        provider: 'Compute',
        location,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    for (const provider of QUOTA_PROVIDERS) {
      // Compute already covered by az vm list-usage above.
      if (provider.id === 'compute') continue
      try {
        const { stdout } = await runAz(
          [
            'rest',
            '--method',
            'get',
            '--url',
            `https://management.azure.com/subscriptions/${subscriptionId}/providers/${provider.armProvider}/locations/${location}/usages?api-version=${provider.apiVersion}`,
            '-o',
            'json',
          ],
          { timeoutMs: 60_000 },
        )
        const payload = JSON.parse(stdout)
        const values = Array.isArray(payload?.value)
          ? payload.value
          : Array.isArray(payload)
            ? payload
            : []
        for (const usage of values) {
          const limit = Number(usage.limit ?? usage.currentValueLimit ?? 0)
          const current = Number(usage.currentValue ?? usage.usage ?? 0)
          if (!limit && !current) continue
          const name =
            usage.name?.localizedValue ||
            usage.name?.value ||
            usage.localizedValue ||
            usage.value ||
            'Unknown'
          if (!isCapacityRelevantUsage(name, current)) continue
          quotaRows.push({
            id: randomUUID(),
            name,
            nameValue: usage.name?.value ?? usage.value ?? null,
            subscriptionId,
            subscriptionName,
            tenantId,
            region: location,
            usage: current,
            limit,
            unit: usage.unit || 'Count',
            source: `${provider.label} usages API`,
            quotaGroup: provider.label,
          })
        }
      } catch (err) {
        errors.push({
          provider: provider.label,
          location,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  const seen = new Set()
  const deduped = []
  for (const row of quotaRows) {
    const key = `${row.subscriptionId}|${row.region}|${row.quotaGroup}|${row.nameValue || row.name}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }
  deduped.sort((a, b) => b.usage / Math.max(b.limit, 1) - a.usage / Math.max(a.limit, 1))
  return { quotas: deduped, errors }
}

const GROUP_QUOTA_API_VERSION = '2025-09-01'

function sumAllocatedToSubscriptions(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => {
      if (typeof item === 'number') return sum + item
      if (item && typeof item === 'object') {
        return (
          sum +
          Number(
            item.allocated ??
              item.shareableQuota ??
              item.limit ??
              item.value ??
              0,
          )
        )
      }
      return sum
    }, 0)
  }
  if (typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + sumAllocatedToSubscriptions(item), 0)
  }
  return 0
}

function readAzProperty(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  if (obj[key] !== undefined) return obj[key]
  const alt = key.charAt(0).toUpperCase() + key.slice(1)
  return obj[alt]
}

async function listAccessibleManagementGroups(requestedId, tenantId) {
  if (requestedId) return [requestedId]
  const discovered = new Set()
  if (tenantId) discovered.add(tenantId)
  try {
    const { stdout } = await runAz(['account', 'management-group', 'list', '-o', 'json'], {
      timeoutMs: 60_000,
    })
    const groups = JSON.parse(stdout)
    if (Array.isArray(groups)) {
      for (const mg of groups) {
        const id = mg.name || mg.id?.split('/').pop()
        if (id) discovered.add(id)
      }
    }
  } catch (err) {
    // fall back to tenant root only
  }
  return [...discovered]
}

async function azRestGetJson(url) {
  const { stdout } = await runAz(['rest', '--method', 'get', '--url', url, '-o', 'json'], {
    timeoutMs: 60_000,
  })
  return JSON.parse(stdout)
}

async function listGroupQuotasForManagementGroup(managementGroupId) {
  const url = `https://management.azure.com/providers/Microsoft.Management/managementGroups/${managementGroupId}/providers/Microsoft.Quota/groupQuotas?api-version=${GROUP_QUOTA_API_VERSION}`
  const payload = await azRestGetJson(url)
  const rows = []
  if (Array.isArray(payload?.value)) rows.push(...payload.value)
  if (Array.isArray(payload?.values)) rows.push(...payload.values)
  const seen = new Set()
  return rows.filter((row) => {
    const key = row?.name || row?.id
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function listGroupQuotaSubscriptions(managementGroupId, groupQuotaName) {
  const url = `https://management.azure.com/providers/Microsoft.Management/managementGroups/${managementGroupId}/providers/Microsoft.Quota/groupQuotas/${groupQuotaName}/subscriptions?api-version=${GROUP_QUOTA_API_VERSION}`
  const payload = await azRestGetJson(url)
  const values = []
  if (Array.isArray(payload?.value)) values.push(...payload.value)
  if (Array.isArray(payload?.values)) values.push(...payload.values)
  return [...new Set(
    values
      .map(
        (item) =>
          readAzProperty(item, 'properties')?.subscriptionId ||
          readAzProperty(item, 'Properties')?.subscriptionId ||
          item?.subscriptionId ||
          item?.name,
      )
      .filter(Boolean),
  )]
}

async function listGroupQuotaLimitsForLocation(managementGroupId, groupQuotaName, location) {
  const url = `https://management.azure.com/providers/Microsoft.Management/managementGroups/${managementGroupId}/providers/Microsoft.Quota/groupQuotas/${groupQuotaName}/resourceProviders/Microsoft.Compute/groupQuotaLimits/${location}?api-version=${GROUP_QUOTA_API_VERSION}`
  const payload = await azRestGetJson(url)
  if (Array.isArray(payload?.value)) return payload.value
  if (Array.isArray(payload?.values)) return payload.values
  return []
}

/**
 * Collect Azure Quota Group entities and their group-level limits across management groups.
 */
async function collectAzureQuotaGroups({ tenantId, locations, managementGroupId }) {
  const quotaGroupRows = []
  const errors = []
  const discoveredGroups = []
  const managementGroups = await listAccessibleManagementGroups(managementGroupId, tenantId)

  if (!managementGroups.length) {
    return {
      quotaGroupLimits: [],
      discoveredGroups: [],
      errors: [
        {
          scope: 'management-groups',
          error: managementGroupId
            ? `Management group ${managementGroupId} is not accessible`
            : 'No accessible management groups found for the signed-in account',
        },
      ],
    }
  }

  for (const mgId of managementGroups) {
    let groupEntities = []
    try {
      groupEntities = await listGroupQuotasForManagementGroup(mgId)
    } catch (err) {
      errors.push({
        managementGroupId: mgId,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    for (const entity of groupEntities) {
      const groupQuotaName = entity.name
      const groupDisplayName =
        readAzProperty(entity, 'properties')?.displayName ||
        readAzProperty(entity, 'Properties')?.displayName ||
        groupQuotaName
      discoveredGroups.push({
        managementGroupId: mgId,
        groupQuotaName,
        groupDisplayName,
      })

      let subscriptionIds = []
      try {
        subscriptionIds = await listGroupQuotaSubscriptions(mgId, groupQuotaName)
      } catch (err) {
        errors.push({
          managementGroupId: mgId,
          groupQuotaName,
          error: `Subscriptions: ${err instanceof Error ? err.message : String(err)}`,
        })
      }

      let groupLimitRowsAdded = 0
      for (const location of locations) {
        try {
          const limits = await listGroupQuotaLimitsForLocation(mgId, groupQuotaName, location)
          for (const limit of limits) {
            const limitValue = Number(limit.limit ?? 0)
            const availableLimit = Number(limit.availableLimit ?? 0)
            const allocated = sumAllocatedToSubscriptions(limit.allocatedToSubscriptions)
            if (!limitValue && !availableLimit && !allocated) continue
            const name =
              limit.name?.localizedValue ||
              limit.name?.value ||
              limit.resourceName ||
              'Unknown'
            quotaGroupRows.push({
              id: randomUUID(),
              tenantId,
              managementGroupId: mgId,
              groupQuotaName,
              groupDisplayName,
              subscriptionIds,
              region: location,
              name,
              nameValue: limit.name?.value || limit.resourceName || null,
              limit: limitValue,
              availableLimit,
              allocated,
              unit: limit.unit || 'Count',
              resourceProvider: 'Microsoft.Compute',
              source: 'Azure Quota Groups API',
            })
            groupLimitRowsAdded += 1
          }
        } catch (err) {
          errors.push({
            managementGroupId: mgId,
            groupQuotaName,
            location,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (groupLimitRowsAdded === 0) {
        quotaGroupRows.push({
          id: randomUUID(),
          tenantId,
          managementGroupId: mgId,
          groupQuotaName,
          groupDisplayName,
          subscriptionIds,
          region: locations[0] || '—',
          name: 'Group membership (no compute limits in selected regions)',
          nameValue: '__membership__',
          limit: 0,
          availableLimit: 0,
          allocated: 0,
          unit: '—',
          resourceProvider: 'Microsoft.Compute',
          source: 'Azure Quota Groups API',
        })
      }
    }
  }

  const seen = new Set()
  const deduped = []
  for (const row of quotaGroupRows) {
    const key = `${row.managementGroupId}|${row.groupQuotaName}|${row.region}|${row.nameValue || row.name}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }

  deduped.sort(
    (a, b) => b.allocated / Math.max(b.limit, 1) - a.allocated / Math.max(a.limit, 1),
  )
  return { quotaGroupLimits: deduped, discoveredGroups, errors }
}

function quoteWinArg(arg) {
  const value = String(arg).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/[\s"&<>|^!]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function runAz(args, { timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const finalArgs = isWin ? args.map(quoteWinArg) : args
    const child = spawn('az', finalArgs, {
      shell: isWin,
      env: { ...process.env, ...env },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`az ${args[0] || ''} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `az exited with code ${code}`))
      }
    })
  })
}

function flattenKql(query) {
  return String(query).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

async function resourceGraphQuery(query, subscriptionIds = [], top = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'pcm-arg-'))
  const bodyPath = join(dir, 'query.json')
  const body = {
    query: flattenKql(query),
    subscriptions: subscriptionIds,
    options: {
      resultFormat: 'objectArray',
      top,
    },
  }
  writeFileSync(bodyPath, JSON.stringify(body), 'utf8')

  try {
    // @file avoids Windows shell mangling of multi-line KQL
    const { stdout } = await runAz(
      [
        'rest',
        '--method',
        'post',
        '--url',
        'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
        '--body',
        `@${bodyPath}`,
        '-o',
        'json',
      ],
      { timeoutMs: 120_000 },
    )
    const payload = JSON.parse(stdout)
    return payload.data ?? payload
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}

async function listLocationDisplayNames() {
  try {
    const { stdout } = await runAz(['account', 'list-locations', '-o', 'json'], {
      timeoutMs: 60_000,
    })
    const locations = JSON.parse(stdout)
    const map = new Map()
    if (Array.isArray(locations)) {
      for (const loc of locations) {
        const name = String(loc.name || '').toLowerCase()
        if (!name) continue
        map.set(name, loc.displayName || loc.name)
      }
    }
    return map
  } catch {
    return new Map()
  }
}

/**
 * Full Azure location catalog for the current subscription (physical regions preferred).
 * Uses ARM /locations and falls back to `az account list-locations`.
 */
async function listAzureLocations(subscriptionId) {
  const byId = new Map()

  function addLocation(raw) {
    const id = String(raw.name || raw.id || '')
      .split('/')
      .pop()
      ?.toLowerCase()
      .trim()
    if (!id) return
    const regionType = String(raw.metadata?.regionType || '').toLowerCase()
    // Keep physical/regional locations; skip pure geography aggregates when typed.
    if (regionType === 'logical') return
    const label =
      raw.displayName ||
      raw.regionalDisplayName ||
      id
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: String(label),
        regionType: raw.metadata?.regionType || null,
      })
    }
  }

  if (subscriptionId) {
    try {
      const { stdout } = await runAz(
        [
          'rest',
          '--method',
          'get',
          '--url',
          `https://management.azure.com/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`,
          '-o',
          'json',
        ],
        { timeoutMs: 90_000 },
      )
      const payload = JSON.parse(stdout)
      const rows = Array.isArray(payload.value)
        ? payload.value
        : Array.isArray(payload)
          ? payload
          : []
      for (const row of rows) addLocation(row)
    } catch {
      // fall through to account list-locations
    }
  }

  if (byId.size === 0) {
    try {
      const { stdout } = await runAz(['account', 'list-locations', '-o', 'json'], {
        timeoutMs: 60_000,
      })
      const locations = JSON.parse(stdout)
      if (Array.isArray(locations)) {
        for (const loc of locations) addLocation(loc)
      }
    } catch {
      // empty catalog — frontend static list still available
    }
  }

  return [...byId.values()]
    .filter((loc) => {
      const id = loc.id
      if (!id || id === 'global') return false
      // Prefer physical regions when metadata is present.
      if (loc.regionType && String(loc.regionType).toLowerCase() !== 'physical') {
        return false
      }
      return true
    })
    .map(({ id, label }) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Discover Azure regions that currently have deployed resources.
 * @param {string[]} subscriptionIds
 */
async function discoverDeployedRegions(subscriptionIds) {
  if (!subscriptionIds.length) return []

  const query = `
    Resources
    | where isnotempty(location)
    | extend location = tolower(tostring(location))
    | where location !in ('', 'global', 'n/a', 'unknown')
    | summarize resourceCount = count() by location
    | order by resourceCount desc
  `
  const rows = await resourceGraphQuery(query, subscriptionIds, 1000)
  const displayNames = await listLocationDisplayNames()
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const id = String(row.location || '').toLowerCase().trim()
      if (!id) return null
      return {
        id,
        label: displayNames.get(id) || id,
        resourceCount: Number(row.resourceCount || 0),
      }
    })
    .filter(Boolean)

  list.sort(
    (a, b) =>
      b.resourceCount - a.resourceCount || a.label.localeCompare(b.label),
  )
  return list
}

async function getAccount() {
  const { stdout } = await runAz(['account', 'show', '-o', 'json'], { timeoutMs: 30_000 })
  return JSON.parse(stdout)
}

function parseDeviceCode(text) {
  const codeMatch =
    text.match(/enter the code\s+([A-Z0-9]{8,})\s+to authenticate/i) ||
    text.match(/code\s+([A-Z0-9]{8,})/i)
  const urlMatch = text.match(/https:\/\/microsoft\.com\/devicelogin/i)
  return {
    deviceCode: codeMatch?.[1] ?? null,
    verificationUrl: urlMatch ? 'https://microsoft.com/devicelogin' : connection.verificationUrl,
  }
}

function publicConnection() {
  return {
    status: connection.status,
    tenantId: connection.tenantId,
    deviceCode: connection.deviceCode,
    verificationUrl: connection.verificationUrl,
    message: connection.message,
    error: connection.error,
    account: connection.account,
    startedAt: connection.startedAt,
    connectedAt: connection.connectedAt,
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pcm-azure-bridge' })
})

app.get('/api/azure/status', async (_req, res) => {
  try {
    if (connection.status === 'connected' || connection.status === 'idle') {
      try {
        const account = await getAccount()
        connection.account = account
        connection.tenantId = account.tenantId || connection.tenantId
        connection.status = 'connected'
        connection.connectedAt = connection.connectedAt || new Date().toISOString()
        connection.error = null
      } catch {
        if (connection.status === 'connected') {
          connection.status = 'idle'
          connection.account = null
          connection.connectedAt = null
        }
      }
    }
    res.json(publicConnection())
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/azure/connect', async (req, res) => {
  const tenantId = String(req.body?.tenantId || '').trim()
  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' })
  }
  if (loginProcess && !loginProcess.killed) {
    return res.status(409).json({
      error: 'A login is already in progress',
      connection: publicConnection(),
    })
  }

  connection.status = 'awaiting_device_code'
  connection.tenantId = tenantId
  connection.deviceCode = null
  connection.message = `Starting az login --tenant ${tenantId} --use-device-code`
  connection.error = null
  connection.account = null
  connection.startedAt = new Date().toISOString()
  connection.connectedAt = null

  loginProcess = spawn(
    'az',
    ['login', '--tenant', tenantId, '--use-device-code', '--allow-no-subscriptions', '-o', 'json'],
    {
      shell: true,
      windowsHide: true,
      env: process.env,
    },
  )
  connection.loginPid = loginProcess.pid ?? null

  let combined = ''

  loginProcess.stdout?.on('data', (chunk) => {
    const text = chunk.toString()
    combined += text
    const parsed = parseDeviceCode(combined)
    if (parsed.deviceCode) {
      connection.deviceCode = parsed.deviceCode
      connection.verificationUrl = parsed.verificationUrl
      connection.status = 'authenticating'
      connection.message =
        'Open the verification URL, enter the device code, then return here while Azure CLI finishes.'
    }

    // Successful login prints JSON account array/object on stdout
    const trimmed = combined.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsedJson = JSON.parse(trimmed)
        const account = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson
        if (account?.tenantId || account?.id) {
          connection.account = account
          connection.status = 'connected'
          connection.connectedAt = new Date().toISOString()
          connection.message = 'Tenant connection established.'
          connection.deviceCode = null
        }
      } catch {
        // still streaming JSON
      }
    }
  })

  loginProcess.stderr?.on('data', (chunk) => {
    const text = chunk.toString()
    combined += text
    const parsed = parseDeviceCode(combined)
    if (parsed.deviceCode) {
      connection.deviceCode = parsed.deviceCode
      connection.verificationUrl = parsed.verificationUrl
      connection.status = 'authenticating'
      connection.message =
        'Open the verification URL, enter the device code, then return here while Azure CLI finishes.'
    }
  })

  loginProcess.on('error', (err) => {
    connection.status = 'error'
    connection.error = err.message
    connection.message = 'Failed to start Azure CLI login.'
    loginProcess = null
    connection.loginPid = null
  })

  loginProcess.on('close', async (code) => {
    loginProcess = null
    connection.loginPid = null
    if (code === 0) {
      try {
        const account = await getAccount()
        connection.account = account
        connection.tenantId = account.tenantId || tenantId
        connection.status = 'connected'
        connection.connectedAt = new Date().toISOString()
        connection.message = 'Tenant connection established.'
        connection.deviceCode = null
        connection.error = null
      } catch (err) {
        connection.status = 'error'
        connection.error = err instanceof Error ? err.message : String(err)
        connection.message = 'Login process exited but no active account was found.'
      }
    } else if (connection.status !== 'connected') {
      connection.status = 'error'
      connection.error = combined.trim() || `az login exited with code ${code}`
      connection.message = 'Tenant login did not complete.'
    }
  })

  res.status(202).json(publicConnection())
})

app.post('/api/azure/cancel', (_req, res) => {
  if (loginProcess && !loginProcess.killed) {
    loginProcess.kill()
    loginProcess = null
  }
  connection.status = 'cancelled'
  connection.message = 'Login cancelled.'
  connection.deviceCode = null
  connection.loginPid = null
  res.json(publicConnection())
})

app.post('/api/azure/disconnect', async (_req, res) => {
  try {
    if (loginProcess && !loginProcess.killed) {
      loginProcess.kill()
      loginProcess = null
    }
    if (connection.tenantId) {
      try {
        await runAz(['logout', '--tenant', connection.tenantId], { timeoutMs: 30_000 })
      } catch {
        await runAz(['logout'], { timeoutMs: 30_000 })
      }
    } else {
      await runAz(['logout'], { timeoutMs: 30_000 })
    }
  } catch {
    // ignore logout failures — local session may already be clear
  }

  connection.status = 'idle'
  connection.tenantId = null
  connection.deviceCode = null
  connection.message = 'Disconnected.'
  connection.error = null
  connection.account = null
  connection.startedAt = null
  connection.connectedAt = null
  connection.loginPid = null
  res.json(publicConnection())
})

app.get('/api/azure/tenant-info', async (_req, res) => {
  try {
    const account = await getAccount()
    let organization = null
    let graphError = null
    try {
      const { stdout } = await runAz(
        [
          'rest',
          '--method',
          'get',
          '--url',
          'https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains',
          '-o',
          'json',
        ],
        { timeoutMs: 60_000 },
      )
      const payload = JSON.parse(stdout)
      organization = payload.value?.[0] ?? payload
    } catch (err) {
      graphError = err instanceof Error ? err.message : String(err)
    }

    res.json({
      account,
      organization,
      graphError,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Connect a tenant first with az login --tenant.',
    })
  }
})

app.get('/api/azure/subscriptions', async (_req, res) => {
  try {
    const account = await getAccount()
    const { stdout } = await runAz(['account', 'list', '-o', 'json'], { timeoutMs: 60_000 })
    const all = JSON.parse(stdout)
    const subscriptions = all
      .filter((s) => s.state === 'Enabled')
      .filter((s) => !account.tenantId || s.tenantId === account.tenantId)
      .map((s) => ({
        id: s.id,
        name: s.name,
        tenantId: s.tenantId,
        state: s.state,
        isDefault: Boolean(s.isDefault),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    res.json({
      account,
      subscriptions,
      selectedSubscriptionId: account.id,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Connect a tenant first with az login --tenant.',
    })
  }
})

app.get('/api/azure/regions', async (req, res) => {
  try {
    const account = await getAccount()
    const requested = String(req.query.subscriptionIds || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)

    let subscriptionIds = requested
    if (!subscriptionIds.length) {
      const { stdout } = await runAz(['account', 'list', '-o', 'json'], { timeoutMs: 60_000 })
      const all = JSON.parse(stdout)
      subscriptionIds = all
        .filter((s) => s.state === 'Enabled')
        .filter((s) => !account.tenantId || s.tenantId === account.tenantId)
        .map((s) => s.id)
        .filter(Boolean)
    }

    if (!subscriptionIds.length) {
      return res.json({
        fetchedAt: new Date().toISOString(),
        account,
        subscriptionIds: [],
        regions: [],
        hint: 'No enabled subscriptions found for this tenant.',
      })
    }

    const regions = await discoverDeployedRegions(subscriptionIds)
    res.json({
      fetchedAt: new Date().toISOString(),
      account,
      subscriptionIds,
      regions,
      hint:
        regions.length === 0
          ? 'No deployed resources with a region were found in the selected subscriptions.'
          : undefined,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Region discovery uses Azure Resource Graph. Confirm the signed-in account can query the selected subscriptions.',
    })
  }
})

app.post('/api/azure/subscription', async (req, res) => {
  const subscriptionId = String(req.body?.subscriptionId || '').trim()
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId is required' })
  }
  try {
    await runAz(['account', 'set', '--subscription', subscriptionId], { timeoutMs: 45_000 })
    const account = await getAccount()
    connection.account = account
    connection.tenantId = account.tenantId || connection.tenantId
    connection.status = 'connected'
    res.json({
      ok: true,
      account,
      selectedSubscriptionId: account.id,
    })
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

/** Resource types that use Microsoft.Compute SKU catalogs for size availability. */
const COMPUTE_SKU_RESOURCE_TYPES = new Set([
  'Virtual Machine',
  'Azure Data Explorer',
  'Azure Databricks',
])

const RESOURCE_TYPE_PROVIDERS = {
  'Virtual Machine': {
    namespace: 'Microsoft.Compute',
    typeName: 'virtualMachines',
  },
  'Azure SQL Database': {
    namespace: 'Microsoft.Sql',
    typeName: 'servers/databases',
  },
  'Azure SQL Managed Instance': {
    namespace: 'Microsoft.Sql',
    typeName: 'managedInstances',
  },
  'Azure SQL Server': {
    namespace: 'Microsoft.Sql',
    typeName: 'servers',
  },
  'Azure Database for MySQL': {
    namespace: 'Microsoft.DBforMySQL',
    typeName: 'flexibleServers',
  },
  'Azure Database for PostgreSQL': {
    namespace: 'Microsoft.DBforPostgreSQL',
    typeName: 'flexibleServers',
  },
  'Azure Cosmos DB': {
    namespace: 'Microsoft.DocumentDB',
    typeName: 'databaseAccounts',
  },
  'Azure Kubernetes Service': {
    namespace: 'Microsoft.ContainerService',
    typeName: 'managedClusters',
  },
  'Container Instances': {
    namespace: 'Microsoft.ContainerInstance',
    typeName: 'containerGroups',
  },
  'Azure Container Apps': {
    namespace: 'Microsoft.App',
    typeName: 'containerApps',
  },
  'Azure Container Apps Environment': {
    namespace: 'Microsoft.App',
    typeName: 'managedEnvironments',
  },
  'Azure Databricks': {
    namespace: 'Microsoft.Databricks',
    typeName: 'workspaces',
  },
  'Azure Data Explorer': {
    namespace: 'Microsoft.Kusto',
    typeName: 'clusters',
  },
  'Azure Cache for Redis': {
    namespace: 'Microsoft.Cache',
    typeName: 'Redis',
  },
  'Azure Managed Redis': {
    namespace: 'Microsoft.Cache',
    typeName: 'redisEnterprise',
  },
  'Key Vault': {
    namespace: 'Microsoft.KeyVault',
    typeName: 'vaults',
  },
  'Storage Account': {
    namespace: 'Microsoft.Storage',
    typeName: 'storageAccounts',
  },
  'Application Gateway': {
    namespace: 'Microsoft.Network',
    typeName: 'applicationGateways',
  },
  'API Management': {
    namespace: 'Microsoft.ApiManagement',
    typeName: 'service',
  },
  'VPN Gateway': {
    namespace: 'Microsoft.Network',
    typeName: 'virtualNetworkGateways',
  },
  // Legacy labels kept for previously collected inventory rows.
  'Azure SQL': {
    namespace: 'Microsoft.Sql',
    typeName: 'servers/databases',
  },
  MySQL: {
    namespace: 'Microsoft.DBforMySQL',
    typeName: 'flexibleServers',
  },
  PostgreSQL: {
    namespace: 'Microsoft.DBforPostgreSQL',
    typeName: 'flexibleServers',
  },
  Container: {
    namespace: 'Microsoft.ContainerService',
    typeName: 'managedClusters',
  },
  'PaaS Database': {
    namespace: 'Microsoft.DocumentDB',
    typeName: 'databaseAccounts',
  },
}

function normalizeLocationKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function locationAliases(displayNames) {
  const aliases = new Map()
  for (const [id, label] of displayNames.entries()) {
    aliases.set(normalizeLocationKey(id), id)
    aliases.set(normalizeLocationKey(label), id)
  }
  return aliases
}

async function fetchComputeSkus(subscriptionId) {
  const { stdout } = await runAz(
    [
      'rest',
      '--method',
      'get',
      '--url',
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?api-version=2021-07-01`,
      '-o',
      'json',
    ],
    { timeoutMs: 180_000 },
  )
  const payload = JSON.parse(stdout)
  return Array.isArray(payload.value) ? payload.value : Array.isArray(payload) ? payload : []
}

async function fetchProviderResourceTypeLocations(namespace, typeName) {
  const { stdout } = await runAz(['provider', 'show', '--namespace', namespace, '-o', 'json'], {
    timeoutMs: 90_000,
  })
  const provider = JSON.parse(stdout)
  const types = Array.isArray(provider.resourceTypes) ? provider.resourceTypes : []
  const match = types.find(
    (type) => String(type.resourceType || '').toLowerCase() === String(typeName).toLowerCase(),
  )
  if (!match) return []
  return (match.locations || [])
    .map((location) => normalizeLocationKey(location))
    .filter(Boolean)
}

function computeSkuAvailableInRegion(skuRows, sku, size, regionId) {
  const regionKey = normalizeLocationKey(regionId)
  const exactCandidates = [sku, size]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  const family = toSkuFamily(sku, size)

  const matches = skuRows.filter((row) => {
    if (String(row.resourceType || '') !== 'virtualMachines') return false
    const name = String(row.name || '')
    if (exactCandidates.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) {
      return true
    }
    if (family && toSkuFamily(name).toLowerCase() === family.toLowerCase()) {
      return true
    }
    return false
  })

  if (!matches.length) {
    return {
      available: false,
      status: 'unavailable',
      reason: family
        ? `SKU/family ${family} not found in Microsoft.Compute SKUs for this subscription`
        : 'SKU not found in Microsoft.Compute SKUs for this subscription',
    }
  }

  const inRegion = matches.filter((row) =>
    (row.locations || []).some((location) => normalizeLocationKey(location) === regionKey),
  )
  if (!inRegion.length) {
    return {
      available: false,
      status: 'unavailable',
      reason: `Compute SKU ${exactCandidates[0] || family} is not offered in this region`,
    }
  }

  const restricted = inRegion.filter((row) => {
    const restrictions = Array.isArray(row.restrictions) ? row.restrictions : []
    return restrictions.some((restriction) => {
      const type = String(restriction.type || '').toLowerCase()
      const reasonCode = String(restriction.reasonCode || '').toLowerCase()
      if (type === 'location' || reasonCode === 'notavailableforsubscription') return true
      const locations = restriction.restrictionInfo?.locations || []
      return locations.some((location) => normalizeLocationKey(location) === regionKey)
    })
  })

  if (restricted.length === inRegion.length) {
    const detail = restricted
      .flatMap((row) => row.restrictions || [])
      .map((restriction) => restriction.reasonCode || restriction.type)
      .filter(Boolean)
      .slice(0, 2)
      .join(', ')
    return {
      available: false,
      status: 'restricted',
      reason: detail
        ? `SKU is restricted in this region (${detail})`
        : 'SKU is restricted in this region for this subscription',
    }
  }

  return {
    available: true,
    status: 'available',
    reason: family ? `Compute SKU/family ${family} is available` : 'Compute SKU is available',
  }
}

async function evaluateInventoryForRegions({
  azureSubscriptionId,
  targetRegions,
  items,
}) {
  const displayNames = await listLocationDisplayNames()
  const aliases = locationAliases(displayNames)
  const normalizedTargets = targetRegions.map((region) => {
    const raw = typeof region === 'string' ? region : region.id || region.label || ''
    const id =
      aliases.get(normalizeLocationKey(raw)) ||
      String(raw).toLowerCase().replace(/\s+/g, '') ||
      normalizeLocationKey(raw)
    const label =
      (typeof region === 'object' && region.label) ||
      displayNames.get(id) ||
      String(raw)
    return { id, label }
  })

  const needsComputeSkus = items.some((item) =>
    COMPUTE_SKU_RESOURCE_TYPES.has(String(item.resourceType || '')),
  )
  let computeSkus = []
  const errors = []
  if (needsComputeSkus) {
    try {
      computeSkus = await fetchComputeSkus(azureSubscriptionId)
    } catch (err) {
      errors.push({
        scope: 'Microsoft.Compute/skus',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const providerLocationCache = new Map()
  async function providerLocationsFor(resourceType) {
    const mapping = RESOURCE_TYPE_PROVIDERS[resourceType]
    if (!mapping) return null
    const cacheKey = `${mapping.namespace}:${mapping.typeName}`
    if (providerLocationCache.has(cacheKey)) return providerLocationCache.get(cacheKey)
    try {
      const locations = await fetchProviderResourceTypeLocations(
        mapping.namespace,
        mapping.typeName,
      )
      providerLocationCache.set(cacheKey, locations)
      return locations
    } catch (err) {
      errors.push({
        scope: cacheKey,
        message: err instanceof Error ? err.message : String(err),
      })
      providerLocationCache.set(cacheKey, null)
      return null
    }
  }

  const results = []
  for (const item of items) {
    const resourceType = String(item.resourceType || 'Unknown')
    const sku = String(item.sku || '').trim() || '—'
    const size = item.size ? String(item.size) : undefined
    const byRegion = {}
    const sourceRegionsRaw = Array.isArray(item.sourceRegions) ? item.sourceRegions : []
    const sourceRegionCountsRaw =
      item.sourceRegionCounts && typeof item.sourceRegionCounts === 'object'
        ? item.sourceRegionCounts
        : {}

    for (const region of normalizedTargets) {
      if (COMPUTE_SKU_RESOURCE_TYPES.has(resourceType) && computeSkus.length) {
        byRegion[region.id] = computeSkuAvailableInRegion(computeSkus, sku, size, region.id)
        continue
      }

      const locations = await providerLocationsFor(resourceType)
      if (!locations) {
        byRegion[region.id] = {
          available: null,
          status: 'unknown',
          reason: RESOURCE_TYPE_PROVIDERS[resourceType]
            ? 'Could not load provider location metadata'
            : 'No provider mapping for this resource type',
        }
        continue
      }

      const regionKey = normalizeLocationKey(region.id)
      const regionLabelKey = normalizeLocationKey(region.label)
      const available =
        locations.includes(regionKey) || locations.includes(regionLabelKey)
      byRegion[region.id] = {
        available,
        status: available ? 'available' : 'unavailable',
        reason: available
          ? `${resourceType} is offered in this region`
          : `${resourceType} is not offered in this region`,
      }
    }

    const bySourceRegion = {}
    const sourceRegionMeta = []
    const sourceRegionCounts = {}
    for (const raw of sourceRegionsRaw) {
      const rawKey = normalizeLocationKey(raw)
      const id =
        aliases.get(rawKey) ||
        String(raw).toLowerCase().replace(/\s+/g, '') ||
        rawKey
      if (!id) continue
      const label = displayNames.get(id) || String(raw)
      if (!bySourceRegion[id]) {
        bySourceRegion[id] = {
          available: true,
          status: 'available',
          reason: 'Source / current deployment region',
          label,
        }
        sourceRegionMeta.push({ id, label })
        sourceRegionCounts[id] = 0
      }
      const countHint =
        sourceRegionCountsRaw[raw] ??
        sourceRegionCountsRaw[id] ??
        sourceRegionCountsRaw[label]
      sourceRegionCounts[id] +=
        countHint != null && Number.isFinite(Number(countHint)) ? Number(countHint) : 0
    }
    // If per-source counts were not provided, fall back to spreading/unknown — leave 0
    // and let enrich use full resourceCount when counts are missing.
    const hasAnySourceCount = Object.values(sourceRegionCounts).some((n) => n > 0)
    const normalizedSourceCounts = hasAnySourceCount ? sourceRegionCounts : undefined

    results.push({
      resourceType,
      sku,
      size: size || null,
      family: toSkuFamily(sku, size) || null,
      resourceCount: Number(item.resourceCount || 0),
      sourceRegions: sourceRegionMeta.map((r) => r.label),
      sourceRegionMeta,
      sourceRegionCounts: normalizedSourceCounts || null,
      bySourceRegion,
      byRegion,
    })
  }

  try {
    await enrichResultsWithRetailPrices(results, normalizedTargets, { concurrency: 8 })
  } catch (err) {
    errors.push({
      scope: 'Azure Retail Prices',
      message: err instanceof Error ? err.message : String(err),
    })
  }

  let fullyAvailable = 0
  let partiallyAvailable = 0
  let unavailable = 0
  let unknown = 0
  for (const row of results) {
    const statuses = normalizedTargets.map((region) => row.byRegion[region.id]?.status)
    if (statuses.every((status) => status === 'available')) fullyAvailable += 1
    else if (statuses.every((status) => status === 'unavailable' || status === 'restricted'))
      unavailable += 1
    else if (statuses.some((status) => status === 'unknown')) unknown += 1
    else partiallyAvailable += 1
  }

  return {
    fetchedAt: new Date().toISOString(),
    azureSubscriptionId,
    targetRegions: normalizedTargets,
    results,
    summary: {
      itemCount: results.length,
      fullyAvailable,
      partiallyAvailable,
      unavailable,
      unknown,
    },
    errors,
  }
}

app.get('/api/azure/locations', async (_req, res) => {
  try {
    let account = null
    try {
      account = await getAccount()
      connection.account = account
      connection.tenantId = account.tenantId || connection.tenantId
      connection.status = 'connected'
      connection.connectedAt = connection.connectedAt || new Date().toISOString()
      connection.error = null
    } catch (err) {
      return res.status(401).json({
        error: err instanceof Error ? err.message : String(err),
        hint: 'No active Azure CLI session. Connect a tenant on Azure Connect, then return here.',
        connection: publicConnection(),
      })
    }
    const locations = await listAzureLocations(account?.id)
    res.json({
      fetchedAt: new Date().toISOString(),
      locations,
      connection: publicConnection(),
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Connect an Azure tenant first, then reload Azure locations.',
    })
  }
})

app.post('/api/azure/region-evaluation', async (req, res) => {
  try {
    const account = await getAccount()
    const azureSubscriptionId = String(
      req.body?.azureSubscriptionId || account.id || '',
    ).trim()
    const targetRegions = Array.isArray(req.body?.targetRegions) ? req.body.targetRegions : []
    const items = Array.isArray(req.body?.items) ? req.body.items : []

    if (!azureSubscriptionId) {
      return res.status(400).json({ error: 'azureSubscriptionId is required' })
    }
    if (!targetRegions.length) {
      return res.status(400).json({ error: 'Select at least one target region' })
    }
    if (!items.length) {
      return res.status(400).json({ error: 'No inventory items to evaluate' })
    }

    const evaluation = await evaluateInventoryForRegions({
      azureSubscriptionId,
      targetRegions,
      items,
    })
    res.json({
      account,
      ...evaluation,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Region evaluation requires an active Azure session with access to Compute SKUs and provider metadata.',
    })
  }
})

const COMPUTE_TYPE_MAP = {
  'microsoft.compute/virtualmachines': 'Virtual Machine',
  'microsoft.compute/virtualmachinescalesets/virtualmachines': 'Virtual Machine',
  'microsoft.sql/servers/databases': 'Azure SQL Database',
  'microsoft.sql/servers': 'Azure SQL Server',
  'microsoft.sql/managedinstances': 'Azure SQL Managed Instance',
  'microsoft.dbforpostgresql/flexibleservers': 'Azure Database for PostgreSQL',
  'microsoft.dbforpostgresql/servers': 'Azure Database for PostgreSQL',
  'microsoft.dbformysql/flexibleservers': 'Azure Database for MySQL',
  'microsoft.dbformysql/servers': 'Azure Database for MySQL',
  'microsoft.documentdb/databaseaccounts': 'Azure Cosmos DB',
  'containerservice/managedclusters': 'Azure Kubernetes Service',
  'microsoft.containerservice/managedclusters': 'Azure Kubernetes Service',
  'microsoft.containerinstance/containergroups': 'Container Instances',
  'microsoft.app/containerapps': 'Azure Container Apps',
  'microsoft.app/managedenvironments': 'Azure Container Apps Environment',
  'microsoft.databricks/workspaces': 'Azure Databricks',
  'microsoft.kusto/clusters': 'Azure Data Explorer',
  'microsoft.cache/redis': 'Azure Cache for Redis',
  'microsoft.cache/redisenterprise': 'Azure Managed Redis',
  'microsoft.keyvault/vaults': 'Key Vault',
  'microsoft.storage/storageaccounts': 'Storage Account',
  'microsoft.network/applicationgateways': 'Application Gateway',
  'microsoft.apimanagement/service': 'API Management',
  'microsoft.network/virtualnetworkgateways': 'VPN Gateway',
}

function resolveInventoryResourceType(typeKey) {
  const mapped = COMPUTE_TYPE_MAP[typeKey]
  if (mapped) return mapped
  if (typeKey.includes('virtualmachine')) return 'Virtual Machine'
  if (typeKey.includes('databricks')) return 'Azure Databricks'
  if (typeKey.includes('kusto')) return 'Azure Data Explorer'
  if (typeKey.includes('managedenvironment')) {
    return 'Azure Container Apps Environment'
  }
  if (typeKey.includes('containerapp') || typeKey.includes('microsoft.app/')) {
    return 'Azure Container Apps'
  }
  if (typeKey.includes('mysql')) return 'Azure Database for MySQL'
  if (typeKey.includes('postgresql') || typeKey.includes('postgres')) {
    return 'Azure Database for PostgreSQL'
  }
  if (typeKey.includes('managedinstance')) return 'Azure SQL Managed Instance'
  if (typeKey.includes('microsoft.sql')) return 'Azure SQL Database'
  if (typeKey.includes('documentdb') || typeKey.includes('cosmos')) return 'Azure Cosmos DB'
  if (typeKey.includes('redisenterprise')) return 'Azure Managed Redis'
  if (typeKey.includes('redis') || typeKey.includes('microsoft.cache')) {
    return 'Azure Cache for Redis'
  }
  if (typeKey.includes('keyvault')) return 'Key Vault'
  if (typeKey.includes('storageaccount')) return 'Storage Account'
  if (typeKey.includes('applicationgateway')) return 'Application Gateway'
  if (typeKey.includes('apimanagement')) return 'API Management'
  if (typeKey.includes('virtualnetworkgateway')) return 'VPN Gateway'
  if (typeKey.includes('containerservice') || typeKey.includes('managedcluster')) {
    return 'Azure Kubernetes Service'
  }
  if (typeKey.includes('containerinstance') || typeKey.includes('containergroup')) {
    return 'Container Instances'
  }
  return typeKey.split('/').pop() || 'Unknown'
}

/**
 * Parse workloadProfiles JSON from a managed environment ARG row.
 * @param {unknown} raw
 * @returns {Array<{ name: string, type: string, min?: number, max?: number }>}
 */
function parseWorkloadProfiles(raw) {
  if (raw == null || raw === '') return []
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((p) => {
      if (!p || typeof p !== 'object') return null
      const name = String(p.name || '').trim()
      const type = String(p.workloadProfileType || p.workloadProfileTypeName || '').trim()
      const min =
        p.minimumCount != null && Number.isFinite(Number(p.minimumCount))
          ? Number(p.minimumCount)
          : undefined
      const max =
        p.maximumCount != null && Number.isFinite(Number(p.maximumCount))
          ? Number(p.maximumCount)
          : undefined
      if (!name && !type) return null
      return { name: name || type, type: type || name, min, max }
    })
    .filter(Boolean)
}

/**
 * Human-readable workload profile size, e.g. "D4 (1-10)" or "Consumption".
 * @param {{ name: string, type: string, min?: number, max?: number }} profile
 */
function formatWorkloadProfileSize(profile) {
  const type = String(profile?.type || profile?.name || '').trim()
  if (!type) return ''
  if (/^consumption$/i.test(type)) return 'Consumption'
  const min = profile?.min
  const max = profile?.max
  if (min != null || max != null) {
    return `${type} (${min ?? 0}-${max ?? '?'})`
  }
  return type
}

app.get('/api/azure/inventory', async (req, res) => {
  try {
    const account = await getAccount()
    const subscriptionId = String(req.query.subscriptionId || account.id || '').trim()
    if (!subscriptionId) {
      return res.status(400).json({ error: 'No subscription selected' })
    }

    const regionsFilter = String(req.query.regions || '')
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean)

    const locationFilter =
      regionsFilter.length > 0
        ? `| where tolower(tostring(location)) in (${regionsFilter
            .map((r) => `'${r.replace(/'/g, "''")}'`)
            .join(', ')})`
        : ''

    const query = `
      Resources
      | where type in~ (
          'microsoft.compute/virtualmachines',
          'microsoft.compute/virtualmachinescalesets',
          'microsoft.compute/virtualmachinescalesets/virtualmachines',
          'microsoft.sql/servers/databases',
          'microsoft.sql/servers',
          'microsoft.sql/managedinstances',
          'microsoft.dbforpostgresql/flexibleservers',
          'microsoft.dbformysql/flexibleservers',
          'microsoft.dbforpostgresql/servers',
          'microsoft.dbformysql/servers',
          'microsoft.documentdb/databaseaccounts',
          'microsoft.containerservice/managedclusters',
          'microsoft.containerinstance/containergroups',
          'microsoft.app/containerapps',
          'microsoft.app/managedenvironments',
          'microsoft.databricks/workspaces',
          'microsoft.kusto/clusters',
          'microsoft.cache/redis',
          'microsoft.cache/redisEnterprise',
          'microsoft.keyvault/vaults',
          'microsoft.storage/storageAccounts',
          'microsoft.network/applicationGateways',
          'microsoft.apimanagement/service',
          'microsoft.network/virtualNetworkGateways'
        )
      ${locationFilter}
      | extend skuName = coalesce(
          tostring(properties.hardwareProfile.vmSize),
          tostring(properties.currentSku.name),
          tostring(sku.name),
          tostring(properties.sku.name),
          tostring(sku.tier),
          tostring(properties.sku.tier),
          tostring(properties.sku.family),
          ''
        )
      | extend sizeHint = coalesce(
          tostring(properties.hardwareProfile.vmSize),
          tostring(sku.name),
          tostring(properties.sku.name),
          tostring(properties.sku.tier),
          ''
        )
      | extend skuCapacity = toint(sku.capacity)
      | extend orchestrationMode = tostring(properties.orchestrationMode)
      | extend vmssName = extract(@'(?i)/virtualMachineScaleSets/([^/]+)', 1, id)
      | extend managedEnvironmentId = tostring(properties.managedEnvironmentId)
      | extend workloadProfileName = tostring(properties.workloadProfileName)
      | extend workloadProfilesJson = iff(
          type =~ 'microsoft.app/managedenvironments',
          tostring(properties.workloadProfiles),
          ''
        )
      | project
          id,
          name,
          type,
          location,
          resourceGroup,
          subscriptionId,
          skuName,
          sizeHint,
          skuCapacity,
          orchestrationMode,
          vmssName,
          managedEnvironmentId,
          workloadProfileName,
          workloadProfilesJson
      | order by type asc, name asc
    `

    const rows = await resourceGraphQuery(query, [subscriptionId], 1000)

    /** @type {Map<string, { name: string, profiles: Array<{ name: string, type: string, min?: number, max?: number }> }>} */
    const environmentById = new Map()
    for (const row of Array.isArray(rows) ? rows : []) {
      const typeKey = String(row.type || '').toLowerCase()
      if (typeKey !== 'microsoft.app/managedenvironments') continue
      const profiles = parseWorkloadProfiles(row.workloadProfilesJson)
      environmentById.set(String(row.id || '').toLowerCase(), {
        name: String(row.name || ''),
        profiles,
      })
    }

    // Resolve environments referenced by apps but not returned in this subscription query
    // (e.g. cross-RG already covered; cross-sub is rare — still try ARM GET).
    const missingEnvIds = [
      ...new Set(
        (Array.isArray(rows) ? rows : [])
          .filter((row) => String(row.type || '').toLowerCase() === 'microsoft.app/containerapps')
          .map((row) => String(row.managedEnvironmentId || '').trim())
          .filter((id) => id && !environmentById.has(id.toLowerCase())),
      ),
    ].slice(0, 25)

    for (const envId of missingEnvIds) {
      try {
        const { stdout } = await runAz(
          [
            'rest',
            '--method',
            'get',
            '--url',
            `https://management.azure.com${envId}?api-version=2024-03-01`,
            '-o',
            'json',
          ],
          { timeoutMs: 60_000 },
        )
        const env = JSON.parse(stdout)
        environmentById.set(envId.toLowerCase(), {
          name: String(env.name || envId.split('/').pop() || ''),
          profiles: parseWorkloadProfiles(env.properties?.workloadProfiles),
        })
      } catch {
        // Keep app row with profile name only when environment lookup fails.
      }
    }

    const allRows = Array.isArray(rows) ? rows : []
    const vmssParents = new Map()
    for (const row of allRows) {
      if (String(row.type || '').toLowerCase() !== 'microsoft.compute/virtualmachinescalesets') {
        continue
      }
      vmssParents.set(String(row.id || '').toLowerCase(), row)
    }

    const resources = []
    const vmssInstanceCountByParent = new Map()

    for (const row of allRows) {
      const typeKey = String(row.type || '').toLowerCase()
      // Parent scale sets are expanded to instances; do not keep the scale-set resource itself.
      if (typeKey === 'microsoft.compute/virtualmachinescalesets') continue

      const resourceType = resolveInventoryResourceType(typeKey)

      if (typeKey === 'microsoft.compute/virtualmachinescalesets/virtualmachines') {
        const parentId = String(row.id || '').replace(/\/virtualMachines\/[^/]+$/i, '')
        const parentKey = parentId.toLowerCase()
        vmssInstanceCountByParent.set(parentKey, (vmssInstanceCountByParent.get(parentKey) || 0) + 1)
        const parent = vmssParents.get(parentKey)
        const vmssName = String(row.vmssName || parent?.name || parentId.split('/').pop() || 'vmss')
        const sku =
          row.skuName ||
          row.sizeHint ||
          parent?.skuName ||
          parent?.sizeHint ||
          'unknown'
        resources.push({
          id: row.id || randomUUID(),
          name: `${vmssName}/${row.name}`,
          type: row.type,
          resourceType: 'Virtual Machine',
          sku,
          size: sku,
          region: row.location || parent?.location,
          resourceGroup: row.resourceGroup || parent?.resourceGroup,
          subscriptionId: row.subscriptionId || parent?.subscriptionId || subscriptionId,
          source: 'Customer tenant',
        })
        continue
      }

      if (typeKey === 'microsoft.app/managedenvironments') {
        const profiles = parseWorkloadProfiles(row.workloadProfilesJson)
        const profileSummary =
          profiles.length > 0
            ? profiles
                .map((p) => formatWorkloadProfileSize(p))
                .filter(Boolean)
                .join(', ')
            : 'Consumption'
        resources.push({
          id: row.id || randomUUID(),
          name: row.name,
          type: row.type,
          resourceType,
          sku: profiles.some((p) => !/^consumption$/i.test(p.type || p.name || ''))
            ? 'Workload profiles'
            : 'Consumption',
          size: profileSummary || undefined,
          region: row.location,
          resourceGroup: row.resourceGroup,
          subscriptionId: row.subscriptionId || subscriptionId,
          source: 'Customer tenant',
        })
        continue
      }

      if (typeKey === 'microsoft.app/containerapps') {
        const envId = String(row.managedEnvironmentId || '').trim()
        const env = environmentById.get(envId.toLowerCase())
        const profileName = String(row.workloadProfileName || '').trim() || 'Consumption'
        const matched = env?.profiles?.find(
          (p) => p.name.toLowerCase() === profileName.toLowerCase(),
        )
        const profileType = matched?.type || (/^consumption$/i.test(profileName) ? 'Consumption' : '')
        const sizeLabel = matched
          ? formatWorkloadProfileSize(matched)
          : profileType || profileName
        const envLabel = env?.name || (envId ? envId.split('/').pop() : '')
        resources.push({
          id: row.id || randomUUID(),
          name: row.name,
          type: row.type,
          resourceType,
          sku: envLabel ? `${profileName} @ ${envLabel}` : profileName,
          size: sizeLabel || undefined,
          region: row.location,
          resourceGroup: row.resourceGroup,
          subscriptionId: row.subscriptionId || subscriptionId,
          source: 'Customer tenant',
        })
        continue
      }

      resources.push({
        id: row.id || randomUUID(),
        name: row.name,
        type: row.type,
        resourceType,
        sku: row.skuName || row.sizeHint || row.type?.split('/').pop() || 'unknown',
        size: row.sizeHint || undefined,
        region: row.location,
        resourceGroup: row.resourceGroup,
        subscriptionId: row.subscriptionId || subscriptionId,
        source: 'Customer tenant',
      })
    }

    // Uniform VMSS instances are sometimes missing from Resource Graph. Expand from sku.capacity.
    const MAX_SYNTHETIC_VMSS_INSTANCES = 2000
    for (const [parentKey, parent] of vmssParents) {
      const mode = String(parent.orchestrationMode || '')
      if (/flexible/i.test(mode)) continue
      if ((vmssInstanceCountByParent.get(parentKey) || 0) > 0) continue
      const capacity = Number(parent.skuCapacity)
      if (!Number.isFinite(capacity) || capacity <= 0) continue
      const count = Math.min(Math.floor(capacity), MAX_SYNTHETIC_VMSS_INSTANCES)
      const sku = parent.skuName || parent.sizeHint || 'unknown'
      for (let i = 0; i < count; i++) {
        resources.push({
          id: `${parent.id}/virtualMachines/${i}`,
          name: `${parent.name}/${i}`,
          type: 'microsoft.compute/virtualmachinescalesets/virtualmachines',
          resourceType: 'Virtual Machine',
          sku,
          size: sku,
          region: parent.location,
          resourceGroup: parent.resourceGroup,
          subscriptionId: parent.subscriptionId || subscriptionId,
          source: 'Customer tenant',
        })
      }
    }

    res.json({
      fetchedAt: new Date().toISOString(),
      account,
      subscriptionId,
      regions: regionsFilter,
      count: resources.length,
      resources,
      query:
        'Azure Resource Graph — VMs, VMSS instances, SQL, MySQL, PostgreSQL, Cosmos DB, AKS, containers, Container Apps (+ environments/workload profiles), Redis, Key Vault, Storage, App Gateway, APIM, VPN Gateway, Databricks, ADX',
    })
  } catch (err) {
    sendRouteError(
      res,
      500,
      err,
      'Ensure the resource-graph extension is installed and the subscription is accessible.',
    )
  }
})

app.get('/api/azure/quotas', async (req, res) => {
  try {
    const account = await getAccount()
    const regionsParam = String(req.query.regions || '')
    const regions = (regionsParam
      ? regionsParam.split(',')
      : DEFAULT_REGIONS
    )
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean)

    const { stdout: subsOut } = await runAz(['account', 'list', '-o', 'json'], { timeoutMs: 60_000 })
    const subscriptions = JSON.parse(subsOut).filter((s) => s.state === 'Enabled')
    const requestedSub = String(req.query.subscriptionId || '').trim()

    /** Graph + Resource Graph context */
    let organization = null
    try {
      const { stdout } = await runAz(
        [
          'rest',
          '--method',
          'get',
          '--url',
          'https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains',
          '-o',
          'json',
        ],
        { timeoutMs: 45_000 },
      )
      const payload = JSON.parse(stdout)
      organization = payload.value?.[0] ?? payload
    } catch {
      organization = null
    }

    let resourceGraphSummary = []
    try {
      const query = `
        Resources
        | where type in~ (
            'microsoft.compute/virtualmachines',
            'microsoft.sql/servers/databases',
            'microsoft.containerservice/managedclusters',
            'microsoft.databricks/workspaces',
            'microsoft.kusto/clusters'
          )
        | summarize resourceCount = count() by subscriptionId, location, type, sku = tostring(sku.name)
        | order by resourceCount desc
        | take 100
      `
      const subsForGraph = requestedSub ? [requestedSub] : account.id ? [account.id] : []
      resourceGraphSummary = await resourceGraphQuery(query, subsForGraph, 100)
    } catch {
      resourceGraphSummary = []
    }

    const quotaRows = []
    const errors = []

    // Prefer requested / signed-in subscription first
    const orderedSubs = (
      requestedSub
        ? [
            ...subscriptions.filter((s) => s.id === requestedSub),
            ...subscriptions.filter((s) => s.id !== requestedSub),
          ]
        : [
            ...subscriptions.filter((s) => s.id === account.id),
            ...subscriptions.filter((s) => s.id !== account.id),
          ]
    ).slice(0, req.query.all === '1' ? 5 : 1)

    const locationsToQuery = regions.slice(0, req.query.all === '1' ? 4 : Math.min(regions.length, 2))

    for (const sub of orderedSubs) {
      const collected = await collectProviderQuotas({
        subscriptionId: sub.id,
        subscriptionName: sub.name,
        tenantId: account.tenantId,
        locations: locationsToQuery,
      })
      quotaRows.push(...collected.quotas)
      errors.push(...collected.errors)
    }

    const seen = new Set()
    const deduped = []
    for (const row of quotaRows) {
      const key = `${row.subscriptionId}|${row.region}|${row.quotaGroup}|${row.nameValue || row.name}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(row)
    }
    deduped.sort((a, b) => b.usage / Math.max(b.limit, 1) - a.usage / Math.max(a.limit, 1))
    const quotas = deduped

    res.json({
      fetchedAt: new Date().toISOString(),
      account,
      organization,
      subscriptions: orderedSubs.map((s) => ({
        id: s.id,
        name: s.name,
        isDefault: s.isDefault,
      })),
      regions,
      quotas,
      providers: QUOTA_PROVIDERS.map((p) => p.label),
      resourceGraphSummary,
      errors,
    })
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Connect a tenant first, then retry quota collection.',
    })
  }
})

app.post('/api/azure/quotas/collect', async (req, res) => {
  try {
    const azureSubscriptionId = String(req.body?.subscriptionId || '').trim()
    const customerId = String(req.body?.customerId || '').trim()
    const localSubscriptionId = String(req.body?.localSubscriptionId || '').trim()
    const regionsParam = Array.isArray(req.body?.regions) ? req.body.regions : []
    if (!azureSubscriptionId) {
      return res.status(400).json({ error: 'subscriptionId is required' })
    }
    if (!customerId || !localSubscriptionId) {
      return res.status(400).json({ error: 'customerId and localSubscriptionId are required' })
    }

    const regions = (regionsParam.length ? regionsParam : DEFAULT_REGIONS)
      .map((r) => String(r).trim().toLowerCase())
      .filter(Boolean)

    const account = await getAccount()
    await runAz(['account', 'set', '--subscription', azureSubscriptionId], { timeoutMs: 45_000 })

    let subscriptionName = account.name
    try {
      const { stdout } = await runAz(['account', 'show', '-o', 'json'], { timeoutMs: 30_000 })
      const current = JSON.parse(stdout)
      subscriptionName = current.name || subscriptionName
    } catch {
      // keep fallback name
    }

    const locationsToQuery = regions
    const { quotas, errors } = await collectProviderQuotas({
      subscriptionId: azureSubscriptionId,
      subscriptionName,
      tenantId: account.tenantId,
      locations: locationsToQuery,
    })

    const now = new Date().toISOString()
    const persistItems = quotas.map((q) => ({
      id: q.id,
      customerId,
      subscriptionId: localSubscriptionId,
      azureSubscriptionId,
      subscriptionName: q.subscriptionName,
      tenantId: q.tenantId,
      region: q.region,
      name: q.name,
      nameValue: q.nameValue,
      usage: q.usage,
      limit: q.limit,
      unit: q.unit,
      source: q.source,
      quotaGroup: q.quotaGroup,
      collectedAt: now,
    }))

    const saved = await replaceQuotas({
      azureSubscriptionId,
      customerId,
      subscriptionId: localSubscriptionId,
      items: persistItems,
    })

    res.json({
      fetchedAt: now,
      account,
      regions: locationsToQuery,
      quotas,
      providers: QUOTA_PROVIDERS.map((p) => p.label),
      saved: saved.imported,
      errors,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Quota collect+persist failed. Confirm the Azure session and subscription access.',
    })
  }
})

app.post('/api/azure/quota-groups/collect', async (req, res) => {
  try {
    const customerId = String(req.body?.customerId || '').trim()
    const tenantId = String(req.body?.tenantId || '').trim()
    const managementGroupId = String(req.body?.managementGroupId || '').trim()
    const regionsParam = Array.isArray(req.body?.regions) ? req.body.regions : []
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' })
    }

    const account = await getAccount()
    const regions = (regionsParam.length ? regionsParam : DEFAULT_REGIONS)
      .map((r) => String(r).trim().toLowerCase())
      .filter(Boolean)
    const locationsToQuery = regions

    const { quotaGroupLimits, discoveredGroups, errors } = await collectAzureQuotaGroups({
      tenantId: tenantId || account.tenantId,
      locations: locationsToQuery,
      managementGroupId: managementGroupId || undefined,
    })

    const now = new Date().toISOString()
    const persistItems = quotaGroupLimits.map((row) => ({
      ...row,
      customerId,
      tenantId: tenantId || account.tenantId,
      collectedAt: now,
    }))

    const saved = persistItems.length
      ? (await replaceQuotaGroupLimits({ customerId, tenantId: tenantId || account.tenantId, items: persistItems }))
          .imported
      : 0

    res.json({
      fetchedAt: now,
      account,
      regions: locationsToQuery,
      quotaGroupLimits: persistItems,
      discoveredGroups,
      saved,
      errors,
      hint:
        saved === 0
          ? discoveredGroups.length
            ? `Found ${discoveredGroups.length} quota group(s) but no compute limits in the selected regions.`
            : 'No Azure Quota Groups were returned. Confirm GroupQuota permissions on the management group and that quota groups exist in the tenant.'
          : undefined,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Quota group collect failed. Confirm the Azure session and GroupQuota Request Operator role on the management group.',
    })
  }
})

app.get('/api/data/bootstrap', async (req, res) => {
  try {
    const data = await getBootstrap()
    const raw = JSON.stringify(data)
    const acceptGzip = String(req.headers['accept-encoding'] || '').includes('gzip')
    // Inventory-heavy payloads can be several MB; gzip avoids proxy/client cutoffs.
    if (acceptGzip && raw.length > 2048) {
      const compressed = gzipSync(Buffer.from(raw, 'utf8'))
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Vary', 'Accept-Encoding')
      return res.status(200).send(compressed)
    }
    res.type('json').send(raw)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/data/inventory/resource-types', async (_req, res) => {
  try {
    const resourceTypes = await listInventoryResourceTypes()
    res.json({ resourceTypes })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/data/inventory/skus', async (req, res) => {
  try {
    const resourceType = String(req.query.resourceType || '').trim()
    if (!resourceType) {
      return res.status(400).json({ error: 'resourceType query parameter is required' })
    }
    const skus = await listInventorySkus(resourceType)
    res.json({ resourceType, skus })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/impact-analysis', async (req, res) => {
  try {
    const { sku, resourceType, regions, customerId, subscriptionId, constraintId } = req.body || {}
    if (!sku || !resourceType || !Array.isArray(regions) || regions.length === 0) {
      return res.status(400).json({
        error: 'sku, resourceType, and regions[] are required',
      })
    }
    const impacts = await runInventoryImpactAnalysis({
      sku,
      resourceType,
      regions,
      customerId,
      subscriptionId,
      constraintId,
    })
    res.json({
      impacts,
      summary: {
        customerCount: new Set(impacts.map((i) => i.customerId)).size,
        resourceCount: impacts.reduce((sum, i) => sum + i.matchingResourceCount, 0),
        rowCount: impacts.length,
      },
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/customers', async (req, res) => {
  try {
    const saved = await upsertCustomer(req.body)
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/subscriptions', async (req, res) => {
  try {
    const saved = await upsertSubscription(req.body)
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/inventory', async (req, res) => {
  try {
    const { customerId, subscriptionId, items } = req.body || {}
    if (!customerId || !subscriptionId || !Array.isArray(items)) {
      return res.status(400).json({ error: 'customerId, subscriptionId and items[] are required' })
    }
    const result = await replaceInventory({ customerId, subscriptionId, items })
    res.json(result)
  } catch (err) {
    sendRouteError(
      res,
      400,
      err,
      'Inventory was retrieved from Azure but failed while storing rows in PostgreSQL.',
    )
  }
})

app.post('/api/data/quotas', async (req, res) => {
  try {
    const { azureSubscriptionId, customerId, subscriptionId, items } = req.body || {}
    if (!azureSubscriptionId || !Array.isArray(items)) {
      return res
        .status(400)
        .json({ error: 'azureSubscriptionId and items[] are required' })
    }
    const result = await replaceQuotas({
      azureSubscriptionId,
      customerId,
      subscriptionId,
      items,
    })
    res.json(result)
  } catch (err) {
    sendRouteError(
      res,
      400,
      err,
      'Quotas were retrieved from Azure but failed while storing rows in PostgreSQL.',
    )
  }
})

app.post('/api/data/quota-groups', async (req, res) => {
  try {
    const { customerId, tenantId, items } = req.body || {}
    if (!customerId || !Array.isArray(items)) {
      return res.status(400).json({ error: 'customerId and items[] are required' })
    }
    const result = await replaceQuotaGroupLimits({ customerId, tenantId, items })
    res.json(result)
  } catch (err) {
    sendRouteError(
      res,
      400,
      err,
      'Quota groups were retrieved from Azure but failed while storing rows in PostgreSQL.',
    )
  }
})

app.put('/api/data/connection', async (req, res) => {
  try {
    const saved = await saveConnection(req.body || {})
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/data/connection', async (_req, res) => {
  try {
    await clearConnection()
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/constraints', async (req, res) => {
  try {
    const { constraint, impacts, alerts, reward } = req.body || {}
    if (!constraint?.id) {
      return res.status(400).json({ error: 'constraint with id is required' })
    }
    const saved = await persistConstraintBundle({
      constraint,
      impacts: impacts || [],
      alerts: alerts || [],
      reward: reward || null,
    })
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.put('/api/data/constraints/:id', async (req, res) => {
  try {
    const constraint = { ...(req.body || {}), id: req.params.id }
    if (!constraint.sku) {
      return res.status(400).json({ error: 'constraint payload is required' })
    }
    const saved = await upsertConstraint(constraint)
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/constraints/:id/impacts', async (req, res) => {
  try {
    const impacts = Array.isArray(req.body?.impacts) ? req.body.impacts : []
    const saved = await replaceImpactsForConstraint(req.params.id, impacts)
    res.json({ impacts: saved })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/rewards', async (req, res) => {
  try {
    const event = req.body
    if (!event?.id || !event?.userId || !event?.action) {
      return res.status(400).json({ error: 'id, userId, and action are required' })
    }
    const saved = await insertRewardEvent(event)
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/engagements', async (req, res) => {
  try {
    const engagement = req.body
    if (!engagement?.id || !engagement?.constraintId || !engagement?.customerId) {
      return res
        .status(400)
        .json({ error: 'id, constraintId, and customerId are required' })
    }
    const saved = await upsertEngagement(engagement)
    const reward = req.body?.reward
    if (reward?.id) {
      await insertRewardEvent(reward)
    }
    res.json({ engagement: saved, reward: reward || null })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.patch('/api/data/alerts/:id/read', async (req, res) => {
  try {
    const saved = await markAlertReadDb(req.params.id)
    if (!saved) return res.status(404).json({ error: 'Alert not found' })
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/data/saved-reports', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim()
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' })
    }
    const reports = await listSavedReportsForUser(userId)
    res.json({ reports })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/saved-reports', async (req, res) => {
  try {
    const { id, name, ownerUserId, visibility, config } = req.body || {}
    if (!name || !ownerUserId || !config) {
      return res.status(400).json({ error: 'name, ownerUserId, and config are required' })
    }
    if (visibility !== 'private' && visibility !== 'shared') {
      return res.status(400).json({ error: 'visibility must be private or shared' })
    }
    const saved = await createSavedReport({
      id: id || `sr-${Date.now()}`,
      name: String(name).trim(),
      ownerUserId,
      visibility,
      config,
    })
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/data/saved-reports/:id', async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.query.userId || '').trim()
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }
    const deleted = await deleteSavedReport(req.params.id, userId)
    if (!deleted) {
      return res.status(404).json({ error: 'Saved report not found or not owned by user' })
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/data/region-evaluations', async (req, res) => {
  try {
    const customerId = String(req.query.customerId || '').trim() || undefined
    const evaluations = await listRegionEvaluations({ customerId })
    res.json({ evaluations })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/data/region-evaluations/:id', async (req, res) => {
  try {
    const evaluation = await getRegionEvaluation(req.params.id)
    if (!evaluation) return res.status(404).json({ error: 'Region evaluation not found' })
    res.json(evaluation)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/data/region-evaluations', async (req, res) => {
  try {
    const body = req.body || {}
    if (!body.customerId || !body.customerName) {
      return res.status(400).json({ error: 'customerId and customerName are required' })
    }
    if (!Array.isArray(body.results)) {
      return res.status(400).json({ error: 'results[] is required' })
    }
    const saved = await createRegionEvaluation({
      id: body.id,
      customerId: body.customerId,
      customerName: body.customerName,
      createdByUserId: body.createdByUserId,
      createdByName: body.createdByName,
      azureSubscriptionId: body.azureSubscriptionId,
      subscriptionIds: body.subscriptionIds || [],
      subscriptionNames: body.subscriptionNames || [],
      targetRegions: body.targetRegions || [],
      summary: body.summary || {},
      results: body.results || [],
      lineItems: body.lineItems || [],
      errors: body.errors || [],
    })
    res.status(201).json(saved)
  } catch (err) {
    sendRouteError(res, 400, err, 'Failed to store region evaluation in PostgreSQL.')
  }
})

app.delete('/api/data/region-evaluations/:id', async (req, res) => {
  try {
    const deleted = await deleteRegionEvaluation(req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Region evaluation not found' })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

async function start() {
  try {
    await initDb()
    const seeded = await seedIfEmpty()
    const domainSeeded = await seedDomainIfEmpty()
    console.log(
      seeded || domainSeeded
        ? `PostgreSQL schema ready (demo seed applied${domainSeeded ? ' including constraints/rewards' : ''})`
        : 'PostgreSQL schema ready',
    )
  } catch (err) {
    console.error('Failed to initialize PostgreSQL:', err)
    process.exit(1)
  }

  const host = process.env.PCM_API_HOST || '0.0.0.0'
  app.listen(PORT, host, () => {
    console.log(`PCM Azure bridge listening on http://${host}:${PORT}`)
  })
}

start()