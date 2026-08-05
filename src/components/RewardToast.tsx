import { Trophy } from 'lucide-react'
import { useApp } from '../context/AppContext'

export function RewardToast() {
  const { latestReward, dismissRewardToast } = useApp()
  if (!latestReward) return null

  return (
    <div className="reward-toast" role="status" onClick={dismissRewardToast}>
      <div className="reward-toast-icon">
        <Trophy size={20} />
      </div>
      <div>
        <strong>+{latestReward.points} bonus points</strong>
        <p>{latestReward.label}</p>
      </div>
    </div>
  )
}
