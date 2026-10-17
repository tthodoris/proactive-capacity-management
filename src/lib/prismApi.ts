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

/** Original error payload returned by the destination ADX cluster. */
export type PrismClusterError = {
  httpStatus?: number | null
  code?: string | null
  type?: string | null
  message?: string | null
  innererror?: unknown
  rawBody?: unknown
  rawText?: string | null
  url?: string | null
  wwwAuthenticate?: string | null
  activityId?: string | null
  clientRequestId?: string | null
  respondedAtUtc?: string | null
}

export class PrismApiError extends Error {
  clusterError: PrismClusterError | null
  claims: Record<string, unknown> | null
  adxPrincipal: string | null
  hint: string | null

  constructor(
    message: string,
    extras: {
      clusterError?: PrismClusterError | null
      claims?: Record<string, unknown> | null
      adxPrincipal?: string | null
      hint?: string | null
    } = {},
  ) {
    super(message)
    this.name = 'PrismApiError'
    this.clusterError = extras.clusterError || null
    this.claims = extras.claims || null
    this.adxPrincipal = extras.adxPrincipal || null
    this.hint = extras.hint || null
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const base = apiErrorFromResponse(res, data)
    const clusterError =
      data?.clusterError && typeof data.clusterError === 'object'
        ? (data.clusterError as PrismClusterError)
        : data?.adxDiagnostics?.clusterError && typeof data.adxDiagnostics.clusterError === 'object'
          ? (data.adxDiagnostics.clusterError as PrismClusterError)
          : null
    const hint = typeof data?.hint === 'string' ? data.hint : null
    const principal = typeof data?.adxPrincipal === 'string' ? data.adxPrincipal : null
    const claims =
      data?.claims && typeof data.claims === 'object'
        ? (data.claims as Record<string, unknown>)
        : null
    throw new PrismApiError(base.message, {
      clusterError,
      claims,
      adxPrincipal: principal,
      hint,
    })
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
