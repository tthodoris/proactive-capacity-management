import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, ExternalLink, RefreshCw } from 'lucide-react'
import { MetricCard } from '../components/Badges'
import { formatRelative } from '../lib/format'
import {
  fetchUatConfig,
  fetchUatWorkItem,
  type UatConfig,
  type UatWorkItem,
} from '../lib/uatApi'

function valueOrDash(value: string | number | null | undefined) {
  if (value == null || value === '') return '—'
  return String(value)
}

export function UatsPage() {
  const [config, setConfig] = useState<UatConfig | null>(null)
  const [workItem, setWorkItem] = useState<UatWorkItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAllFields, setShowAllFields] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextConfig, nextItem] = await Promise.all([
        fetchUatConfig(),
        fetchUatWorkItem(),
      ])
      setConfig(nextConfig)
      setWorkItem(nextItem)
    } catch (err) {
      setWorkItem(null)
      setError(err instanceof Error ? err.message : String(err))
      try {
        setConfig(await fetchUatConfig())
      } catch {
        // keep previous config if any
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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
            {config ? ` (${config.organization})` : ''}. Test integration loads work item{' '}
            {config?.defaultWorkItemId ?? 780831}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          {workItem?.htmlUrl ? (
            <a className="btn btn-secondary" href={workItem.htmlUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              Open in ADO
            </a>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {config ? (
        <div className="muted" style={{ fontSize: '0.86rem' }}>
          Auth: {config.authMode === 'pat' ? 'ADO_PAT' : 'Azure CLI token'} · API:{' '}
          <a href={config.testWorkItemUrl} target="_blank" rel="noreferrer">
            {config.testWorkItemUrl}
          </a>
        </div>
      ) : null}

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
                    : workItem.fields.filter((row) => workItem.priorityFieldNames.includes(row.name))
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
