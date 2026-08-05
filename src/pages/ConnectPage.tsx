import { TenantConnectPanel } from '../components/TenantConnectPanel'
import { useApp } from '../context/AppContext'

export function ConnectPage() {
  const { dataReady, dataError, inventory, quotas, customers, persistedConnection } = useApp()
  const connectedCustomers = customers.filter((c) => c.segment === 'Connected tenant')
  const liveInventory = inventory.filter((i) => i.id.startsWith('inv-live-')).length
  const liveQuotas = quotas.filter((q) => q.source && q.source !== 'Demo seed').length

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Azure tenant connect</h3>
          <p>
            Sign in with <code>az login --tenant</code>, select one or more subscriptions, then
            collect and store inventory and quota datasets in PostgreSQL.
          </p>
        </div>
      </div>

      {!dataReady ? (
        <div className="panel panel-body">
          <div className="empty">Loading persisted datasets from PostgreSQL…</div>
        </div>
      ) : null}

      {dataError ? (
        <div className="inline-error">
          Database sync issue: {dataError}. Working from local fallback until PostgreSQL is
          reachable.
        </div>
      ) : null}

      <div className="metrics">
        <div className="metric-card">
          <div className="label">Persisted customers</div>
          <div className="value">{customers.length}</div>
          <div className="hint">{connectedCustomers.length} from live tenants</div>
        </div>
        <div className="metric-card">
          <div className="label">Inventory rows</div>
          <div className="value">{inventory.length}</div>
          <div className="hint">{liveInventory} collected live</div>
        </div>
        <div className="metric-card">
          <div className="label">Quota rows</div>
          <div className="value">{quotas.length}</div>
          <div className="hint">{liveQuotas} collected live</div>
        </div>
        <div className="metric-card">
          <div className="label">Saved connection</div>
          <div className="value" style={{ fontSize: '1.05rem' }}>
            {persistedConnection?.organizationName ||
              persistedConnection?.tenantId ||
              'None'}
          </div>
          <div className="hint">{persistedConnection?.status || 'idle'}</div>
        </div>
      </div>

      <TenantConnectPanel />
    </div>
  )
}
