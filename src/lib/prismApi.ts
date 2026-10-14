import { apiErrorFromResponse } from './apiError'

export type PrismColumn = {
  name: string
  type: string | null
}

export type PrismConfig = {
  cluster: string
  database: string
  table: string
  defaultTake: number
  tokenResource: string
  managedIdentityClientIdConfigured: boolean
  managedIdentityClientIdSuffix: string | null
  explorerUrl: string
}

export type PrismCapacityBankResult = {
  cluster: string
  database: string
  csl: string
  take: number
  authSource: string
  tokenResource?: string
  retrievedAt: string
  total: number
  columns: PrismColumn[]
  rows: Array<Record<string, unknown>>
}

export type PrismPingResult = {
  ok: boolean
  cluster: string
  database: string
  authSource: string
  tokenResource: string
  databases: Array<Record<string, unknown>>
  columns: PrismColumn[]
  retrievedAt: string
}

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

export function fetchPrismConfig() {
  return api<PrismConfig>('/api/prism/config')
}

export function fetchPrismPing() {
  return api<PrismPingResult>('/api/prism/ping')
}

export function fetchPrismCapacityBank(options: { take?: number; csl?: string } = {}) {
  const params = new URLSearchParams()
  if (options.take != null) params.set('take', String(options.take))
  if (options.csl) params.set('csl', options.csl)
  const qs = params.toString()
  return api<PrismCapacityBankResult>(`/api/prism/capacity-bank${qs ? `?${qs}` : ''}`)
}
