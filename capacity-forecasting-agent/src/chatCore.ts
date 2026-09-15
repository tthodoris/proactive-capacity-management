import { approveAll, CopilotClient, type CopilotSession } from '@github/copilot-sdk'
import { loadCapacityStore } from './data/loadDatasources.js'
import { createCapacityTools } from './tools/capacityTools.js'

export const CAPACITY_AGENT_PERSONA = `You are the Proactive Capacity Forecasting Agent for Cloud Solution Architects.
You answer natural-language questions about customer capacity outlook using ONLY the provided tools and datasources:
1) MSX opportunities / upcoming projects / SKU demand
2) Stratus region & AZ capacity availability and forecast
3) Customer inventory ACR trends (3-year growth/decline)

Always:
- Resolve the customer first (list_customers / exact id or name).
- Use analyze_customer_capacity_risk for proactive concerns and actions.
- Cite concrete regions, AZs, VM SKUs, core shortfalls, quota needs, buildouts, and ACR growth signals.
- Be concise, actionable, and honest about datasource warnings.
- Do not invent capacity numbers that tools did not return.
- Format for a web chat UI: use GitHub-flavored Markdown. Prefer Markdown tables for multi-column comparisons (SKU/region/cores/status, ACR by year, opportunities). Keep tables to essential columns (≤7). Use short headings, bullet lists for actions, and bold for key numbers. Avoid ASCII art tables and giant monospace dumps.`

const FALLBACK_MODELS = [
  { id: 'gpt-4.1', name: 'GPT-4.1', policyState: 'enabled' as const },
  { id: 'gpt-5', name: 'GPT-5', policyState: 'enabled' as const },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', policyState: 'enabled' as const },
]

const sessions = new Map<string, CopilotSession>()
const sessionInit = new Map<string, Promise<CopilotSession>>()
const sessionModels = new Map<string, string>()
let copilotClient: CopilotClient | null = null
let datasourcesBootstrapped = false
let modelsCache: CapacityModelOption[] | null = null
let modelsCacheError: string | null = null

export type CapacityModelOption = {
  id: string
  name: string
  policyState?: string
  supportsReasoningEffort?: boolean
  billingMultiplier?: number
}

export function getDefaultModelId() {
  return (process.env.COPILOT_MODEL || 'gpt-4.1').trim() || 'gpt-4.1'
}

export function ensureDatasourcesLoaded() {
  if (datasourcesBootstrapped) return loadCapacityStore()
  const store = loadCapacityStore(true)
  datasourcesBootstrapped = true
  return store
}

function getClient() {
  if (!copilotClient) {
    const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
    copilotClient = new CopilotClient({
      ...(token ? { gitHubToken: token, useLoggedInUser: false } : {}),
    })
  }
  return copilotClient
}

async function ensureClientStarted() {
  const client = getClient()
  await client.start()
  return client
}

function normalizeModelId(model?: string | null) {
  const trimmed = String(model || '').trim()
  return trimmed || getDefaultModelId()
}

function pickDefaultModel(models: CapacityModelOption[]) {
  const preferred = getDefaultModelId()
  if (models.some((m) => m.id === preferred)) return preferred
  const auto = models.find((m) => m.id === 'auto')
  if (auto) return auto.id
  return models[0]?.id || preferred
}

export async function listCapacityModels(force = false): Promise<{
  models: CapacityModelOption[]
  defaultModel: string
  source: 'copilot' | 'fallback'
  warning?: string
}> {
  if (!force && modelsCache?.length) {
    return {
      models: modelsCache,
      defaultModel: pickDefaultModel(modelsCache),
      source: 'copilot',
      warning: modelsCacheError || undefined,
    }
  }

  try {
    const client = await ensureClientStarted()
    const raw = await client.listModels()
    const models: CapacityModelOption[] = raw
      .filter((m) => m?.id)
      .filter((m) => !m.policy || m.policy.state !== 'disabled')
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        policyState: m.policy?.state,
        supportsReasoningEffort: Boolean(m.capabilities?.supports?.reasoningEffort),
        billingMultiplier: m.billing?.multiplier,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    if (!models.length) {
      throw new Error('Copilot returned an empty model list for this account/org.')
    }

    modelsCache = models
    modelsCacheError = null
    return {
      models,
      defaultModel: pickDefaultModel(models),
      source: 'copilot',
    }
  } catch (err) {
    const warning =
      err instanceof Error ? err.message : String(err || 'Could not list Copilot models')
    modelsCacheError = warning
    const fallback = [...FALLBACK_MODELS]
    // Keep configured default visible even if not in static fallback.
    const preferred = getDefaultModelId()
    if (!fallback.some((m) => m.id === preferred)) {
      fallback.unshift({ id: preferred, name: preferred, policyState: 'enabled' })
    }
    return {
      models: fallback,
      defaultModel: pickDefaultModel(fallback),
      source: 'fallback',
      warning,
    }
  }
}

export async function getOrCreateCapacitySession(sessionKey: string, model?: string | null) {
  const resolvedModel = normalizeModelId(model)
  const existing = sessions.get(sessionKey)
  if (existing) {
    const currentModel = sessionModels.get(sessionKey)
    if (currentModel !== resolvedModel) {
      await existing.setModel(resolvedModel)
      sessionModels.set(sessionKey, resolvedModel)
    }
    return existing
  }

  const pending = sessionInit.get(sessionKey)
  if (pending) {
    const session = await pending
    const currentModel = sessionModels.get(sessionKey)
    if (currentModel !== resolvedModel) {
      await session.setModel(resolvedModel)
      sessionModels.set(sessionKey, resolvedModel)
    }
    return session
  }

  ensureDatasourcesLoaded()

  const promise = (async () => {
    try {
      const session = await getClient().createSession({
        model: resolvedModel,
        onPermissionRequest: approveAll,
        streaming: true,
        tools: createCapacityTools(),
        systemMessage: { content: CAPACITY_AGENT_PERSONA },
      })
      sessions.set(sessionKey, session)
      sessionModels.set(sessionKey, resolvedModel)
      return session
    } finally {
      sessionInit.delete(sessionKey)
    }
  })()

  sessionInit.set(sessionKey, promise)
  return promise
}

export type AskCapacityOptions = {
  onDelta?: (delta: string) => void
  model?: string | null
}

export async function askCapacityAgent(
  sessionKey: string,
  prompt: string,
  options: AskCapacityOptions = {},
): Promise<{ answer: string; sessionId: string; model: string }> {
  const model = normalizeModelId(options.model)
  const session = await getOrCreateCapacitySession(sessionKey, model)
  let answer = ''

  const done = new Promise<void>((resolve, reject) => {
    let settled = false
    const unsubscribe = session.on((event) => {
      if (settled) return
      if (event.type === 'assistant.message_delta') {
        const delta = (event as { data?: { deltaContent?: string } }).data?.deltaContent || ''
        if (delta) {
          answer += delta
          options.onDelta?.(delta)
        }
      } else if (event.type === 'session.idle') {
        settled = true
        unsubscribe()
        resolve()
      } else if (event.type === 'session.error') {
        settled = true
        unsubscribe()
        reject(
          new Error(
            (event as { data?: { message?: string } }).data?.message || 'Copilot session error',
          ),
        )
      }
    })
  })

  try {
    await session.send({ prompt })
    await done
    return { answer: answer.trim(), sessionId: sessionKey, model }
  } catch (err) {
    sessions.delete(sessionKey)
    sessionModels.delete(sessionKey)
    throw err
  }
}

export async function resetCapacitySession(sessionKey: string) {
  const session = sessions.get(sessionKey)
  sessions.delete(sessionKey)
  sessionModels.delete(sessionKey)
  if (session) {
    await session.disconnect().catch(() => undefined)
  }
}

export function getCapacityAgentStatus() {
  const store = ensureDatasourcesLoaded()
  const hasToken = Boolean((process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim())
  return {
    ok: true,
    hasGitHubToken: hasToken,
    model: getDefaultModelId(),
    defaultModel: getDefaultModelId(),
    loadedAt: store.meta.loadedAt,
    sources: store.meta.sources.map((s) => s.split(/[/\\]/).pop() || s),
    warnings: store.meta.warnings,
    counts: {
      customers: store.customers.length,
      opportunities: store.opportunities.length,
      skuDemand: store.skuDemand.length,
      capacityCurrent: store.capacityCurrent.length,
      inventoryAcr: store.inventoryAcr.length,
      deployedInventory: store.deployedInventory.length,
    },
    activeSessions: sessions.size,
  }
}

export async function stopCapacityAgent() {
  for (const [key, session] of sessions) {
    sessions.delete(key)
    sessionModels.delete(key)
    await session.disconnect().catch(() => undefined)
  }
  modelsCache = null
  modelsCacheError = null
  if (copilotClient) {
    await copilotClient.stop().catch(() => undefined)
    copilotClient = null
  }
}
