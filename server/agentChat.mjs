/**
 * Bridge from the PCM API into capacity-forecasting-agent chatCore.
 * Resolves modules from the agent package so its node_modules are used.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const agentRoot = join(__dirname, '..', 'capacity-forecasting-agent')
const chatCorePath = join(agentRoot, 'dist', 'chatCore.js')

let chatCorePromise = null

async function loadChatCore() {
  if (chatCorePromise) return chatCorePromise
  chatCorePromise = (async () => {
    if (!existsSync(chatCorePath)) {
      throw new Error(
        `Capacity agent not built (${chatCorePath}). Run: npm run build --prefix capacity-forecasting-agent`,
      )
    }
    if (!process.env.CAPACITY_DATASOURCE_DIR) {
      process.env.CAPACITY_DATASOURCE_DIR = join(agentRoot, 'datasources')
    }
    return import(pathToFileURL(chatCorePath).href)
  })()
  return chatCorePromise
}

export async function getCapacityAgentStatus() {
  try {
    const core = await loadChatCore()
    return await core.getCapacityAgentStatus()
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hasGitHubToken: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
    }
  }
}

export async function askCapacityAgent(sessionId, message) {
  const core = await loadChatCore()
  return core.askCapacityAgent(sessionId, message)
}

export async function resetCapacitySession(sessionId) {
  const core = await loadChatCore()
  return core.resetCapacitySession(sessionId)
}
