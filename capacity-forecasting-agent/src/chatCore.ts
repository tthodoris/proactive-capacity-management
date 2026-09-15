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
- Do not invent capacity numbers that tools did not return.`

const sessions = new Map<string, CopilotSession>()
const sessionInit = new Map<string, Promise<CopilotSession>>()
let copilotClient: CopilotClient | null = null
let datasourcesBootstrapped = false

export function ensureDatasourcesLoaded() {
  if (datasourcesBootstrapped) return loadCapacityStore()
  const store = loadCapacityStore(true)
  datasourcesBootstrapped = true
  return store
}

function getClient() {
  if (!copilotClient) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    copilotClient = new CopilotClient({
      ...(token ? { gitHubToken: token, useLoggedInUser: false } : {}),
    })
  }
  return copilotClient
}

export async function getOrCreateCapacitySession(sessionKey: string) {
  const existing = sessions.get(sessionKey)
  if (existing) return existing
  const pending = sessionInit.get(sessionKey)
  if (pending) return pending

  ensureDatasourcesLoaded()

  const promise = (async () => {
    try {
      const model = process.env.COPILOT_MODEL || 'gpt-4.1'
      const session = await getClient().createSession({
        model,
        onPermissionRequest: approveAll,
        streaming: true,
        tools: createCapacityTools(),
        systemMessage: { content: CAPACITY_AGENT_PERSONA },
      })
      sessions.set(sessionKey, session)
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
}

export async function askCapacityAgent(
  sessionKey: string,
  prompt: string,
  options: AskCapacityOptions = {},
): Promise<{ answer: string; sessionId: string }> {
  const session = await getOrCreateCapacitySession(sessionKey)
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
    return { answer: answer.trim(), sessionId: sessionKey }
  } catch (err) {
    sessions.delete(sessionKey)
    throw err
  }
}

export async function resetCapacitySession(sessionKey: string) {
  const session = sessions.get(sessionKey)
  sessions.delete(sessionKey)
  if (session) {
    await session.disconnect().catch(() => undefined)
  }
}

export function getCapacityAgentStatus() {
  const store = ensureDatasourcesLoaded()
  const hasToken = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
  return {
    ok: true,
    hasGitHubToken: hasToken,
    model: process.env.COPILOT_MODEL || 'gpt-4.1',
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
    await session.disconnect().catch(() => undefined)
  }
  if (copilotClient) {
    await copilotClient.stop().catch(() => undefined)
    copilotClient = null
  }
}
