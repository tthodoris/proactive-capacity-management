import type { ConstraintSeverity, ConstraintStatus } from '../types'

const statusClass: Record<ConstraintStatus, string> = {
  Open: 'pill-open',
  'Under investigation': 'pill-investigation',
  Mitigating: 'pill-mitigating',
  Resolved: 'pill-resolved',
}

const severityClass: Record<ConstraintSeverity, string> = {
  Critical: 'pill-critical',
  High: 'pill-high',
  Medium: 'pill-medium',
  Low: 'pill-low',
}

export function StatusBadge({ status }: { status: ConstraintStatus }) {
  return <span className={`pill ${statusClass[status]}`}>{status}</span>
}

export function SeverityBadge({ severity }: { severity: ConstraintSeverity }) {
  return <span className={`pill ${severityClass[severity]}`}>{severity}</span>
}

export function MetricCard({
  label,
  value,
  hint,
  delay = 0,
}: {
  label: string
  value: string | number
  hint?: string
  delay?: number
}) {
  return (
    <div className="metric-card" style={{ animationDelay: `${delay}ms` }}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}
