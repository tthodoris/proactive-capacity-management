/**
 * Azure Data Explorer (PRISM) client using the API container's user-assigned
 * managed identity for cross-tenant cluster access.
 *
 * Cluster example: https://azprism.westus2.kusto.windows.net
 * Database: prod
 * Table: CapacityBank
 *
 * Token audience for ADX is normally the first-party app:
 *   https://kusto.kusto.windows.net
 * (not the cluster URI). Override with PRISM_ADX_TOKEN_RESOURCE if needed.
 */

import { spawn } from 'node:child_process'

const DEFAULT_CLUSTER = 'https://azprism.westus2.kusto.windows.net'
const DEFAULT_DATABASE = 'prod'
const DEFAULT_TAKE = 1000
const DEFAULT_TOKEN_RESOURCE = 'https://kusto.kusto.windows.net'

function prismConfig() {
  const cluster = String(process.env.PRISM_ADX_CLUSTER || DEFAULT_CLUSTER)
    .trim()
    .replace(/\/$/, '')
  const database = String(process.env.PRISM_ADX_DATABASE || DEFAULT_DATABASE).trim() || 'prod'
  const clientId =
    String(process.env.PRISM_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID || '').trim() ||
    null
  const tokenResource =
    String(process.env.PRISM_ADX_TOKEN_RESOURCE || DEFAULT_TOKEN_RESOURCE).trim() ||
    DEFAULT_TOKEN_RESOURCE
  return {
    cluster,
    database,
    clientId,
    tokenResource,
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

function extractAdxErrorMessage(payload, text, status) {
  if (payload && typeof payload === 'object') {
    const nested =
      payload?.error?.['@message'] ||
      payload?.error?.message ||
      payload?.error?.Message ||
      (typeof payload.error === 'string' ? payload.error : null) ||
      payload?.Message ||
      payload?.message
    if (nested) return String(nested)
  }
  if (text && String(text).trim()) return String(text).trim().slice(0, 800)
  return `ADX request failed (${status})`
}

/** Decode JWT payload claims without verifying signature (diagnostics only). */
function decodeJwtClaims(accessToken) {
  try {
    const parts = String(accessToken || '').split('.')
    if (parts.length < 2) return null
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    )
    const payload = JSON.parse(json)
    return {
      aud: payload.aud ?? null,
      appid: payload.appid || payload.azp || null,
      oid: payload.oid ?? null,
      tid: payload.tid ?? null,
      iss: payload.iss ?? null,
      idtyp: payload.idtyp ?? null,
    }
  } catch {
    return null
  }
}

function hintForAdxStatus(status, cfg, claims = null) {
  if (status === 401 || status === 403) {
    const principal =
      claims?.appid && claims?.tid
        ? ` Grant in ADX: .add database ${cfg.database} viewers ('aadapp=${claims.appid};${claims.tid}').`
        : ''
    return (
      'ADX rejected the managed-identity token. On the PRISM cluster: (1) trustedExternalTenants must ' +
      `include the identity tenant${claims?.tid ? ` (${claims.tid})` : ''} or "*"; ` +
      `(2) add the UAMI as Viewer (or higher) on database ${cfg.database}.` +
      principal
    )
  }
  if (status === 404) {
    return (
      `ADX returned Not Found for ${cfg.cluster} / database "${cfg.database}". ` +
      'Verify PRISM_ADX_CLUSTER is the Cluster URI (not the ingestion URI), PRISM_ADX_DATABASE is correct, ' +
      'and the database exists on that cluster.'
    )
  }
  return (
    'Ensure the API container user-assigned identity can reach PRISM ADX and that ' +
    'PRISM_MANAGED_IDENTITY_CLIENT_ID / AZURE_CLIENT_ID matches that identity.'
  )
}

/**
 * Acquire an ADX audience token via ACA/App Service identity endpoint, IMDS, or az CLI.
 */
export async function getPrismAccessToken() {
  const { tokenResource, clientId } = prismConfig()

  const identityEndpoint = process.env.IDENTITY_ENDPOINT
  const identityHeader = process.env.IDENTITY_HEADER
  if (identityEndpoint) {
    const url = new URL(identityEndpoint)
    url.searchParams.set('api-version', process.env.IDENTITY_API_VERSION || '2019-08-01')
    url.searchParams.set('resource', tokenResource)
    if (clientId) url.searchParams.set('client_id', clientId)
    const headers = {}
    if (identityHeader) headers['X-IDENTITY-HEADER'] = identityHeader
    const res = await fetch(url, { headers })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body?.access_token) {
      const detail = body?.error_description || body?.message || res.statusText
      const err = new Error(`Managed identity token failed (${res.status}): ${detail}`)
      err.status = res.status >= 400 && res.status < 600 ? res.status : 502
      err.hint =
        'IDENTITY_ENDPOINT responded without an access token. Confirm the container has a user-assigned identity and AZURE_CLIENT_ID is set to that identity client id.'
      throw err
    }
    const accessToken = String(body.access_token)
    return {
      accessToken,
      expiresOn: body.expires_on || null,
      source: 'managed_identity',
      tokenResource,
      claims: decodeJwtClaims(accessToken),
    }
  }

  // VM / Azure Container Instance IMDS fallback
  try {
    const imds = new URL('http://169.254.169.254/metadata/identity/oauth2/token')
    imds.searchParams.set('api-version', '2018-02-01')
    imds.searchParams.set('resource', tokenResource)
    if (clientId) imds.searchParams.set('client_id', clientId)
    const res = await fetch(imds, {
      headers: { Metadata: 'true' },
      signal: AbortSignal.timeout(2500),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && body?.access_token) {
      const accessToken = String(body.access_token)
      return {
        accessToken,
        expiresOn: body.expires_on || null,
        source: 'imds',
        tokenResource,
        claims: decodeJwtClaims(accessToken),
      }
    }
  } catch {
    // Local / non-MI environments fall through to az CLI.
  }

  const { stdout } = await runCommand('az', [
    'account',
    'get-access-token',
    '--resource',
    tokenResource,
    '-o',
    'json',
  ])
  const parsed = JSON.parse(stdout)
  if (!parsed?.accessToken) {
    throw new Error('Azure CLI did not return a PRISM / ADX access token')
  }
  const accessToken = String(parsed.accessToken)
  return {
    accessToken,
    expiresOn: parsed.expiresOn || parsed.expires_on || null,
    source: 'azure_cli',
    tokenResource,
    claims: decodeJwtClaims(accessToken),
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
    const table =
      payload.find((frame) => String(frame?.TableKind || '').toLowerCase() === 'primaryresult') ||
      payload.find((frame) => frame?.FrameType === 'DataTable')
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

async function adxPost(pathname, body) {
  const cfg = prismConfig()
  const token = await getPrismAccessToken()
  const url = `${cfg.cluster}${pathname.startsWith('/') ? '' : '/'}${pathname}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      'x-ms-client-request-id': `pcm-prism-${Date.now()}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { message: text }
  }
  return { cfg, token, url, res, text, payload }
}

function attachTokenDiagnostics(err, token, cfg) {
  const claims = token?.claims || null
  err.claims = claims
  err.hint = hintForAdxStatus(err.status, cfg, claims)
  if (claims?.appid && claims?.tid) {
    err.adxPrincipal = `aadapp=${claims.appid};${claims.tid}`
  }
  return err
}

export function getPrismPublicConfig() {
  const cfg = prismConfig()
  return {
    cluster: cfg.cluster,
    database: cfg.database,
    table: 'CapacityBank',
    defaultTake: DEFAULT_TAKE,
    tokenResource: cfg.tokenResource,
    managedIdentityClientIdConfigured: Boolean(cfg.clientId),
    managedIdentityClientId: cfg.clientId,
    managedIdentityClientIdSuffix: cfg.clientId ? cfg.clientId.slice(-8) : null,
    explorerUrl: `https://dataexplorer.azure.com/clusters/azprism.westus2/databases/${encodeURIComponent(cfg.database)}`,
    adxGrantHint: cfg.clientId
      ? `.add database ${cfg.database} viewers ('aadapp=${cfg.clientId};<identity-tenant-id>')`
      : null,
  }
}

/**
 * Lightweight connectivity check: list databases on the PRISM cluster.
 */
export async function pingPrismCluster() {
  const cfg = prismConfig()
  const { token, url, res, text, payload } = await adxPost('/v1/rest/mgmt', {
    db: cfg.database,
    csl: '.show databases',
  })
  if (!res.ok) {
    const message = extractAdxErrorMessage(payload, text, res.status)
    const err = new Error(`${message} [POST ${url}]`)
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502
    throw attachTokenDiagnostics(err, token, cfg)
  }
  const { columns, rows } = normalizeKustoPrimaryResult(payload)
  return {
    ok: true,
    cluster: cfg.cluster,
    database: cfg.database,
    authSource: token.source,
    tokenResource: token.tokenResource,
    claims: token.claims,
    databases: rows,
    columns,
    retrievedAt: new Date().toISOString(),
  }
}

/**
 * Run a KQL query against the PRISM ADX cluster.
 * @param {{ csl?: string, take?: number }} [options]
 */
export async function queryPrismCapacityBank(options = {}) {
  const take = Math.min(
    Math.max(Number(options.take) || DEFAULT_TAKE, 1),
    Number(process.env.PRISM_ADX_MAX_TAKE) || 5000,
  )
  const csl =
    String(options.csl || '').trim() ||
    `CapacityBank | take ${take}`

  const cfg = prismConfig()
  const { token, url, res, text, payload } = await adxPost('/v1/rest/query', {
    db: cfg.database,
    csl,
  })

  if (!res.ok) {
    const message = extractAdxErrorMessage(payload, text, res.status)
    const err = new Error(`${message} [POST ${url} db=${cfg.database}]`)
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502
    throw attachTokenDiagnostics(err, token, cfg)
  }

  const { columns, rows } = normalizeKustoPrimaryResult(payload)
  return {
    cluster: cfg.cluster,
    database: cfg.database,
    csl,
    take,
    authSource: token.source,
    tokenResource: token.tokenResource,
    claims: token.claims,
    retrievedAt: new Date().toISOString(),
    total: rows.length,
    columns,
    rows,
  }
}
