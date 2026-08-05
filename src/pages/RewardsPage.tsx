import { Trophy, Sparkles, Handshake, CircleCheck } from 'lucide-react'
import { MetricCard } from '../components/Badges'
import { useApp } from '../context/AppContext'
import { REWARD_POINTS } from '../types'
import { formatRelative } from '../lib/format'

const actionMeta = {
  constraint_created: {
    icon: Sparkles,
    label: 'Recorded a constraint',
    className: 'pill-medium',
  },
  engagement_started: {
    icon: Handshake,
    label: 'Engaged Capacity team',
    className: 'pill-investigation',
  },
  constraint_resolved: {
    icon: CircleCheck,
    label: 'Resolved a constraint',
    className: 'pill-ok',
  },
} as const

export function RewardsPage() {
  const { user, users, rewardEvents, getUserPoints } = useApp()
  const myPoints = getUserPoints(user.id)

  const leaderboard = [...users]
    .map((u) => ({ user: u, points: getUserPoints(u.id) }))
    .sort((a, b) => b.points - a.points)

  const myRank = leaderboard.findIndex((row) => row.user.id === user.id) + 1
  const myEvents = rewardEvents.filter((e) => e.userId === user.id)

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Rewards & bonus points</h3>
          <p>
            Earn points for proactive capacity work — recording constraints, engaging Capacity, and
            closing the loop when issues are resolved.
          </p>
        </div>
      </div>

      <div className="metrics">
        <MetricCard label="Your points" value={myPoints} hint={`Rank #${myRank} on the board`} />
        <MetricCard
          label="New constraint"
          value={`+${REWARD_POINTS.constraint_created}`}
          hint="Each time you record one"
          delay={60}
        />
        <MetricCard
          label="Engage Capacity"
          value={`+${REWARD_POINTS.engagement_started}`}
          hint="When you request help"
          delay={120}
        />
        <MetricCard
          label="Mark Resolved"
          value={`+${REWARD_POINTS.constraint_resolved}`}
          hint="When you close the loop"
          delay={180}
        />
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Leaderboard</h4>
              <p>Bonus points across the PCM team</p>
            </div>
            <Trophy size={18} color="#0e7c86" />
          </div>
          <div className="panel-body stack">
            {leaderboard.map((row, index) => {
              const isMe = row.user.id === user.id
              return (
                <div
                  key={row.user.id}
                  className={`list-row${isMe ? ' reward-leader-me' : ''}`}
                >
                  <div className="reward-rank">#{index + 1}</div>
                  <div className="avatar">{row.user.avatarInitials}</div>
                  <div style={{ flex: 1 }}>
                    <strong>
                      {row.user.name}
                      {isMe ? ' (you)' : ''}
                    </strong>
                    <div className="muted">{row.user.role}</div>
                  </div>
                  <strong className="reward-points-value">{row.points} pts</strong>
                </div>
              )
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Your reward activity</h4>
              <p>Points earned from proactive actions</p>
            </div>
          </div>
          <div className="panel-body stack">
            {myEvents.length === 0 ? (
              <div className="empty">
                No points yet — record a constraint, engage Capacity, or resolve an issue to start
                earning.
              </div>
            ) : (
              myEvents.map((event) => {
                const meta = actionMeta[event.action]
                const Icon = meta.icon
                return (
                  <div key={event.id} className="list-row">
                    <div className="reward-activity-icon">
                      <Icon size={16} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <strong>{event.label}</strong>
                      <div className="muted">{formatRelative(event.createdAt)}</div>
                    </div>
                    <span className={`pill ${meta.className}`}>+{event.points}</span>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
