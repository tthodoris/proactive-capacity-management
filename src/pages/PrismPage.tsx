import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, ExternalLink, RefreshCw, Search, X } from 'lucide-react'
import {
  fetchPrismCapacityBank,
  fetchPrismConfig,
  fetchPrismPing,
  type PrismCapacityBankResult,
  type PrismConfig,
} from '../lib/prismApi'

function cellValue(value: unknown) {
  if (value == null || value === '') return '—'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function PrismPage() {
  const [config, setConfig] = useState<PrismConfig | null>(null)
  const [data, setData] = useState<PrismCapacityBankResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [pinging, setPinging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pingNote, setPingNote] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fetchPrismConfig())
    } catch {
      // Config is best-effort; CapacityBank error is primary.
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setPingNote(null)
    try {
      await loadConfig()
      const nextData = await fetchPrismCapacityBank({ take: 1000 })
      setData(nextData)
    } catch (err) {
      setData(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [loadConfig])

  const runPing = useCallback(async () => {
    setPinging(true)
    setPingNote(null)
    try {
      await loadConfig()
      const result = await fetchPrismPing()
      const names = (result.databases || [])
        .map((row) => String(row.DatabaseName || row.Name || Object.values(row)[0] || ''))
        .filter(Boolean)
      setPingNote(
        `Ping OK via ${result.authSource} · token ${result.tokenResource} · ${names.length} database(s)${
          names.length ? `: ${names.slice(0, 8).join(', ')}` : ''
        }`,
      )
    } catch (err) {
      setPingNote(err instanceof Error ? err.message : String(err))
    } finally {
      setPinging(false)
    }
  }, [loadConfig])

  useEffect(() => {
    void load()
  }, [load])

  const columns = data?.columns || []
  const rows = useMemo(() => {
    const items = data?.rows || []
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((row) =>
      columns.some((col) => cellValue(row[col.name]).toLowerCase().includes(q)),
    )
  }, [data?.rows, columns, query])

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>PRISM</h3>
          <p>
            CapacityBank from Azure Data Explorer cluster{' '}
            <strong>{config?.cluster || 'azprism.westus2'}</strong>
            {config ? ` / database ${config.database}` : ''}. Queried with the API container
            user-assigned managed identity ({`CapacityBank | take 1000`}).
          </p>
          {config ? (
            <p className="muted" style={{ marginTop: '0.45rem' }}>
              Token audience: <code>{config.tokenResource}</code>
              {' · '}
              UAMI client id:{' '}
              {config.managedIdentityClientIdConfigured
                ? `…${config.managedIdentityClientIdSuffix}`
                : 'not set (AZURE_CLIENT_ID / PRISM_MANAGED_IDENTITY_CLIENT_ID)'}
            </p>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {config?.explorerUrl ? (
            <a
              className="btn btn-ghost"
              href={config.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} />
              Open ADX
            </a>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void runPing()}
            disabled={pinging || loading}
          >
            {pinging ? 'Pinging…' : 'Ping cluster'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={16} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? (
        <section className="panel">
          <div className="panel-body">
            <strong>Could not load PRISM CapacityBank</strong>
            <p style={{ marginTop: '0.55rem' }}>{error}</p>
            <p className="muted" style={{ marginTop: '0.55rem' }}>
              ADX 404 usually means wrong Cluster URI or database name. 401/403 means the
              user-assigned identity is not authorized (also check PRISM{' '}
              <code>trustedExternalTenants</code> for cross-tenant). Token audience must be{' '}
              <code>https://kusto.kusto.windows.net</code>, not the cluster URI.
            </p>
          </div>
        </section>
      ) : null}

      {pingNote ? (
        <section className="panel">
          <div className="panel-body">
            <strong>Cluster ping</strong>
            <p style={{ marginTop: '0.55rem' }}>{pingNote}</p>
          </div>
        </section>
      ) : null}

      <div className="filters" style={{ alignItems: 'center' }}>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search CapacityBank rows"
          />
        </div>
        {query ? (
          <button className="btn btn-ghost" type="button" onClick={() => setQuery('')}>
            <X size={16} /> Clear
          </button>
        ) : null}
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>
              <Database size={16} style={{ marginRight: '0.35rem', verticalAlign: 'text-bottom' }} />
              CapacityBank
            </h4>
            <p>
              {loading
                ? 'Querying PRISM…'
                : data
                  ? `${rows.length} of ${data.total} rows · auth: ${data.authSource} · ${new Date(data.retrievedAt).toLocaleString()}`
                  : 'No data loaded'}
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.name}>{col.name}</th>
                ))}
                {!columns.length ? <th>Columns</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((col) => (
                    <td key={col.name}>{cellValue(row[col.name])}</td>
                  ))}
                </tr>
              ))}
              {!loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(columns.length, 1)}>
                    <div className="empty">
                      {data ? 'No rows match the current search.' : 'No PRISM rows loaded yet.'}
                    </div>
                  </td>
                </tr>
              ) : null}
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(columns.length, 1)}>
                    <div className="empty">Querying Azure Data Explorer…</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
