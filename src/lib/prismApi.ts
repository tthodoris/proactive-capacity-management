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
  managedIdentityClientIdConfigured: boolean
  explorerUrl: string
}

export type PrismCapacityBankResult = {
  cluster: string
  database: string
  csl: string
  take: number
  authSource: string
  retrievedAt: string
  total: number
  columns: PrismColumn[]
  rows: Array<Record<string, unknown>>
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

export function fetchPrismCapacityBank(options: { take?: number; csl?: string } = {}) {
  const params = new URLSearchParams()
  if (options.take != null) params.set('take', String(options.take))
  if (options.csl) params.set('csl', options.csl)
  const qs = params.toString()
  return api<PrismCapacityBankResult>(`/api/prism/capacity-bank${qs ? `?${qs}` : ''}`)
}
