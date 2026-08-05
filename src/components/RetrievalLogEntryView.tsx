import { formatDate } from '../lib/format'
import type { RetrievalLogEntry } from '../types/retrieval'

export function RetrievalLogEntryView({
  entry,
  showUser = false,
}: {
  entry: RetrievalLogEntry
  showUser?: boolean
}) {
  const context = [
    showUser ? `User ${entry.initiatedByName}` : null,
    entry.customerName && showUser ? `Customer ${entry.customerName}` : null,
    entry.subscriptionName
      ? `Subscription ${entry.subscriptionName}`
      : showUser
        ? null
        : 'All selected subscriptions',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={`retrieval-log-entry level-${entry.level}`}>
      <div className="retrieval-log-meta">
        <time dateTime={entry.at}>{formatDate(entry.at)}</time>
        <span className="pill pill-neutral">{entry.kind}</span>
        <span className={`pill level-pill-${entry.level}`}>{entry.level}</span>
      </div>
      <div className="retrieval-log-body">
        <strong>{entry.message}</strong>
        {context ? <div className="muted">{context}</div> : null}
        {entry.details ? (
          <div
            className={
              entry.level === 'error' || entry.level === 'warn'
                ? 'retrieval-log-details'
                : 'muted'
            }
          >
            {entry.details}
          </div>
        ) : null}
      </div>
    </div>
  )
}
