import { useApp } from '../context/AppContext'
import { formatDate, formatRelative } from '../lib/format'

export function AdminPage() {
  const { users, syncJobs, user } = useApp()
  const isAdmin = user.role === 'Administrator'

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Administration</h3>
          <p>Users & roles, data-source connections, and synchronisation freshness.</p>
        </div>
        {!isAdmin ? (
          <span className="pill pill-high">Viewing as {user.role} — switch to Administrator for full access</span>
        ) : (
          <span className="pill pill-ok">Administrator access</span>
        )}
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Users & RBAC</h4>
              <p>CSA · Capacity Manager · Administrator</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Email</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                        <div className="avatar" style={{ width: 32, height: 32, fontSize: '0.7rem' }}>
                          {u.avatarInitials}
                        </div>
                        <strong>{u.name}</strong>
                      </div>
                    </td>
                    <td className="muted">{u.email}</td>
                    <td>
                      <span className="pill pill-neutral">{u.role}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Data sources</h4>
              <p>Internal system + consent-based tenant connections</p>
            </div>
          </div>
          <div className="panel-body stack">
            {[
              {
                name: 'Internal Microsoft system',
                detail: 'Customers, inventory, quotas, CSA ownership',
                status: 'Connected',
              },
              {
                name: 'Customer Azure tenants',
                detail: 'ARM / Resource Graph · least-privilege read-only consent',
                status: 'Connected',
              },
              {
                name: 'Microsoft Entra ID',
                detail: 'OIDC / OAuth 2.0 SSO for Microsoft employees',
                status: 'Connected',
              },
              {
                name: 'Teams / Email alerts',
                detail: 'Microsoft Graph delivery channels',
                status: 'Configured',
              },
            ].map((src) => (
              <div key={src.name} className="list-row">
                <div style={{ flex: 1 }}>
                  <strong>{src.name}</strong>
                  <div className="muted">{src.detail}</div>
                </div>
                <span className="pill pill-ok">{src.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Synchronisation jobs</h4>
            <p>Configurable schedule with on-demand refresh and freshness stamps</p>
          </div>
          <button className="btn btn-secondary" disabled={!isAdmin}>
            Trigger on-demand refresh
          </button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Records</th>
              </tr>
            </thead>
            <tbody>
              {syncJobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <strong>{job.source}</strong>
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        job.status === 'Succeeded'
                          ? 'pill-ok'
                          : job.status === 'Running'
                            ? 'pill-medium'
                            : 'pill-critical'
                      }`}
                    >
                      {job.status}
                    </span>
                  </td>
                  <td className="muted">{formatDate(job.startedAt)}</td>
                  <td className="muted">
                    {job.finishedAt ? formatRelative(job.finishedAt) : 'In progress'}
                  </td>
                  <td>{job.recordsProcessed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
