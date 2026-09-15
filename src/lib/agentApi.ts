import { apiErrorFromResponse } from './apiError'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw apiErrorFromResponse(res, data)
  }
  return data as T
}

export type CapacityAgentStatus = {
  ok: boolean
  error?: string
  hasGitHubToken?: boolean
  model?: string
  loadedAt?: string
  sources?: string[]
  warnings?: string[]
  counts?: {
    customers?: number
    opportunities?: number
    skuDemand?: number
    capacityCurrent?: number
    inventoryAcr?: number
    deployedInventory?: number
  }
  activeSessions?: number
}

export type CapacityAgentChatResponse = {
  sessionId: string
  reply: string
}

export function getCapacityAgentStatus() {
  return api<CapacityAgentStatus>('/api/agent/status')
}

export function chatWithCapacityAgent(message: string, sessionId?: string | null) {
  return api<CapacityAgentChatResponse>('/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
  })
}

export function resetCapacityAgentSession(sessionId: string) {
  return api<{ ok: boolean; sessionId: string }>('/api/agent/reset', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}
