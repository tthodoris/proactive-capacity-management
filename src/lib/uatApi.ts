import { apiErrorFromResponse } from './apiError'

export type UatIdentity = {
  displayName: string | null
  uniqueName: string | null
  imageUrl?: string | null
}

export type UatFieldRow = {
  name: string
  value: string
}

export type UatWorkItem = {
  id: number | null
  rev: number | null
  url: string | null
  htmlUrl: string | null
  workItemType: string | null
  title: string | null
  state: string | null
  reason: string | null
  assignedTo: UatIdentity | null
  createdBy: UatIdentity | null
  changedBy: UatIdentity | null
  areaPath: string | null
  iterationPath: string | null
  teamProject: string | null
  createdDate: string | null
  changedDate: string | null
  tags: string | null
  priority: number | string | null
  severity: string | null
  description: string | null
  reproSteps: string | null
  acceptanceCriteria: string | null
  priorityFieldNames: string[]
  fields: UatFieldRow[]
  relations: Array<Record<string, unknown>>
  raw?: Record<string, unknown>
}

export type UatConfig = {
  organization: string
  defaultWorkItemId: number
  authMode: 'pat' | 'azure_cli'
  testWorkItemUrl: string
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw apiErrorFromResponse(res, data)
  }
  return data as T
}

export function fetchUatConfig() {
  return api<UatConfig>('/api/uat/config')
}

export function fetchUatWorkItem(id?: number | string) {
  if (id == null || id === '') {
    return api<UatWorkItem>('/api/uat/workitems')
  }
  return api<UatWorkItem>(`/api/uat/workitems/${encodeURIComponent(String(id))}`)
}
