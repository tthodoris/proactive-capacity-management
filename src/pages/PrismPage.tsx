import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, ExternalLink, RefreshCw, Search, X } from 'lucide-react'
import {
  fetchPrismCapacityBank,
  fetchPrismConfig,
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
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextConfig, nextData] = await Promise.all([
        fetchPrismConfig(),
        fetchPrismCapacityBank({ take: 1000 }),
      ])
      setConfig(nextConfig)
      setData(nextData)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

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
              Confirm the container user-assigned identity is authorized on the PRISM ADX cluster
              and that AZURE_CLIENT_ID / PRISM_MANAGED_IDENTITY_CLIENT_ID is set to that identity.
            </p>
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
