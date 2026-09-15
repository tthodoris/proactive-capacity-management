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
  defaultModel?: string
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

export type CapacityAgentModel = {
  id: string
  name: string
  policyState?: string
  supportsReasoningEffort?: boolean
  billingMultiplier?: number
}

export type CapacityAgentModelsResponse = {
  models: CapacityAgentModel[]
  defaultModel: string
  source: 'copilot' | 'fallback'
  warning?: string
}

export type CapacityAgentChatResponse = {
  sessionId: string
  reply: string
  model?: string
}

export type CapacityAgentChatSummary = {
  id: string
  title: string
  model?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  preview?: string | null
  messageCount?: number
}

export type CapacityAgentChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  at: string
}

export type CapacityAgentChatDetail = CapacityAgentChatSummary & {
  messages: CapacityAgentChatMessage[]
}

export function getCapacityAgentStatus() {
  return api<CapacityAgentStatus>('/api/agent/status')
}

export function getCapacityAgentModels() {
  return api<CapacityAgentModelsResponse>('/api/agent/models')
}

export function listCapacityAgentChats(limit = 20) {
  return api<{ chats: CapacityAgentChatSummary[]; limit: number }>(
    `/api/agent/chats?limit=${encodeURIComponent(String(limit))}`,
  )
}

export function getCapacityAgentChat(chatId: string) {
  return api<CapacityAgentChatDetail>(`/api/agent/chats/${encodeURIComponent(chatId)}`)
}

export function chatWithCapacityAgent(
  message: string,
  sessionId?: string | null,
  model?: string | null,
) {
  return api<CapacityAgentChatResponse>('/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({
      message,
      sessionId: sessionId || undefined,
      model: model || undefined,
    }),
  })
}

export function resetCapacityAgentSession(sessionId: string) {
  return api<{ ok: boolean; sessionId: string }>('/api/agent/reset', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}
