import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ClipboardList,
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  LogOut,
  PlugZap,
  RefreshCw,
} from 'lucide-react'
import { MetricCard } from '../components/Badges'
import { formatRelative } from '../lib/format'
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
  type UatWorkItemFilters,
  type UatWorkItemList,
} from '../lib/uatApi'

function valueOrDash(value: string | number | null | undefined) {
  if (value == null || value === '') return '—'
  return String(value)
}

const EMPTY_FILTERS: UatWorkItemFilters = {
  state: '',
  account: '',
  id: '',
  eou: '',
  areaField: '',
}

export function UatsPage() {
  const [config, setConfig] = useState<UatConfig | null>(null)
  const [connection, setConnection] = useState<UatConnection | null>(null)
  const [list, setList] = useState<UatWorkItemList | null>(null)
  const [draftFilters, setDraftFilters] = useState<UatWorkItemFilters>(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<UatWorkItemFilters>(EMPTY_FILTERS)
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [accessTokenInput, setAccessTokenInput] = useState('')
  const [submittingToken, setSubmittingToken] = useState(false)
  const pollRef = useRef<number | null>(null)

  const pending =
    connection?.status === 'awaiting_device_code' || connection?.status === 'authenticating'
  const connected = connection?.status === 'connected'
  const canQuery =
    connected ||
    connection?.authMode === 'pat' ||
    connection?.authMode === 'pasted_token'

  const loadList = useCallback(async (filters: UatWorkItemFilters = appliedFilters) => {
    setLoading(true)
    setError(null)
    try {
      const next = await fetchUatWorkItemList(filters)
      setList(next)
      setAppliedFilters({
        state: filters.state || '',
        account: filters.account || '',
        id: filters.id || '',
        eou: filters.eou || '',
        areaField: filters.areaField || '',
      })
    } catch (err) {
      setList(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [appliedFilters])

  const refreshStatus = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([fetchUatConfig(), fetchUatStatus()])
    setConfig(nextConfig)
    setConnection(nextStatus)
    return nextStatus
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const status = await refreshStatus()
        if (
          status.status === 'connected' ||
          status.authMode === 'pat' ||
          status.authMode === 'pasted_token'
        ) {
          await loadList(EMPTY_FILTERS)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
    // intentionally run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
            await loadList(EMPTY_FILTERS)
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
  }, [pending, loadList])

  async function onConnect() {
    setConnecting(true)
    setError(null)
    setList(null)
    try {
      const status = await connectUat()
      setConnection(status)
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
      setList(null)
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
      const status = await submitUatAccessToken(accessTokenInput.trim())
      setConnection(status)
      setAccessTokenInput('')
      await loadList(EMPTY_FILTERS)
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

  function updateDraft<K extends keyof UatWorkItemFilters>(key: K, value: string) {
    setDraftFilters((prev) => ({ ...prev, [key]: value }))
  }

  const items: UatListItem[] = list?.items || []
  const facets = list?.facets

  const stateOptions = useMemo(() => {
    const values = new Set([...(facets?.state || [])])
    if (draftFilters.state) values.add(draftFilters.state)
    return [...values].sort((a, b) => a.localeCompare(b))
  }, [facets?.state, draftFilters.state])

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>UATs</h3>
          <p>
            Unified Action Tracker work items where MilestoneReason ={' '}
            <strong>Capacity/Service Availability</strong>
            {config ? ` (${config.organization})` : ''}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void loadList(draftFilters)}
            disabled={loading || !canQuery}
          >
            <RefreshCw size={16} />
            {loading ? 'Loading…' : 'Refresh list'}
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

      {canQuery ? (
        <>
          <div className="metrics">
            <MetricCard
              label="Matching"
              value={list?.total ?? 0}
              hint={list ? `of ${list.queried} Capacity/Service Availability` : 'Not loaded yet'}
            />
            <MetricCard
              label="Milestone"
              value="Capacity/SA"
              hint={list?.milestoneReason || 'Capacity/Service Availability'}
              delay={60}
            />
            <MetricCard
              label="States"
              value={facets?.state.length ?? 0}
              hint="Distinct status values"
              delay={120}
            />
            <MetricCard
              label="Accounts"
              value={facets?.account.length ?? 0}
              hint="Distinct account values"
              delay={180}
            />
          </div>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Filters</h4>
                <p>Status, Account, Id, EOU, and AreaField</p>
              </div>
              <ClipboardList size={18} color="#0e7c86" />
            </div>
            <div className="panel-body">
              <form
                className="uat-filter-grid"
                onSubmit={(e) => {
                  e.preventDefault()
                  void loadList(draftFilters)
                }}
              >
                <label>
                  <span className="muted">Status</span>
                  <select
                    value={draftFilters.state || ''}
                    onChange={(e) => updateDraft('state', e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {stateOptions.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="muted">Account</span>
                  <input
                    list="uat-account-options"
                    value={draftFilters.account || ''}
                    onChange={(e) => updateDraft('account', e.target.value)}
                    placeholder="Contains…"
                  />
                  <datalist id="uat-account-options">
                    {(facets?.account || []).map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </label>
                <label>
                  <span className="muted">Id</span>
                  <input
                    value={draftFilters.id || ''}
                    onChange={(e) => updateDraft('id', e.target.value)}
                    placeholder="Work item id"
                  />
                </label>
                <label>
                  <span className="muted">EOU</span>
                  <input
                    list="uat-eou-options"
                    value={draftFilters.eou || ''}
                    onChange={(e) => updateDraft('eou', e.target.value)}
                    placeholder="Contains…"
                  />
                  <datalist id="uat-eou-options">
                    {(facets?.eou || []).map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </label>
                <label>
                  <span className="muted">AreaField</span>
                  <input
                    list="uat-area-options"
                    value={draftFilters.areaField || ''}
                    onChange={(e) => updateDraft('areaField', e.target.value)}
                    placeholder="Contains…"
                  />
                  <datalist id="uat-area-options">
                    {(facets?.areaField || []).map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </label>
                <div className="uat-filter-actions">
                  <button type="submit" className="btn btn-primary" disabled={loading}>
                    Apply filters
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={loading}
                    onClick={() => {
                      setDraftFilters(EMPTY_FILTERS)
                      void loadList(EMPTY_FILTERS)
                    }}
                  >
                    Clear
                  </button>
                </div>
              </form>
              {list?.fieldMap ? (
                <div className="muted" style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}>
                  Resolved fields: MilestoneReason=<code>{list.fieldMap.milestoneReason}</code>, Account=
                  <code>{list.fieldMap.account}</code>, EOU=<code>{list.fieldMap.eou}</code>, AreaField=
                  <code>{list.fieldMap.areaField}</code>
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Work items</h4>
                <p>
                  {loading
                    ? 'Loading…'
                    : list
                      ? `${list.total} shown (queried ${list.queried})`
                      : 'Sign in to load work items'}
                </p>
              </div>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {loading && !list ? (
                <div className="empty">Querying Azure DevOps…</div>
              ) : items.length === 0 ? (
                <div className="empty">No work items match the current filters.</div>
              ) : (
                <table className="uat-fields-table">
                  <thead>
                    <tr>
                      <th>Id</th>
                      <th>Title</th>
                      <th>Status</th>
                      <th>Account</th>
                      <th>EOU</th>
                      <th>AreaField</th>
                      <th>Changed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={String(item.id)}>
                        <td>
                          <code>{valueOrDash(item.id)}</code>
                        </td>
                        <td>{valueOrDash(item.title)}</td>
                        <td>
                          <span className="pill pill-medium">{valueOrDash(item.state)}</span>
                        </td>
                        <td>{valueOrDash(item.account)}</td>
                        <td>{valueOrDash(item.eou)}</td>
                        <td>{valueOrDash(item.areaField)}</td>
                        <td>
                          {item.changedDate ? formatRelative(item.changedDate) : '—'}
                        </td>
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
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
