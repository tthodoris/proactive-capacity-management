import 'dotenv/config'
import { ActivityTypes } from '@microsoft/agents-activity'
import {
  AgentApplication,
  MemoryStorage,
  TurnContext,
  type TurnState,
} from '@microsoft/agents-hosting'
import { startServer } from '@microsoft/agents-hosting-express'
import {
  askCapacityAgent,
  CAPACITY_AGENT_PERSONA,
  ensureDatasourcesLoaded,
} from './chatCore.js'

const store = ensureDatasourcesLoaded()
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
      CAPACITY_AGENT_PERSONA.split('\n')[0],
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
    const { answer } = await askCapacityAgent(sessionKey, userText, {
      onDelta: (delta) => context.streamingResponse.queueTextChunk(delta),
    })

    if (!answer) {
      await context.sendActivity(
        'I could not produce an answer. Try naming a customer from the MSX sample set (e.g. Hellenic Bank of Attica).',
      )
    }
  } catch (err) {
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
