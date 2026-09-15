import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  askCapacityAgent,
  ensureDatasourcesLoaded,
  getOrCreateCapacitySession,
  stopCapacityAgent,
} from './chatCore.js'

async function main() {
  const store = ensureDatasourcesLoaded()
  console.log('Capacity Forecasting Agent (Copilot SDK CLI)')
  console.log(
    `Loaded ${store.customers.length} customers, ${store.opportunities.length} opportunities, ${store.capacityCurrent.length} capacity rows.`,
  )
  if (store.meta.warnings.length) {
    console.log('Warnings:')
    for (const w of store.meta.warnings) console.log(` - ${w}`)
  }
  console.log('Ask about a customer capacity forecast. Type "exit" to quit.\n')

  const sessionKey = 'cli'
  await getOrCreateCapacitySession(sessionKey)
  const rl = createInterface({ input, output })

  try {
    while (true) {
      const prompt = (await rl.question('you> ')).trim()
      if (!prompt) continue
      if (/^(exit|quit)$/i.test(prompt)) break
      process.stdout.write('agent> ')
      const { answer } = await askCapacityAgent(sessionKey, prompt, {
        onDelta: (delta) => process.stdout.write(delta),
      })
      if (!answer) console.log('(no text response)')
      console.log('\n')
    }
  } finally {
    rl.close()
    await stopCapacityAgent()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
