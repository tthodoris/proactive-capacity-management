import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { SeverityBadge, StatusBadge } from './Badges'
import { formatDate, prettyRegion } from '../lib/format'
import type { CapacityConstraint } from '../types'

export function ConstraintBriefModal({
  constraints,
  contextLabel,
  onClose,
}: {
  constraints: CapacityConstraint[]
  contextLabel?: string
  onClose: () => void
}) {
  const items = constraints.length > 0 ? constraints : []

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content constraint-brief-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>Capacity constraint{items.length === 1 ? '' : 's'}</h3>
            {contextLabel ? <p className="muted" style={{ margin: '0.25rem 0 0' }}>{contextLabel}</p> : null}
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body stack" style={{ gap: '0.85rem' }}>
          {items.length === 0 ? (
            <p className="muted">No open capacity constraints match this service / SKU in the selected region.</p>
          ) : (
            items.map((c) => (
              <article key={c.id} className="constraint-brief-card">
                <div className="constraint-brief-top">
                  <div>
                    <strong>{c.sku}</strong>
                    <div className="muted" style={{ fontSize: '0.82rem' }}>
                      {c.resourceType}
                    </div>
                  </div>
                  <div className="constraint-brief-badges">
                    <SeverityBadge severity={c.severity} />
                    <StatusBadge status={c.status} />
                  </div>
                </div>
                <div className="constraint-brief-meta muted">
                  <div>
                    <span className="constraint-brief-label">Regions</span>
                    {(c.regions || []).map((r) => prettyRegion(r)).join(', ') || '—'}
                  </div>
                  <div>
                    <span className="constraint-brief-label">Source</span>
                    {c.source || '—'}
                  </div>
                  <div>
                    <span className="constraint-brief-label">Updated</span>
                    {c.updatedAt ? formatDate(c.updatedAt) : '—'}
                  </div>
                </div>
                {c.description ? (
                  <p className="constraint-brief-desc">{c.description}</p>
                ) : null}
                <div>
                  <Link to={`/constraints/${c.id}`} className="btn btn-ghost" onClick={onClose}>
                    Open constraint record
                  </Link>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
