import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  LogOut,
  PlugZap,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { formatDate, formatRelative } from '../lib/format'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'
import {
  cancelUatLogin,
  connectUat,
  disconnectUat,
  fetchUatConfig,
  fetchUatStatus,
  fetchUatWorkItemList,
  submitUatAccessToken,
  type UatConfig,
  type UatConnection,
  type UatListItem,
  type UatWorkItemList,
} from '../lib/uatApi'

type UatSortKey =
  | 'id'
  | 'title'
  | 'state'
  | 'account'
  | 'eou'
  | 'areaField'
  | 'requestors'
  | 'tpid'
  | 'noNaiSku1'
  | 'noNaiUom1'
  | 'noNaiQuantity1'
  | 'estMonthlyUsages'
  | 'requestedDate'
  | 'opportunityId'
  | 'milestoneId'
  | 'azurePreferredRegion'
  | 'azureCapacityTypeMultiline'
  | 'primaryCompetitor'
  | 'actionPriority'
  | 'noNaiRegional'
  | 'noNaiRequestType'
  | 'noNaiSubscriptionId'
  | 'noNaiSr'
  | 'changedDate'

const UAT_COLUMNS: Array<[UatSortKey, string]> = [
  ['id', 'Id'],
  ['title', 'Title'],
  ['state', 'Status'],
  ['account', 'Account'],
  ['estMonthlyUsages', 'Est Monthly Usages'],
  ['noNaiSku1', 'NoNAI_SKU_1'],
  ['noNaiUom1', 'NoNAI_UOM_1'],
  ['noNaiQuantity1', 'NoNAI_Quantity_1'],
  ['azurePreferredRegion', 'AzurePreferredRegion'],
  ['noNaiRegional', 'NoNAI_Regional'],
  ['noNaiRequestType', 'NoNAI_RequestType'],
  ['noNaiSubscriptionId', 'NoNAI_SubscriptionID'],
  ['noNaiSr', 'NoNAI_SR'],
  ['areaField', 'AreaField'],
  ['tpid', 'TPID'],
  ['requestedDate', 'Requested Date'],
  ['changedDate', 'Changed'],
]

function valueOrDash(value: string | number | null | undefined) {
  if (value == null || value === '') return '—'
  return String(value)
}

function formatEstMonthlyUsages(value: string | number | null | undefined) {
  if (value == null || value === '') return ''
  const num = Number(String(value).replace(/,/g, '').trim())
  if (!Number.isFinite(num)) return String(value)
  return num.toFixed(2)
}

export function UatsPage() {
  const [config, setConfig] = useState<UatConfig | null>(null)
  const [connection, setConnection] = useState<UatConnection | null>(null)
  const [list, setList] = useState<UatWorkItemList | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [accessTokenInput, setAccessTokenInput] = useState('')
  const [submittingToken, setSubmittingToken] = useState(false)
  const pollRef = useRef<number | null>(null)

  const { sortKey, sortDir, toggleSort } = useSortState<UatSortKey>('changedDate', 'desc')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<UatSortKey>()

  const pending =
    connection?.status === 'awaiting_device_code' || connection?.status === 'authenticating'
  const connected = connection?.status === 'connected'
  const canQuery =
    connected ||
    connection?.authMode === 'pat' ||
    connection?.authMode === 'pasted_token'

  const loadSavedList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setList(await fetchUatWorkItemList({ source: 'db' }))
    } catch (err) {
      setList(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshFromAdo = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      setList(await fetchUatWorkItemList({ source: 'ado' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([fetchUatConfig(), fetchUatStatus()])
    setConfig(nextConfig)
    setConnection(nextStatus)
    return nextStatus
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([refreshStatus(), loadSavedList()])
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [refreshStatus, loadSavedList])

  useEffect(() => {
    if (!pending) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const status = await fetchUatStatus()
          setConnection(status)
          if (status.status === 'connected') {
            setConnecting(false)
            await refreshFromAdo()
          }
          if (status.status === 'error' || status.status === 'cancelled') {
            setConnecting(false)
            setError(status.error || status.message || 'Azure DevOps login failed')
          }
        } catch (err) {
          setConnecting(false)
          setError(err instanceof Error ? err.message : String(err))
        }
      })()
    }, 2000)
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [pending, refreshFromAdo])

  async function onConnect() {
    setConnecting(true)
    setError(null)
    try {
      setConnection(await connectUat())
    } catch (err) {
      setConnecting(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onCancel() {
    setConnecting(false)
    try {
      setConnection(await cancelUatLogin())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onDisconnect() {
    setConnecting(true)
    setError(null)
    try {
      setConnection(await disconnectUat())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  async function onSubmitToken() {
    setSubmittingToken(true)
    setError(null)
    try {
      setConnection(await submitUatAccessToken(accessTokenInput.trim()))
      setAccessTokenInput('')
      await refreshFromAdo()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmittingToken(false)
    }
  }

  async function copyCode() {
    if (!connection?.deviceCode) return
    await navigator.clipboard.writeText(connection.deviceCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const getValue = useCallback((item: UatListItem, key: string) => {
    switch (key) {
      case 'id':
        return item.id == null ? '' : String(item.id)
      case 'changedDate':
        return item.changedDate ? formatRelative(item.changedDate) : '—'
      case 'requestedDate':
        return item.requestedDate ? formatDate(item.requestedDate) : '—'
      case 'estMonthlyUsages':
        return formatEstMonthlyUsages(item.estMonthlyUsages)
      default: {
        const value = item[key as keyof UatListItem]
        return value == null ? '' : String(value)
      }
    }
  }, [])

  const getSortValue = useCallback((item: UatListItem, key: string) => {
    if (key === 'changedDate' || key === 'requestedDate') {
      return (item[key as 'changedDate' | 'requestedDate'] as string | null) || ''
    }
    if (key === 'id') return item.id ?? 0
    if (key === 'estMonthlyUsages') {
      const num = Number(String(item.estMonthlyUsages ?? '').replace(/,/g, '').trim())
      return Number.isFinite(num) ? num : 0
    }
    return getValue(item, key)
  }, [getValue])

  const baseItems = list?.items || []

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return baseItems
    return baseItems.filter((item) => {
      const hay = UAT_COLUMNS.map(([key]) => getValue(item, key))
        .concat([item.milestoneReason || '', item.workItemType || ''])
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [baseItems, query, getValue])

  const filtered = useMemo(() => {
    return searched.filter((item) =>
      matchesColumnFilters((column) => String(getValue(item, column) ?? '')),
    )
  }, [searched, matchesColumnFilters, getValue])

  const rows = useSortedRows(filtered, sortKey, sortDir, getSortValue)
  const columnKeys = UAT_COLUMNS.map(([key]) => key)

  const columnOptions = useMemo(
    () => collectCascadingOptions(searched, columnKeys, filters, getValue),
    [searched, filters, getValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(columnOptions)
  }, [columnOptions, pruneFiltersToOptions])

  const hasFilters = Boolean(query) || activeFilterCount > 0

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>UATs</h3>
          <p>
            Unified Action Tracker work items where MilestoneReason ={' '}
            <strong>Capacity/Service Availability</strong>
            {config ? ` (${config.organization})` : ''}. Opens the last saved list from Postgres;
            use Refresh to pull from Azure DevOps and upsert. Click a column name to filter values.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void refreshFromAdo()}
            disabled={refreshing || loading || !canQuery}
            title={
              canQuery
                ? 'Refresh from Azure DevOps and save to Postgres'
                : 'Sign in to Azure DevOps to refresh'
            }
          >
            <RefreshCw size={16} />
            {refreshing ? 'Refreshing…' : 'Refresh from Azure DevOps'}
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Azure DevOps sign-in</h4>
            <p>
              Microsoft tenant Conditional Access blocks device-code login (error 53003) in Container
              Apps. Use a Windows WAM token from PowerShell, then paste it here.
            </p>
          </div>
          <PlugZap size={18} color="#0e7c86" />
        </div>
        <div className="panel-body stack">
          {!connected && !pending ? (
            <div className="stack">
              <div>
                <strong>Recommended: paste access token</strong>
                <pre className="uat-text-block" style={{ marginTop: '0.55rem' }}>
{`az login --tenant microsoft.onmicrosoft.com
az devops configure --defaults organization=https://dev.azure.com/unifiedactiontracker
az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`}
                </pre>
                <textarea
                  value={accessTokenInput}
                  onChange={(e) => setAccessTokenInput(e.target.value)}
                  placeholder="Paste the access token from PowerShell"
                  rows={3}
                  style={{ width: '100%', marginTop: '0.65rem' }}
                />
                <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap', marginTop: '0.65rem' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void onSubmitToken()}
                    disabled={submittingToken || !accessTokenInput.trim()}
                  >
                    {submittingToken ? 'Validating…' : 'Use pasted token'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void onConnect()}
                    disabled={connecting}
                    title="Likely blocked by Conditional Access (53003) on Microsoft tenant"
                  >
                    <PlugZap size={16} />
                    Try device-code login
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {pending ? (
            <div className="device-code-card">
              <div>
                <div className="muted">Device code for tenant</div>
                <strong style={{ fontSize: '1.05rem' }}>
                  {connection?.tenantId || config?.tenantId}
                </strong>
              </div>
              <div className="device-code-value">
                <span>{connection?.deviceCode || 'Waiting for Azure CLI…'}</span>
                {connection?.deviceCode ? (
                  <button type="button" className="btn btn-ghost" onClick={() => void copyCode()}>
                    <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                ) : (
                  <LoaderCircle size={18} className="spin" />
                )}
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {connection?.message}
              </p>
              <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
                <a
                  className="btn btn-primary"
                  href={connection?.verificationUrl || 'https://microsoft.com/devicelogin'}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Link2 size={16} /> Open microsoft.com/devicelogin
                </a>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void onCancel()}
                  disabled={connecting}
                >
                  Cancel login
                </button>
              </div>
            </div>
          ) : null}

          {connected ? (
            <div className="connected-card">
              <div>
                <strong>
                  {connection?.account?.user?.name ||
                    connection?.account?.name ||
                    'Connected to Azure DevOps'}
                </strong>
                <div className="muted">
                  {connection?.organizationUrl || config?.organizationUrl} · Tenant{' '}
                  {connection?.tenantId || config?.tenantId} · Auth:{' '}
                  {connection?.authMode === 'azure_cli'
                    ? 'Azure CLI bearer token'
                    : connection?.authMode === 'pasted_token'
                      ? 'Pasted WAM access token'
                      : connection?.authMode}
                </div>
                {connection?.message ? (
                  <div className="muted" style={{ marginTop: '0.25rem' }}>
                    {connection.message}
                  </div>
                ) : null}
              </div>
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => void onDisconnect()}
                disabled={connecting}
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {error ? (
        <section className="panel">
          <div className="panel-body">
            <div className="empty" style={{ textAlign: 'left' }}>
              <strong>Could not load UAT work items</strong>
              <p style={{ marginTop: '0.55rem' }}>{error}</p>
            </div>
          </div>
        </section>
      ) : null}

      {canQuery ? null : (
        <section className="panel" style={{ marginBottom: '1rem' }}>
          <p className="muted" style={{ margin: 0 }}>
            Showing the last saved list from Postgres. Sign in above to refresh from Azure DevOps.
          </p>
        </section>
      )}

      <>
          <div className="filters" style={{ alignItems: 'center' }}>
            <div className="search">
              <Search size={16} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search id, title, status, account, EOU, or AreaField"
              />
            </div>
            {hasFilters ? (
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  setQuery('')
                  clearAllFilters()
                }}
              >
                <X size={16} /> Clear filters
              </button>
            ) : null}
          </div>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Capacity / Service Availability</h4>
                <p>
                  {loading
                    ? 'Loading saved list…'
                    : refreshing
                      ? 'Refreshing from Azure DevOps…'
                      : list
                        ? `${rows.length} of ${list.included ?? list.total} work items`
                        : 'No saved UAT work items yet'}
                  {typeof list?.saved === 'number' ? ` · saved ${list.saved}` : ''}
                  {list?.lastRetrievedAt
                    ? ` · last saved ${new Date(list.lastRetrievedAt).toLocaleString()}`
                    : ''}
                  {list?.source ? ` · source: ${list.source}` : ''}
                  {list?.excludedAreaFields?.length
                    ? ` · excluded AreaFields: ${list.excludedAreaFields.join(', ')}`
                    : ''}
                  {list?.excludedPreferredRegions?.length
                    ? ` · excluded AzurePreferredRegion: ${list.excludedPreferredRegions.join(', ')}`
                    : ''}
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {UAT_COLUMNS.map(([column, label]) => (
                      <FilterableTh
                        key={column}
                        label={label}
                        column={column}
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={(c) => toggleSort(c as UatSortKey)}
                        options={columnOptions[column]}
                        selected={filters[column]}
                        onFilterChange={(values) => setColumnFilter(column, values)}
                      />
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr key={String(item.id)}>
                      {UAT_COLUMNS.map(([column]) => (
                        <td
                          key={column}
                          className={
                            column === 'changedDate' || column === 'requestedDate' ? 'muted' : undefined
                          }
                        >
                          {column === 'id' ? (
                            <code>{valueOrDash(item.id)}</code>
                          ) : column === 'title' ? (
                            <strong>{valueOrDash(item.title)}</strong>
                          ) : column === 'state' ? (
                            <span className="pill pill-medium">{valueOrDash(item.state)}</span>
                          ) : (
                            valueOrDash(getValue(item, column))
                          )}
                        </td>
                      ))}
                      <td>
                        {item.htmlUrl ? (
                          <a
                            className="btn btn-ghost"
                            href={item.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={14} />
                            Open
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!loading && !refreshing && rows.length === 0 ? (
                    <tr>
                      <td colSpan={UAT_COLUMNS.length + 1}>
                        <div className="empty">
                          {list
                            ? 'No work items match the current filters.'
                            : 'No saved UAT work items yet. Sign in and refresh from Azure DevOps.'}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {(loading || refreshing) && rows.length === 0 ? (
                    <tr>
                      <td colSpan={UAT_COLUMNS.length + 1}>
                        <div className="empty">
                          {refreshing ? 'Querying Azure DevOps…' : 'Loading saved list…'}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
      </>
    </div>
  )
}
