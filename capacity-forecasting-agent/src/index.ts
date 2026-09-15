import 'dotenv/config'
import { ActivityTypes } from '@microsoft/agents-activity'
import {
  AgentApplication,
  MemoryStorage,
  TurnContext,
  type TurnState,
} from '@microsoft/agents-hosting'
import { startServer } from '@microsoft/agents-hosting-express'
import { approveAll, CopilotClient, type CopilotSession } from '@github/copilot-sdk'
import { loadCapacityStore } from './data/loadDatasources.js'
import { createCapacityTools } from './tools/capacityTools.js'

const PERSONA = `You are the Proactive Capacity Forecasting Agent for Cloud Solution Architects.
Answer natural-language questions about customer capacity outlook using ONLY the provided tools backed by:
1) MSX_Opportunities_Pipeline.xlsx — opportunities, regions/AZs, VM SKU demand
2) Stratus_Capacity_Availability.xlsx — current + forecast capacity, buildouts, SKU alternatives
3) CXObserve inventory/ACR analysis — 3-year ACR increase/decrease by Azure service

Goals:
- Forecast future capacity needs from open opportunities and growth trends
- Raise concerns about capacity restrictions / shortfalls
- Recommend current and future proactive actions (quota, buildout tracking, SKU alternatives)

Be concise, specific (region/AZ/SKU/cores), and surface datasource warnings when relevant.`

const sessions = new Map<string, CopilotSession>()
const sessionInit = new Map<string, Promise<CopilotSession>>()
let copilotClient: CopilotClient | null = null

function getClient() {
  if (!copilotClient) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    copilotClient = new CopilotClient({
      ...(token ? { gitHubToken: token, useLoggedInUser: false } : {}),
    })
  }
  return copilotClient
}

async function getOrCreateSession(sessionKey: string) {
  const existing = sessions.get(sessionKey)
  if (existing) return existing
  const pending = sessionInit.get(sessionKey)
  if (pending) return pending

  const promise = (async () => {
    try {
      const model = process.env.COPILOT_MODEL || 'gpt-4.1'
      const session = await getClient().createSession({
        model,
        onPermissionRequest: approveAll,
        streaming: true,
        tools: createCapacityTools(),
        systemMessage: { content: PERSONA },
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

const store = loadCapacityStore()
console.log(
  `[capacity-agent] datasources ready: ${store.customers.length} customers, ${store.opportunities.length} opportunities`,
)
for (const warning of store.meta.warnings) {
  console.warn(`[capacity-agent] ${warning}`)
}

const storage = new MemoryStorage()
const agentApp = new AgentApplication({ storage })

agentApp.onConversationUpdate('membersAdded', async (context: TurnContext) => {
  await context.sendActivity(
    'Capacity Forecasting Agent ready.\n\n' +
      'Ask natural-language questions such as:\n' +
      '- "What is the capacity forecast for Hellenic Bank of Attica?"\n' +
      '- "Where are we constrained for Aegean Retail Group VM SKUs?"\n' +
      '- "What proactive actions should we take before CUST-003 consumption starts?"\n\n' +
      'I use MSX opportunities, Stratus capacity, and ACR trend datasources.',
  )
})

agentApp.onActivity(ActivityTypes.Message, async (context: TurnContext, _state: TurnState) => {
  const userText = context.activity.text?.trim()
  if (!userText) return

  context.streamingResponse.queueInformativeUpdate(
    'Analyzing opportunities, capacity, and ACR trends…',
  )

  const userId = context.activity.from?.id || 'anonymous'
  const conversationId = context.activity.conversation?.id || 'default'
  const sessionKey = `${userId}:${conversationId}`

  try {
    const session = await getOrCreateSession(sessionKey)
    let anyDeltas = false

    const done = new Promise<void>((resolve, reject) => {
      let settled = false
      const unsubscribe = session.on((event) => {
        if (settled) return
        switch (event.type) {
          case 'assistant.message_delta': {
            const delta =
              (event as { data?: { deltaContent?: string } }).data?.deltaContent || ''
            if (delta) {
              anyDeltas = true
              context.streamingResponse.queueTextChunk(delta)
            }
            break
          }
          case 'session.idle':
            settled = true
            unsubscribe()
            resolve()
            break
          case 'session.error':
            settled = true
            unsubscribe()
            reject(
              new Error(
                (event as { data?: { message?: string } }).data?.message ||
                  'Copilot session error',
              ),
            )
            break
        }
      })
    })

    await session.send({ prompt: userText })
    await done

    if (!anyDeltas) {
      await context.sendActivity(
        'I could not produce an answer. Try naming a customer from the MSX sample set (e.g. Hellenic Bank of Attica).',
      )
    }
  } catch (err) {
    sessions.delete(sessionKey)
    console.error('[capacity-agent] error', err)
    await context.sendActivity(
      `Capacity agent error: ${err instanceof Error ? err.message : String(err)}. ` +
        'Ensure GitHub Copilot auth is configured (GH_TOKEN / GITHUB_TOKEN or `gh auth login`).',
    )
  } finally {
    await context.streamingResponse.endStream()
  }
})

startServer(agentApp)
