import { useCallback, useEffect, useRef, useState } from 'react'
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
  fetchUatWorkItem,
  type UatConfig,
  type UatConnection,
  type UatWorkItem,
} from '../lib/uatApi'

function valueOrDash(value: string | number | null | undefined) {
  if (value == null || value === '') return '—'
  return String(value)
}

export function UatsPage() {
  const [config, setConfig] = useState<UatConfig | null>(null)
  const [connection, setConnection] = useState<UatConnection | null>(null)
  const [workItem, setWorkItem] = useState<UatWorkItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAllFields, setShowAllFields] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const pollRef = useRef<number | null>(null)

  const pending =
    connection?.status === 'awaiting_device_code' || connection?.status === 'authenticating'
  const connected = connection?.status === 'connected'

  const loadWorkItem = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const nextItem = await fetchUatWorkItem()
      setWorkItem(nextItem)
    } catch (err) {
      setWorkItem(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
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
        const status = await refreshStatus()
        if (status.status === 'connected' || status.authMode === 'pat') {
          await loadWorkItem()
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [refreshStatus, loadWorkItem])

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
            await loadWorkItem()
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
  }, [pending, loadWorkItem])

  async function onConnect() {
    setConnecting(true)
    setError(null)
    setWorkItem(null)
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
      setWorkItem(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  async function copyCode() {
    if (!connection?.deviceCode) return
    await navigator.clipboard.writeText(connection.deviceCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const tags = (workItem?.tags || '')
    .split(';')
    .map((tag) => tag.trim())
    .filter(Boolean)

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>UATs</h3>
          <p>
            Unified Action Tracker work items from Azure DevOps
            {config ? ` (${config.organization})` : ''}. Sign in with the Microsoft tenant, then load
            work item {config?.defaultWorkItemId ?? 780831}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          {workItem?.htmlUrl ? (
            <a className="btn btn-secondary" href={workItem.htmlUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              Open in ADO
            </a>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void loadWorkItem()}
            disabled={loading || (!connected && connection?.authMode !== 'pat')}
          >
            <RefreshCw size={16} />
            {loading ? 'Loading…' : 'Refresh work item'}
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Azure DevOps sign-in</h4>
            <p>
              Uses the same flow as{' '}
              <code>az login --tenant {config?.tenantId || 'microsoft.onmicrosoft.com'}</code>, then
              a bearer token for resource <code>499b84ac-1321-427f-aa17-267ca6975798</code>.
            </p>
          </div>
          <PlugZap size={18} color="#0e7c86" />
        </div>
        <div className="panel-body stack">
          {!connected && !pending ? (
            <div className="list-row">
              <div style={{ flex: 1 }}>
                <strong>Not signed in</strong>
                <div className="muted" style={{ marginTop: '0.25rem' }}>
                  Organization {config?.organizationUrl || 'https://dev.azure.com/unifiedactiontracker'}{' '}
                  · Tenant {config?.tenantId || 'microsoft.onmicrosoft.com'}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void onConnect()}
                disabled={connecting}
              >
                <PlugZap size={16} />
                Sign in with Microsoft tenant
              </button>
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
                  {connection?.authMode === 'azure_cli' ? 'Azure CLI bearer token' : connection?.authMode}
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

          {config ? (
            <div className="muted" style={{ fontSize: '0.86rem' }}>
              API test URL:{' '}
              <a href={config.testWorkItemUrl} target="_blank" rel="noreferrer">
                {config.testWorkItemUrl}
              </a>
            </div>
          ) : null}
        </div>
      </section>

      {error ? (
        <section className="panel">
          <div className="panel-body">
            <div className="empty" style={{ textAlign: 'left' }}>
              <strong>Could not load UAT work item</strong>
              <p style={{ marginTop: '0.55rem' }}>{error}</p>
            </div>
          </div>
        </section>
      ) : null}

      {loading && !workItem ? (
        <section className="panel">
          <div className="panel-body">
            <div className="empty">Loading work item from Azure DevOps…</div>
          </div>
        </section>
      ) : null}

      {workItem ? (
        <>
          <div className="metrics">
            <MetricCard label="ID" value={valueOrDash(workItem.id)} hint={workItem.workItemType || 'Work item'} />
            <MetricCard
              label="State"
              value={valueOrDash(workItem.state)}
              hint={workItem.reason || 'Current workflow state'}
              delay={60}
            />
            <MetricCard
              label="Assigned to"
              value={valueOrDash(workItem.assignedTo?.displayName)}
              hint={workItem.assignedTo?.uniqueName || 'Unassigned'}
              delay={120}
            />
            <MetricCard
              label="Changed"
              value={workItem.changedDate ? formatRelative(workItem.changedDate) : '—'}
              hint={workItem.changedBy?.displayName || 'Last update'}
              delay={180}
            />
          </div>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>{workItem.title || `Work item ${workItem.id}`}</h4>
                <p>
                  {workItem.teamProject || '—'} · {workItem.areaPath || '—'} ·{' '}
                  {workItem.iterationPath || '—'}
                </p>
              </div>
              <ClipboardList size={18} color="#0e7c86" />
            </div>
            <div className="panel-body stack">
              <div className="grid-2">
                <div>
                  <div className="muted">Priority</div>
                  <strong>{valueOrDash(workItem.priority)}</strong>
                </div>
                <div>
                  <div className="muted">Severity</div>
                  <strong>{valueOrDash(workItem.severity)}</strong>
                </div>
                <div>
                  <div className="muted">Created</div>
                  <strong>
                    {workItem.createdDate ? formatRelative(workItem.createdDate) : '—'}
                    {workItem.createdBy?.displayName ? ` · ${workItem.createdBy.displayName}` : ''}
                  </strong>
                </div>
                <div>
                  <div className="muted">Revision</div>
                  <strong>{valueOrDash(workItem.rev)}</strong>
                </div>
              </div>

              {tags.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {tags.map((tag) => (
                    <span key={tag} className="pill pill-medium">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}

              {workItem.description ? (
                <div>
                  <div className="muted" style={{ marginBottom: '0.35rem' }}>
                    Description
                  </div>
                  <pre className="uat-text-block">{workItem.description}</pre>
                </div>
              ) : null}

              {workItem.acceptanceCriteria ? (
                <div>
                  <div className="muted" style={{ marginBottom: '0.35rem' }}>
                    Acceptance criteria
                  </div>
                  <pre className="uat-text-block">{workItem.acceptanceCriteria}</pre>
                </div>
              ) : null}

              {workItem.reproSteps ? (
                <div>
                  <div className="muted" style={{ marginBottom: '0.35rem' }}>
                    Repro steps
                  </div>
                  <pre className="uat-text-block">{workItem.reproSteps}</pre>
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Work item fields</h4>
                <p>
                  {showAllFields
                    ? `${workItem.fields.length} fields from Azure DevOps`
                    : 'Key System / VSTS fields'}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowAllFields((prev) => !prev)}
              >
                {showAllFields ? 'Show key fields' : 'Show all fields'}
              </button>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              <table className="uat-fields-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllFields
                    ? workItem.fields
                    : workItem.fields.filter((row) =>
                        workItem.priorityFieldNames.includes(row.name),
                      )
                  ).map((row) => (
                    <tr key={row.name}>
                      <td>
                        <code>{row.name}</code>
                      </td>
                      <td>{row.value || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {workItem.relations.length ? (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h4>Relations</h4>
                  <p>{workItem.relations.length} linked artifacts</p>
                </div>
              </div>
              <div className="panel-body stack">
                {workItem.relations.map((relation, index) => (
                  <div key={`${String(relation.rel)}-${index}`} className="list-row">
                    <div style={{ flex: 1 }}>
                      <strong>{String(relation.rel || 'relation')}</strong>
                      <div className="muted" style={{ marginTop: '0.25rem', wordBreak: 'break-all' }}>
                        {String(relation.url || '—')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Raw API payload</h4>
                <p>Full Azure DevOps work item JSON</p>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setShowRaw((prev) => !prev)}>
                {showRaw ? 'Hide' : 'Show'}
              </button>
            </div>
            {showRaw ? (
              <div className="panel-body">
                <pre className="uat-text-block">{JSON.stringify(workItem.raw ?? workItem, null, 2)}</pre>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  )
}
