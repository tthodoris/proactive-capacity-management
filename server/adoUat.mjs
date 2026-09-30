import { spawn } from 'node:child_process'

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const DEFAULT_ORG = 'unifiedactiontracker'
const DEFAULT_WORK_ITEM_ID = '780831'

function quoteWinArg(arg) {
  const s = String(arg)
  if (!/[ \t"]/u.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

function runAz(args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const finalArgs = isWin ? args.map(quoteWinArg) : args
    const child = spawn('az', finalArgs, {
      shell: isWin,
      env: process.env,
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

export function adoConfig() {
  return {
    organization: process.env.ADO_ORG || DEFAULT_ORG,
    defaultWorkItemId: Number(process.env.ADO_WORK_ITEM_ID || DEFAULT_WORK_ITEM_ID),
    hasPat: Boolean(process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT),
  }
}

async function getAuthorizationHeader() {
  const pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT
  if (pat) {
    return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
  }

  const { stdout } = await runAz([
    'account',
    'get-access-token',
    '--resource',
    ADO_RESOURCE,
    '-o',
    'json',
  ])
  const payload = JSON.parse(stdout)
  if (!payload?.accessToken) {
    throw new Error('Azure CLI did not return an Azure DevOps access token')
  }
  return `Bearer ${payload.accessToken}`
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
        display = value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ')
      } else if (typeof value === 'string' && /<\/?[a-z][\s\S]*>/i.test(value)) {
        display = stripHtml(value)
      }
      return { name, value: display == null ? '' : String(display) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    id: raw?.id ?? fields['System.Id'] ?? null,
    rev: raw?.rev ?? null,
    url: raw?.url ?? null,
    htmlUrl:
      raw?._links?.html?.href ||
      (raw?.id
        ? `https://dev.azure.com/${adoConfig().organization}/_workitems/edit/${raw.id}`
        : null),
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
  const { organization } = adoConfig()
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
        ? 'Set ADO_PAT in .env (or AZURE_DEVOPS_PAT), or open https://dev.azure.com/unifiedactiontracker once in a browser to materialize your Azure AD identity, then retry.'
        : undefined
    throw err
  }

  return summarizeWorkItem(body)
}
