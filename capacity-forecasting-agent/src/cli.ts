import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { approveAll, CopilotClient, type CopilotSession } from '@github/copilot-sdk'
import { loadCapacityStore } from './data/loadDatasources.js'
import { createCapacityTools } from './tools/capacityTools.js'

const PERSONA = `You are the Proactive Capacity Forecasting Agent for Cloud Solution Architects.
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

async function createSession(client: CopilotClient): Promise<CopilotSession> {
  const model = process.env.COPILOT_MODEL || 'gpt-4.1'
  return client.createSession({
    model,
    onPermissionRequest: approveAll,
    streaming: true,
    tools: createCapacityTools(),
    systemMessage: { content: PERSONA },
  })
}

async function ask(session: CopilotSession, prompt: string) {
  let answer = ''
  const done = new Promise<void>((resolve, reject) => {
    let settled = false
    const unsubscribe = session.on((event) => {
      if (settled) return
      if (event.type === 'assistant.message_delta') {
        const delta = (event as { data?: { deltaContent?: string } }).data?.deltaContent || ''
        if (delta) {
          answer += delta
          process.stdout.write(delta)
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
  await session.send({ prompt })
  await done
  if (!answer.trim()) console.log('(no text response)')
  console.log('\n')
}

async function main() {
  const store = loadCapacityStore()
  console.log('Capacity Forecasting Agent (Copilot SDK CLI)')
  console.log(
    `Loaded ${store.customers.length} customers, ${store.opportunities.length} opportunities, ${store.capacityCurrent.length} capacity rows.`,
  )
  if (store.meta.warnings.length) {
    console.log('Warnings:')
    for (const w of store.meta.warnings) console.log(` - ${w}`)
  }
  console.log('Ask about a customer capacity forecast. Type "exit" to quit.\n')

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const client = new CopilotClient({
    ...(token ? { gitHubToken: token, useLoggedInUser: false } : {}),
  })
  const session = await createSession(client)
  const rl = createInterface({ input, output })

  try {
    while (true) {
      const prompt = (await rl.question('you> ')).trim()
      if (!prompt) continue
      if (/^(exit|quit)$/i.test(prompt)) break
      process.stdout.write('agent> ')
      await ask(session, prompt)
    }
  } finally {
    rl.close()
    await session.disconnect().catch(() => undefined)
    await client.stop().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
