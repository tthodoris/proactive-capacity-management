import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const DEFAULT_ORG = 'unifiedactiontracker'
const DEFAULT_TENANT = 'microsoft.onmicrosoft.com'
const DEFAULT_WORK_ITEM_ID = '780831'

const ADO_AZURE_DIR =
  process.env.ADO_AZURE_CONFIG_DIR || join(homedir(), '.azure-ado')

try {
  mkdirSync(ADO_AZURE_DIR, { recursive: true })
} catch {
  // directory may already exist
}

/** @type {{
 *  status: 'idle' | 'awaiting_device_code' | 'authenticating' | 'connected' | 'error' | 'cancelled'
 *  tenantId: string | null
 *  organization: string
 *  organizationUrl: string
 *  deviceCode: string | null
 *  verificationUrl: string
 *  message: string | null
 *  error: string | null
 *  account: object | null
 *  startedAt: string | null
 *  connectedAt: string | null
 *  loginPid: number | null
 *  authMode: 'azure_cli' | 'pasted_token' | 'pat' | 'none'
 * }} */
const adoConnection = {
  status: 'idle',
  tenantId: null,
  organization: DEFAULT_ORG,
  organizationUrl: `https://dev.azure.com/${DEFAULT_ORG}`,
  deviceCode: null,
  verificationUrl: 'https://microsoft.com/devicelogin',
  message: null,
  error: null,
  account: null,
  startedAt: null,
  connectedAt: null,
  loginPid: null,
  authMode: 'none',
}

/** @type {{ accessToken: string, expiresAt: number | null } | null} */
let pastedAdoToken = null

/** @type {import('node:child_process').ChildProcess | null} */
let adoLoginProcess = null

const CA_DEVICE_CODE_HINT =
  'Error 53003: Microsoft Conditional Access blocks device-code login for this tenant. ' +
  'On Windows, run az login --tenant microsoft.onmicrosoft.com (no --use-device-code), then: ' +
  'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv ' +
  'and paste the token on the UATs page.'

function isConditionalAccessDeviceCodeError(text) {
  const value = String(text || '')
  return (
    /AADSTS53003/i.test(value) ||
    /Error Code:\s*53003/i.test(value) ||
    /53003/i.test(value) ||
    /Block Device Code Flow/i.test(value) ||
    /authentication flow checks by Conditional Access/i.test(value)
  )
}

function quoteWinArg(arg) {
  const s = String(arg)
  if (!/[ \t"]/u.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

function adoEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    AZURE_CONFIG_DIR: ADO_AZURE_DIR,
  }
}

function runAzAdo(args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const finalArgs = isWin ? args.map(quoteWinArg) : args
    const child = spawn('az', finalArgs, {
      shell: isWin,
      env: adoEnv(),
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`az timed out after ${timeoutMs}ms`))
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
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || stdout.trim() || `az exited with code ${code}`))
    })
  })
}

function parseDeviceCode(text) {
  const codeMatch =
    text.match(/enter the code\s+([A-Z0-9]{8,})\s+to authenticate/i) ||
    text.match(/code\s+([A-Z0-9]{8,})/i)
  const urlMatch = text.match(/https:\/\/microsoft\.com\/devicelogin/i)
  return {
    deviceCode: codeMatch?.[1] ?? null,
    verificationUrl: urlMatch ? 'https://microsoft.com/devicelogin' : adoConnection.verificationUrl,
  }
}

export function adoConfig() {
  const organization = process.env.ADO_ORG || DEFAULT_ORG
  return {
    organization,
    organizationUrl: `https://dev.azure.com/${organization}`,
    tenantId: process.env.ADO_TENANT || DEFAULT_TENANT,
    defaultWorkItemId: Number(process.env.ADO_WORK_ITEM_ID || DEFAULT_WORK_ITEM_ID),
    hasPat: Boolean(process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT),
    azureConfigDir: ADO_AZURE_DIR,
  }
}

export function publicAdoConnection() {
  const config = adoConfig()
  return {
    status: adoConnection.status,
    tenantId: adoConnection.tenantId || config.tenantId,
    organization: config.organization,
    organizationUrl: config.organizationUrl,
    deviceCode: adoConnection.deviceCode,
    verificationUrl: adoConnection.verificationUrl,
    message: adoConnection.message,
    error: adoConnection.error,
    account: adoConnection.account,
    startedAt: adoConnection.startedAt,
    connectedAt: adoConnection.connectedAt,
    authMode: adoConnection.authMode,
    hasPat: config.hasPat,
  }
}

async function getAdoAccount() {
  const { stdout } = await runAzAdo(['account', 'show', '-o', 'json'], 30_000)
  return JSON.parse(stdout)
}

async function configureAdoDefaults() {
  const { organizationUrl } = adoConfig()
  try {
    await runAzAdo(
      ['extension', 'add', '--name', 'azure-devops', '--yes'],
      120_000,
    )
  } catch {
    // extension may already be installed
  }
  try {
    await runAzAdo(
      ['devops', 'configure', '--defaults', `organization=${organizationUrl}`],
      30_000,
    )
  } catch (err) {
    // REST calls only need the bearer token; defaults are convenience.
    console.warn(
      '[ado] az devops configure skipped:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

async function getAdoBearerToken() {
  const { tenantId } = adoConfig()
  const { stdout } = await runAzAdo(
    [
      'account',
      'get-access-token',
      '--resource',
      ADO_RESOURCE,
      '--tenant',
      tenantId,
      '-o',
      'json',
    ],
    45_000,
  )
  const payload = JSON.parse(stdout)
  if (!payload?.accessToken) {
    throw new Error('Azure CLI did not return an Azure DevOps access token')
  }
  return {
    authorization: `Bearer ${payload.accessToken}`,
    expiresOn: payload.expiresOn || payload.expires_on || null,
  }
}

async function refreshAdoSessionStatus() {
  const config = adoConfig()
  try {
    const account = await getAdoAccount()
    await getAdoBearerToken()
    adoConnection.status = 'connected'
    adoConnection.account = account
    adoConnection.tenantId = account.tenantId || config.tenantId
    adoConnection.connectedAt = adoConnection.connectedAt || new Date().toISOString()
    adoConnection.authMode = 'azure_cli'
    adoConnection.error = null
    adoConnection.message =
      adoConnection.message ||
      `Signed in to ${config.organizationUrl} as ${account?.user?.name || account?.name || 'current user'}`
    return publicAdoConnection()
  } catch {
    if (adoConnection.status === 'connected') {
      adoConnection.status = 'idle'
      adoConnection.account = null
      adoConnection.connectedAt = null
      adoConnection.authMode = config.hasPat ? 'pat' : 'none'
      adoConnection.message = config.hasPat
        ? 'No Azure CLI session; ADO_PAT is configured as fallback.'
        : 'Not signed in to Azure DevOps.'
    } else if (adoConnection.status === 'idle' || adoConnection.status === 'error') {
      adoConnection.authMode = config.hasPat ? 'pat' : 'none'
    }
    return publicAdoConnection()
  }
}

function getPastedAuthorization() {
  if (!pastedAdoToken?.accessToken) return null
  if (pastedAdoToken.expiresAt && Date.now() >= pastedAdoToken.expiresAt) {
    pastedAdoToken = null
    if (adoConnection.authMode === 'pasted_token') {
      adoConnection.status = 'idle'
      adoConnection.authMode = 'none'
      adoConnection.message = 'Pasted Azure DevOps token expired. Paste a new access token.'
      adoConnection.connectedAt = null
    }
    return null
  }
  return `Bearer ${pastedAdoToken.accessToken}`
}

/**
 * Prefer pasted Windows WAM token (works under CA), then az CLI profile, then PAT.
 */
async function getAuthorizationHeader() {
  const pasted = getPastedAuthorization()
  if (pasted) {
    adoConnection.authMode = 'pasted_token'
    return pasted
  }

  try {
    const token = await getAdoBearerToken()
    adoConnection.authMode = 'azure_cli'
    return token.authorization
  } catch (cliErr) {
    const pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT
    if (pat) {
      adoConnection.authMode = 'pat'
      return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
    }
    const detail = cliErr instanceof Error ? cliErr.message : String(cliErr)
    const err = new Error(
      isConditionalAccessDeviceCodeError(detail) ? CA_DEVICE_CODE_HINT : detail || 'Azure DevOps sign-in required',
    )
    err.status = 401
    err.hint = CA_DEVICE_CODE_HINT
    throw err
  }
}

async function validateAdoBearerToken(accessToken) {
  const { organization } = adoConfig()
  const url = `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/connectionData?api-version=7.1-preview.1`
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const message =
      body?.message ||
      body?.value?.Message ||
      `Azure DevOps rejected the access token (${response.status})`
    const err = new Error(message)
    err.status = response.status
    throw err
  }
  return body
}

export async function setAdoAccessToken(accessToken, expiresOn) {
  const token = String(accessToken || '').trim()
  if (!token) {
    const err = new Error('accessToken is required')
    err.status = 400
    throw err
  }

  const connectionData = await validateAdoBearerToken(token)
  let expiresAt = null
  if (expiresOn) {
    const parsed = Date.parse(String(expiresOn))
    if (Number.isFinite(parsed)) expiresAt = parsed
  }
  // Default: treat as ~55 minutes if expiry unknown (ADO AAD tokens are usually ~1h).
  if (!expiresAt) expiresAt = Date.now() + 55 * 60 * 1000

  pastedAdoToken = { accessToken: token, expiresAt }
  const authenticated =
    connectionData?.authenticatedUser?.providerDisplayName ||
    connectionData?.authenticatedUser?.customDisplayName ||
    connectionData?.authorizedUser?.providerDisplayName ||
    null

  adoConnection.status = 'connected'
  adoConnection.authMode = 'pasted_token'
  adoConnection.tenantId = adoConfig().tenantId
  adoConnection.deviceCode = null
  adoConnection.error = null
  adoConnection.connectedAt = new Date().toISOString()
  adoConnection.startedAt = adoConnection.startedAt || adoConnection.connectedAt
  adoConnection.account = {
    name: authenticated || 'Pasted access token',
    tenantId: adoConfig().tenantId,
    user: { name: authenticated || 'Pasted access token' },
  }
  adoConnection.message =
    `Using pasted Azure DevOps bearer token` +
    (authenticated ? ` as ${authenticated}` : '') +
    `. Token expires around ${new Date(expiresAt).toISOString()}.`
  return publicAdoConnection()
}

export async function startAdoLogin() {
  const config = adoConfig()
  if (adoLoginProcess && !adoLoginProcess.killed) {
    const err = new Error('An Azure DevOps login is already in progress')
    err.status = 409
    err.connection = publicAdoConnection()
    throw err
  }

  try {
    await runAzAdo(['logout', '--tenant', config.tenantId], 30_000)
  } catch {
    try {
      await runAzAdo(['logout'], 30_000)
    } catch {
      // ignore
    }
  }

  adoConnection.status = 'awaiting_device_code'
  adoConnection.tenantId = config.tenantId
  adoConnection.organization = config.organization
  adoConnection.organizationUrl = config.organizationUrl
  adoConnection.deviceCode = null
  adoConnection.verificationUrl = 'https://microsoft.com/devicelogin'
  adoConnection.error = null
  adoConnection.account = null
  adoConnection.startedAt = new Date().toISOString()
  adoConnection.connectedAt = null
  adoConnection.authMode = 'none'
  adoConnection.message = `Starting az login --tenant ${config.tenantId} --use-device-code`

  const loginArgs = [
    'login',
    '--tenant',
    config.tenantId,
    '--use-device-code',
    '--allow-no-subscriptions',
    '-o',
    'json',
  ]

  adoLoginProcess = spawn('az', loginArgs, {
    shell: true,
    windowsHide: false,
    env: adoEnv(),
  })
  adoConnection.loginPid = adoLoginProcess.pid ?? null

  let combined = ''

  const onChunk = (chunk) => {
    const text = chunk.toString()
    combined += text
    const parsed = parseDeviceCode(combined)
    if (parsed.deviceCode) {
      adoConnection.deviceCode = parsed.deviceCode
      adoConnection.verificationUrl = parsed.verificationUrl
      adoConnection.status = 'authenticating'
      adoConnection.message =
        'Open microsoft.com/devicelogin, enter the device code, then return here while Azure CLI finishes.'
    }

    const trimmed = combined.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsedJson = JSON.parse(trimmed)
        const account = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson
        if (account?.tenantId || account?.id) {
          adoConnection.account = account
          adoConnection.status = 'connected'
          adoConnection.connectedAt = new Date().toISOString()
          adoConnection.message = 'Microsoft tenant login established. Configuring Azure DevOps defaults…'
          adoConnection.deviceCode = null
          adoConnection.authMode = 'azure_cli'
        }
      } catch {
        // still streaming JSON
      }
    }
  }

  adoLoginProcess.stdout?.on('data', onChunk)
  adoLoginProcess.stderr?.on('data', onChunk)

  adoLoginProcess.on('error', (err) => {
    adoConnection.status = 'error'
    adoConnection.error = err.message
    adoConnection.message = 'Failed to start Azure CLI login for Azure DevOps.'
    adoLoginProcess = null
    adoConnection.loginPid = null
  })

  adoLoginProcess.on('close', async (code) => {
    adoLoginProcess = null
    adoConnection.loginPid = null
    if (code === 0) {
      try {
        const account = await getAdoAccount()
        await configureAdoDefaults()
        await getAdoBearerToken()
        adoConnection.account = account
        adoConnection.tenantId = account.tenantId || config.tenantId
        adoConnection.status = 'connected'
        adoConnection.connectedAt = new Date().toISOString()
        adoConnection.deviceCode = null
        adoConnection.error = null
        adoConnection.authMode = 'azure_cli'
        adoConnection.message = `Signed in to ${config.organizationUrl} as ${account?.user?.name || account?.name || 'current user'}`
      } catch (err) {
        adoConnection.status = 'error'
        adoConnection.error = err instanceof Error ? err.message : String(err)
        adoConnection.message =
          'Login finished but Azure DevOps token could not be obtained. Retry Sign in.'
        adoConnection.authMode = 'none'
      }
    } else if (adoConnection.status !== 'connected') {
      adoConnection.status = 'error'
      const detail = combined.trim() || `az login exited with code ${code}`
      adoConnection.error = detail
      adoConnection.authMode = 'none'
      adoConnection.message = isConditionalAccessDeviceCodeError(detail)
        ? CA_DEVICE_CODE_HINT
        : 'Azure DevOps login did not complete.'
    }
  })

  return publicAdoConnection()
}

export function cancelAdoLogin() {
  if (adoLoginProcess && !adoLoginProcess.killed) {
    adoLoginProcess.kill()
    adoLoginProcess = null
  }
  adoConnection.status = 'cancelled'
  adoConnection.message = 'Azure DevOps login cancelled.'
  adoConnection.deviceCode = null
  adoConnection.loginPid = null
  adoConnection.authMode = adoConfig().hasPat ? 'pat' : 'none'
  return publicAdoConnection()
}

export async function disconnectAdoLogin() {
  if (adoLoginProcess && !adoLoginProcess.killed) {
    adoLoginProcess.kill()
    adoLoginProcess = null
  }
  pastedAdoToken = null
  const config = adoConfig()
  try {
    await runAzAdo(['logout', '--tenant', config.tenantId], 30_000)
  } catch {
    try {
      await runAzAdo(['logout'], 30_000)
    } catch {
      // ignore
    }
  }
  adoConnection.status = 'idle'
  adoConnection.tenantId = config.tenantId
  adoConnection.deviceCode = null
  adoConnection.account = null
  adoConnection.connectedAt = null
  adoConnection.startedAt = null
  adoConnection.loginPid = null
  adoConnection.error = null
  adoConnection.authMode = config.hasPat ? 'pat' : 'none'
  adoConnection.message = 'Signed out of Azure DevOps.'
  return publicAdoConnection()
}

export async function getAdoStatus() {
  if (
    adoConnection.status === 'awaiting_device_code' ||
    adoConnection.status === 'authenticating'
  ) {
    return publicAdoConnection()
  }
  if (getPastedAuthorization()) {
    adoConnection.status = 'connected'
    adoConnection.authMode = 'pasted_token'
    return publicAdoConnection()
  }
  return refreshAdoSessionStatus()
}

function normalizeIdentity(value) {
  if (!value) return null
  if (typeof value === 'string') return { displayName: value, uniqueName: null }
  if (typeof value === 'object') {
    return {
      displayName: value.displayName || value.name || null,
      uniqueName: value.uniqueName || value.mailAddress || null,
      imageUrl: value.imageUrl || null,
    }
  }
  return null
}

function stripHtml(value) {
  if (value == null) return null
  const text = String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return text || null
}

export function summarizeWorkItem(raw) {
  const fields = raw?.fields && typeof raw.fields === 'object' ? raw.fields : {}
  const assigned = normalizeIdentity(fields['System.AssignedTo'])
  const createdBy = normalizeIdentity(fields['System.CreatedBy'])
  const changedBy = normalizeIdentity(fields['System.ChangedBy'])

  const priorityFields = [
    'System.Id',
    'System.WorkItemType',
    'System.Title',
    'System.State',
    'System.Reason',
    'System.AssignedTo',
    'System.AreaPath',
    'System.IterationPath',
    'System.TeamProject',
    'System.CreatedDate',
    'System.ChangedDate',
    'System.Tags',
    'Microsoft.VSTS.Common.Priority',
    'Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Scheduling.StoryPoints',
  ]

  const fieldRows = Object.entries(fields)
    .map(([name, value]) => {
      let display = value
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        display = value.displayName || value.uniqueName || JSON.stringify(value)
      } else if (Array.isArray(value)) {
        display = value
          .map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
          .join(', ')
      } else if (typeof value === 'string' && /<\/?[a-z][\s\S]*>/i.test(value)) {
        display = stripHtml(value)
      }
      return { name, value: display == null ? '' : String(display) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const config = adoConfig()
  return {
    id: raw?.id ?? fields['System.Id'] ?? null,
    rev: raw?.rev ?? null,
    url: raw?.url ?? null,
    htmlUrl:
      raw?._links?.html?.href ||
      (raw?.id ? `${config.organizationUrl}/_workitems/edit/${raw.id}` : null),
    workItemType: fields['System.WorkItemType'] ?? null,
    title: fields['System.Title'] ?? null,
    state: fields['System.State'] ?? null,
    reason: fields['System.Reason'] ?? null,
    assignedTo: assigned,
    createdBy,
    changedBy,
    areaPath: fields['System.AreaPath'] ?? null,
    iterationPath: fields['System.IterationPath'] ?? null,
    teamProject: fields['System.TeamProject'] ?? null,
    createdDate: fields['System.CreatedDate'] ?? null,
    changedDate: fields['System.ChangedDate'] ?? null,
    tags: fields['System.Tags'] ?? null,
    priority: fields['Microsoft.VSTS.Common.Priority'] ?? null,
    severity: fields['Microsoft.VSTS.Common.Severity'] ?? null,
    description: stripHtml(fields['System.Description']),
    reproSteps: stripHtml(fields['Microsoft.VSTS.TCM.ReproSteps']),
    acceptanceCriteria: stripHtml(fields['Microsoft.VSTS.Common.AcceptanceCriteria']),
    priorityFieldNames: priorityFields.filter((name) => name in fields),
    fields: fieldRows,
    relations: Array.isArray(raw?.relations) ? raw.relations : [],
    raw,
  }
}

export async function fetchAdoWorkItem(workItemId) {
  const { organization, organizationUrl } = adoConfig()
  const id = Number(workItemId)
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error('Work item id must be a positive number')
    err.status = 400
    throw err
  }

  const authorization = await getAuthorizationHeader()
  const url = new URL(
    `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/wit/workitems/${id}`,
  )
  url.searchParams.set('$expand', 'all')
  url.searchParams.set('api-version', '7.1')

  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
    },
  })

  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { message: text }
  }

  if (!response.ok) {
    const message =
      body?.message ||
      body?.value?.Message ||
      body?.error ||
      `Azure DevOps request failed (${response.status})`
    const err = new Error(message)
    err.status = response.status
    err.hint =
      response.status === 401 || response.status === 403 ? CA_DEVICE_CODE_HINT : undefined
    throw err
  }

  return summarizeWorkItem(body)
}

function fieldDisplayValue(value) {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => fieldDisplayValue(item))
      .filter(Boolean)
      .join(', ')
  }
  if (typeof value === 'object') {
    return String(value.displayName || value.uniqueName || value.name || JSON.stringify(value))
  }
  return String(value)
}

function escapeWiqlString(value) {
  return String(value).replace(/'/g, "''")
}

function matchesNeedle(haystack, needle) {
  if (!needle) return true
  return String(haystack || '')
    .toLowerCase()
    .includes(String(needle).toLowerCase())
}

const DEFAULT_EXCLUDED_AREA_FIELDS = [
  'United States',
  'Japan',
  'Korea',
  'Latam',
  'India',
  'MEA',
  'Canada',
  'Germany & Austria',
  'Greater China',
  'ASEAN',
  'UK & Ireland',
  'France',
  'ANZ',
]

const DEFAULT_EXCLUDED_PREFERRED_REGIONS = [
  'Australia East',
  'Israel Central',
  'Qatar Central',
  'UAE North',
  'US West',
  'US East',
  'US West 2',
  'US East 2',
  'US Sec Central',
  'Canada Central',
]

function excludedAreaFields() {
  const raw = process.env.ADO_EXCLUDED_AREA_FIELDS
  if (!raw) return DEFAULT_EXCLUDED_AREA_FIELDS
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function excludedPreferredRegions() {
  const raw = process.env.ADO_EXCLUDED_PREFERRED_REGIONS
  if (!raw) return DEFAULT_EXCLUDED_PREFERRED_REGIONS
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function normalizeAreaToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function isExcludedAreaField(areaField) {
  const text = String(areaField || '').trim()
  if (!text) return false
  const normalized = normalizeAreaToken(text)
  const segments = normalized.split(/[\\/>|]+/).map((part) => part.trim()).filter(Boolean)
  return excludedAreaFields().some((excluded) => {
    const needle = normalizeAreaToken(excluded)
    return normalized === needle || segments.includes(needle)
  })
}

function preferredRegionTokens(value) {
  return String(value || '')
    .split(/[;,\n|/]+/)
    .map((part) => normalizeAreaToken(part))
    .filter(Boolean)
}

function isExcludedPreferredRegion(azurePreferredRegion) {
  const tokens = preferredRegionTokens(azurePreferredRegion)
  if (!tokens.length) return false
  const excluded = excludedPreferredRegions().map(normalizeAreaToken)
  return tokens.some((token) =>
    excluded.some((needle) => token === needle || token.includes(needle) || needle.includes(token)),
  )
}

/** @type {null | Record<string, any>} */
let cachedFieldMap = null

const LIST_FIELD_DEFS = [
  {
    key: 'milestoneReason',
    candidates: ['MilestoneReason', 'Milestone Reason', 'Custom.MilestoneReason'],
    env: 'ADO_FIELD_MILESTONE_REASON',
    fallback: 'Custom.MilestoneReason',
  },
  {
    key: 'account',
    candidates: ['Account', 'Customer Account', 'Custom.Account'],
    env: 'ADO_FIELD_ACCOUNT',
    fallback: 'Custom.Account',
  },
  {
    key: 'eou',
    candidates: ['EOU', 'Eou', 'End of Use', 'Custom.EOU'],
    env: 'ADO_FIELD_EOU',
    fallback: 'Custom.EOU',
  },
  {
    key: 'areaField',
    candidates: ['AreaField', 'Area Field', 'Custom.AreaField'],
    env: 'ADO_FIELD_AREA',
    fallback: 'Custom.AreaField',
  },
  {
    key: 'requestors',
    candidates: ['Requestors', 'Requestor', 'Requested By', 'Custom.Requestors'],
    env: 'ADO_FIELD_REQUESTORS',
    fallback: 'Custom.Requestors',
  },
  {
    key: 'tpid',
    candidates: ['TPID', 'TP Id', 'Custom.TPID'],
    env: 'ADO_FIELD_TPID',
    fallback: 'Custom.TPID',
  },
  {
    key: 'noNaiSku1',
    candidates: ['NoNAI_SKU_1', 'NoNAI SKU 1', 'Custom.NoNAI_SKU_1'],
    env: 'ADO_FIELD_NONAI_SKU_1',
    fallback: 'Custom.NoNAI_SKU_1',
  },
  {
    key: 'noNaiUom1',
    candidates: ['NoNAI_UOM_1', 'NoNAI UOM 1', 'Custom.NoNAI_UOM_1'],
    env: 'ADO_FIELD_NONAI_UOM_1',
    fallback: 'Custom.NoNAI_UOM_1',
  },
  {
    key: 'noNaiQuantity1',
    candidates: ['NoNAI_Quantity_1', 'NoNAI Quantity 1', 'Custom.NoNAI_Quantity_1'],
    env: 'ADO_FIELD_NONAI_QUANTITY_1',
    fallback: 'Custom.NoNAI_Quantity_1',
  },
  {
    key: 'estMonthlyUsages',
    candidates: [
      'Est Monthly Usages',
      'EstMonthlyUsages',
      'Estimated Monthly Usages',
      'Custom.EstMonthlyUsages',
      'Custom.Est_Monthly_Usages',
    ],
    env: 'ADO_FIELD_EST_MONTHLY_USAGES',
    fallback: 'Custom.EstMonthlyUsages',
  },
  {
    key: 'requestedDate',
    candidates: ['Requested Date', 'RequestedDate', 'Request Date', 'Custom.RequestedDate'],
    env: 'ADO_FIELD_REQUESTED_DATE',
    fallback: 'Custom.RequestedDate',
  },
  {
    key: 'opportunityId',
    candidates: ['Opportunity_ID', 'Opportunity ID', 'OpportunityId', 'Custom.Opportunity_ID'],
    env: 'ADO_FIELD_OPPORTUNITY_ID',
    fallback: 'Custom.Opportunity_ID',
  },
  {
    key: 'milestoneId',
    candidates: ['Milestone ID', 'MilestoneID', 'Milestone Id', 'Custom.MilestoneID', 'Custom.Milestone_ID'],
    env: 'ADO_FIELD_MILESTONE_ID',
    fallback: 'Custom.MilestoneID',
  },
  {
    key: 'azurePreferredRegion',
    candidates: [
      'AzurePreferredRegion',
      'Azure Preferred Region',
      'Custom.AzurePreferredRegion',
    ],
    env: 'ADO_FIELD_AZURE_PREFERRED_REGION',
    fallback: 'Custom.AzurePreferredRegion',
  },
  {
    key: 'azureCapacityTypeMultiline',
    candidates: [
      'AzureCapacityTypeMultiline',
      'Azure Capacity Type Multiline',
      'Azure Capacity Type',
      'Custom.AzureCapacityTypeMultiline',
    ],
    env: 'ADO_FIELD_AZURE_CAPACITY_TYPE',
    fallback: 'Custom.AzureCapacityTypeMultiline',
  },
  {
    key: 'primaryCompetitor',
    candidates: ['PrimaryCompetitor', 'Primary Competitor', 'Custom.PrimaryCompetitor'],
    env: 'ADO_FIELD_PRIMARY_COMPETITOR',
    fallback: 'Custom.PrimaryCompetitor',
  },
  {
    key: 'actionPriority',
    candidates: [
      'ActionPriorityField',
      'Action Priority Field',
      'Action Priority',
      'ActionPriority',
      'Custom.ActionPriorityField',
      'Custom.ActionPriority',
    ],
    env: 'ADO_FIELD_ACTION_PRIORITY',
    fallback: 'Custom.ActionPriorityField',
  },
  {
    key: 'noNaiRegional',
    candidates: ['NoNAI_Regional', 'NoNAI Regional', 'NoNAIRegional', 'Custom.NoNAI_Regional'],
    env: 'ADO_FIELD_NONAI_REGIONAL',
    fallback: 'Custom.NoNAI_Regional',
  },
]

const LIST_ITEM_KEYS = [
  'account',
  'eou',
  'areaField',
  'milestoneReason',
  'requestors',
  'tpid',
  'noNaiSku1',
  'noNaiUom1',
  'noNaiQuantity1',
  'estMonthlyUsages',
  'requestedDate',
  'opportunityId',
  'milestoneId',
  'azurePreferredRegion',
  'azureCapacityTypeMultiline',
  'primaryCompetitor',
  'actionPriority',
  'noNaiRegional',
]

async function adoApi(pathname, { method = 'GET', body, query } = {}) {
  const { organization } = adoConfig()
  const authorization = await getAuthorizationHeader()
  const url = new URL(
    `https://dev.azure.com/${encodeURIComponent(organization)}${pathname.startsWith('/') ? '' : '/'}${pathname}`,
  )
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  if (!url.searchParams.has('api-version')) {
    url.searchParams.set('api-version', '7.1')
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { message: text }
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.value?.Message ||
      payload?.error ||
      `Azure DevOps request failed (${response.status})`
    const err = new Error(message)
    err.status = response.status
    err.hint =
      response.status === 401 || response.status === 403 ? CA_DEVICE_CODE_HINT : undefined
    throw err
  }

  return payload
}

function normalizeFieldToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function candidateReferenceNames(candidate) {
  const raw = String(candidate || '').trim()
  if (!raw) return []
  const names = new Set([raw])
  if (!raw.includes('.')) {
    const compact = raw.replace(/[^a-zA-Z0-9_]/g, '')
    const underscored = raw.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (compact) names.add(`Custom.${compact}`)
    if (underscored) names.add(`Custom.${underscored}`)
  }
  return [...names]
}

/**
 * Resolve a field reference name from the org catalog.
 * Exact referenceName / exact friendly name only — no fuzzy includes() matching
 * (that was binding Action Priority to Custom.ActionPriority instead of
 * Custom.ActionPriorityField and leaving columns empty).
 */
function pickFieldRef(fields, candidates, envValue) {
  const byRef = new Map(
    fields.map((field) => [String(field.referenceName || '').toLowerCase(), field.referenceName]),
  )
  const byName = new Map(
    fields.map((field) => [normalizeFieldToken(field.name), field.referenceName]),
  )
  const byRefToken = new Map(
    fields.map((field) => [normalizeFieldToken(field.referenceName), field.referenceName]),
  )

  const tryOne = (candidate) => {
    if (!candidate) return null
    const direct = byRef.get(String(candidate).toLowerCase())
    if (direct) return direct
    for (const ref of candidateReferenceNames(candidate)) {
      const hit = byRef.get(ref.toLowerCase())
      if (hit) return hit
    }
    const token = normalizeFieldToken(candidate)
    if (!token) return null
    return byName.get(token) || byRefToken.get(token) || null
  }

  if (envValue) {
    const forced = tryOne(envValue)
    if (forced) return forced
  }

  for (const candidate of candidates || []) {
    const hit = tryOne(candidate)
    if (hit) return hit
  }
  return null
}

function readRawFieldValue(fields, referenceName, candidates = []) {
  if (!fields || typeof fields !== 'object') return undefined
  if (referenceName && Object.prototype.hasOwnProperty.call(fields, referenceName)) {
    return fields[referenceName]
  }
  const keys = Object.keys(fields)
  const wanted = []
  if (referenceName) wanted.push(referenceName)
  for (const candidate of candidates) {
    wanted.push(candidate, ...candidateReferenceNames(candidate))
  }
  for (const want of wanted) {
    const wantLower = String(want).toLowerCase()
    const wantToken = normalizeFieldToken(want)
    const hit = keys.find(
      (key) => key.toLowerCase() === wantLower || normalizeFieldToken(key) === wantToken,
    )
    if (hit) return fields[hit]
  }
  return undefined
}

export async function resolveAdoFieldMap(force = false) {
  if (cachedFieldMap && !force) return cachedFieldMap
  const payload = await adoApi('/_apis/wit/fields', { query: { 'api-version': '7.1' } })
  const fields = Array.isArray(payload?.value) ? payload.value : []
  /** @type {Record<string, any>} */
  const map = {
    state: 'System.State',
    id: 'System.Id',
    title: 'System.Title',
    changedDate: 'System.ChangedDate',
    all: fields.map((field) => ({
      referenceName: field.referenceName,
      name: field.name,
    })),
  }
  for (const def of LIST_FIELD_DEFS) {
    map[def.key] =
      pickFieldRef(fields, def.candidates, process.env[def.env]) ||
      pickFieldRef(fields, [def.fallback], null) ||
      def.fallback
  }
  cachedFieldMap = map
  return map
}

function summarizeListItem(raw, fieldMap) {
  const fields = raw?.fields && typeof raw.fields === 'object' ? raw.fields : {}
  const config = adoConfig()
  /** @type {Record<string, any>} */
  const item = {
    id: raw?.id ?? fields[fieldMap.id] ?? null,
    title: fieldDisplayValue(fields[fieldMap.title]) || null,
    state: fieldDisplayValue(fields[fieldMap.state]) || null,
    changedDate: fields[fieldMap.changedDate] || null,
    workItemType: fields['System.WorkItemType'] || null,
    htmlUrl:
      raw?._links?.html?.href ||
      (raw?.id ? `${config.organizationUrl}/_workitems/edit/${raw.id}` : null),
  }
  for (const def of LIST_FIELD_DEFS) {
    const rawValue = readRawFieldValue(fields, fieldMap[def.key], def.candidates)
    item[def.key] = fieldDisplayValue(rawValue) || null
  }
  return item
}

async function fetchWorkItemsByIds(ids, fieldMap) {
  if (!ids.length) return []
  const chunks = []
  for (let i = 0; i < ids.length; i += 200) {
    chunks.push(ids.slice(i, i + 200))
  }
  const items = []
  for (const chunk of chunks) {
    // Omit `fields=` so ADO returns the full field bag. Selecting a wrong/empty
    // Custom.* ref (e.g. Custom.ActionPriority vs Custom.ActionPriorityField)
    // previously left the new columns blank even though the real values existed.
    const payload = await adoApi('/_apis/wit/workitems', {
      query: {
        ids: chunk.join(','),
        errorPolicy: 'omit',
        'api-version': '7.1',
      },
    })
    for (const raw of payload?.value || []) {
      items.push(summarizeListItem(raw, fieldMap))
    }
  }
  return items
}

/**
 * List UATs with MilestoneReason = Capacity/Service Availability.
 * Optional filters: state/status, account, id, eou, areaField.
 */
export async function listCapacityWorkItems(filters = {}) {
  const fieldMap = await resolveAdoFieldMap()
  const milestoneValue =
    process.env.ADO_MILESTONE_REASON_VALUE || 'Capacity/Service Availability'
  const top = Math.min(Number(filters.top) || Number(process.env.ADO_WIQL_TOP) || 1000, 20000)

  const clauses = [
    `[${fieldMap.milestoneReason}] = '${escapeWiqlString(milestoneValue)}'`,
  ]

  const state = String(filters.state || filters.status || '').trim()
  const account = String(filters.account || '').trim()
  const id = String(filters.id || '').trim()
  const eou = String(filters.eou || '').trim()
  const areaField = String(filters.areaField || '').trim()

  const wiql = `
    SELECT [${fieldMap.id}], [${fieldMap.title}], [${fieldMap.state}]
    FROM WorkItems
    WHERE ${clauses.join(' AND ')}
    ORDER BY [${fieldMap.changedDate}] DESC
  `.replace(/\s+/g, ' ').trim()

  const queryResult = await adoApi('/_apis/wit/wiql', {
    method: 'POST',
    query: { $top: String(top), 'api-version': '7.1' },
    body: { query: wiql },
  })

  const ids = (queryResult?.workItems || [])
    .map((item) => Number(item.id))
    .filter((value) => Number.isFinite(value) && value > 0)

  const allItems = (await fetchWorkItemsByIds(ids, fieldMap)).filter(
    (item) =>
      !isExcludedAreaField(item.areaField) &&
      !isExcludedPreferredRegion(item.azurePreferredRegion),
  )

  const uniqueValues = (rows, key) =>
    [...new Set(rows.map((item) => item[key]).filter((value) => value != null && value !== ''))].sort(
      (a, b) => String(a).localeCompare(String(b)),
    )

  const facets = {
    state: uniqueValues(allItems, 'state'),
    account: uniqueValues(allItems, 'account'),
    eou: uniqueValues(allItems, 'eou'),
    areaField: uniqueValues(allItems, 'areaField'),
    azurePreferredRegion: uniqueValues(allItems, 'azurePreferredRegion'),
  }

  let items = allItems
  if (state) items = items.filter((item) => matchesNeedle(item.state, state))
  if (id) items = items.filter((item) => matchesNeedle(item.id, id))
  if (account) items = items.filter((item) => matchesNeedle(item.account, account))
  if (eou) items = items.filter((item) => matchesNeedle(item.eou, eou))
  if (areaField) items = items.filter((item) => matchesNeedle(item.areaField, areaField))

  return {
    milestoneReason: milestoneValue,
    excludedAreaFields: excludedAreaFields(),
    excludedPreferredRegions: excludedPreferredRegions(),
    fieldMap: Object.fromEntries(
      ['id', 'title', 'state', 'changedDate', ...LIST_ITEM_KEYS].map((key) => [key, fieldMap[key]]),
    ),
    total: items.length,
    queried: ids.length,
    included: allItems.length,
    filters: { state, account, id, eou, areaField },
    facets,
    items,
  }
}

