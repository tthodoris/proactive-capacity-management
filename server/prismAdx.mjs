/**
 * Azure Data Explorer (PRISM) client using the API container's user-assigned
 * managed identity for cross-tenant cluster access.
 *
 * Cluster example: https://azprism.westus2.kusto.windows.net
 * Database: prod
 * Table: CapacityBank
 */

import { spawn } from 'node:child_process'

const DEFAULT_CLUSTER = 'https://azprism.westus2.kusto.windows.net'
const DEFAULT_DATABASE = 'prod'
const DEFAULT_TAKE = 1000

function prismConfig() {
  const cluster = String(process.env.PRISM_ADX_CLUSTER || DEFAULT_CLUSTER)
    .trim()
    .replace(/\/$/, '')
  const database = String(process.env.PRISM_ADX_DATABASE || DEFAULT_DATABASE).trim() || 'prod'
  const clientId =
    String(process.env.PRISM_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID || '').trim() ||
    null
  return {
    cluster,
    database,
    clientId,
    resource: cluster,
  }
}

function runCommand(command, args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`))
    })
  })
}

/**
 * Acquire an ADX audience token via ACA/App Service identity endpoint, IMDS, or az CLI.
 */
export async function getPrismAccessToken() {
  const { resource, clientId } = prismConfig()

  const identityEndpoint = process.env.IDENTITY_ENDPOINT
  const identityHeader = process.env.IDENTITY_HEADER
  if (identityEndpoint) {
    const url = new URL(identityEndpoint)
    url.searchParams.set('api-version', process.env.IDENTITY_API_VERSION || '2019-08-01')
    url.searchParams.set('resource', resource)
    if (clientId) url.searchParams.set('client_id', clientId)
    const headers = {}
    if (identityHeader) headers['X-IDENTITY-HEADER'] = identityHeader
    const res = await fetch(url, { headers })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body?.access_token) {
      const detail = body?.error_description || body?.message || res.statusText
      const err = new Error(`Managed identity token failed (${res.status}): ${detail}`)
      err.status = res.status
      throw err
    }
    return {
      accessToken: String(body.access_token),
      expiresOn: body.expires_on || null,
      source: 'managed_identity',
    }
  }

  // VM / Azure Container Instance IMDS fallback
  try {
    const imds = new URL('http://169.254.169.254/metadata/identity/oauth2/token')
    imds.searchParams.set('api-version', '2018-02-01')
    imds.searchParams.set('resource', resource)
    if (clientId) imds.searchParams.set('client_id', clientId)
    const res = await fetch(imds, {
      headers: { Metadata: 'true' },
      signal: AbortSignal.timeout(2500),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && body?.access_token) {
      return {
        accessToken: String(body.access_token),
        expiresOn: body.expires_on || null,
        source: 'imds',
      }
    }
  } catch {
    // Local / non-MI environments fall through to az CLI.
  }

  const { stdout } = await runCommand('az', [
    'account',
    'get-access-token',
    '--resource',
    resource,
    '-o',
    'json',
  ])
  const parsed = JSON.parse(stdout)
  if (!parsed?.accessToken) {
    throw new Error('Azure CLI did not return a PRISM / ADX access token')
  }
  return {
    accessToken: String(parsed.accessToken),
    expiresOn: parsed.expiresOn || parsed.expires_on || null,
    source: 'azure_cli',
  }
}

function normalizeKustoPrimaryResult(payload) {
  // v1 Tables format
  if (Array.isArray(payload?.Tables) && payload.Tables.length) {
    const table =
      payload.Tables.find((t) => String(t.TableName || '').toLowerCase() === 'primaryresult') ||
      payload.Tables[0]
    const columns = (table.Columns || []).map((col) => ({
      name: col.ColumnName || col.columnName || String(col.name || 'column'),
      type: col.ColumnType || col.columnType || col.DataType || null,
    }))
    const rows = (table.Rows || []).map((row) => {
      const obj = {}
      columns.forEach((col, index) => {
        obj[col.name] = Array.isArray(row) ? row[index] : row?.[col.name]
      })
      return obj
    })
    return { columns, rows }
  }

  // v2 frames format
  if (Array.isArray(payload)) {
    const primary = payload.find(
      (frame) =>
        frame?.FrameType === 'DataSet' ||
        frame?.FrameType === 'DataTable' ||
        String(frame?.TableKind || '').toLowerCase() === 'primaryresult',
    )
    const table =
      payload.find((frame) => String(frame?.TableKind || '').toLowerCase() === 'primaryresult') ||
      primary
    if (table?.Columns && table?.Rows) {
      const columns = table.Columns.map((col) => ({
        name: col.ColumnName || col.columnName || String(col.name || 'column'),
        type: col.ColumnType || col.columnType || null,
      }))
      const rows = table.Rows.map((row) => {
        const obj = {}
        columns.forEach((col, index) => {
          obj[col.name] = Array.isArray(row) ? row[index] : row?.[col.name]
        })
        return obj
      })
      return { columns, rows }
    }
  }

  return { columns: [], rows: [] }
}

export function getPrismPublicConfig() {
  const cfg = prismConfig()
  return {
    cluster: cfg.cluster,
    database: cfg.database,
    table: 'CapacityBank',
    defaultTake: DEFAULT_TAKE,
    managedIdentityClientIdConfigured: Boolean(cfg.clientId),
    explorerUrl: `https://dataexplorer.azure.com/clusters/azprism.westus2/databases/${encodeURIComponent(cfg.database)}`,
  }
}

/**
 * Run a KQL query against the PRISM ADX cluster.
 * @param {{ csl?: string, take?: number }} [options]
 */
export async function queryPrismCapacityBank(options = {}) {
  const cfg = prismConfig()
  const take = Math.min(
    Math.max(Number(options.take) || DEFAULT_TAKE, 1),
    Number(process.env.PRISM_ADX_MAX_TAKE) || 5000,
  )
  const csl =
    String(options.csl || '').trim() ||
    `CapacityBank | take ${take}`

  const token = await getPrismAccessToken()
  const url = `${cfg.cluster}/v1/rest/query`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      db: cfg.database,
      csl,
    }),
  })

  const text = await res.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { message: text }
  }

  if (!res.ok) {
    const message =
      payload?.error?.message ||
      payload?.Message ||
      payload?.message ||
      text.slice(0, 500) ||
      `ADX query failed (${res.status})`
    const err = new Error(message)
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502
    err.hint =
      'Ensure the API container user-assigned identity is granted viewer (or higher) on the PRISM ADX cluster/database, and PRISM_MANAGED_IDENTITY_CLIENT_ID / AZURE_CLIENT_ID matches that identity.'
    throw err
  }

  const { columns, rows } = normalizeKustoPrimaryResult(payload)
  return {
    cluster: cfg.cluster,
    database: cfg.database,
    csl,
    take,
    authSource: token.source,
    retrievedAt: new Date().toISOString(),
    total: rows.length,
    columns,
    rows,
  }
}
