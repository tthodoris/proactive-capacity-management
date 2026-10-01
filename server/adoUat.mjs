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
 *  authMode: 'azure_cli' | 'pat' | 'none'
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

/** @type {import('node:child_process').ChildProcess | null} */
let adoLoginProcess = null

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

/**
 * Prefer the working az login + ADO resource bearer token flow.
 * PAT remains an optional fallback only.
 */
async function getAuthorizationHeader() {
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
    const err = new Error(
      cliErr instanceof Error
        ? cliErr.message
        : 'Azure DevOps sign-in required',
    )
    err.status = 401
    err.hint =
      `Sign in on the UATs page with tenant ${adoConfig().tenantId} (device code), matching: az login --tenant ${adoConfig().tenantId}`
    throw err
  }
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
      adoConnection.error = combined.trim() || `az login exited with code ${code}`
      adoConnection.message = 'Azure DevOps login did not complete.'
      adoConnection.authMode = 'none'
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
      response.status === 401 || response.status === 403
        ? `Sign in on the UATs page (az login --tenant ${adoConfig().tenantId}), then retry. Org: ${organizationUrl}`
        : undefined
    throw err
  }

  return summarizeWorkItem(body)
}
