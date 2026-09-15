import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { session, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const from =
    (location.state as { from?: string } | null)?.from ||
    (session?.access === 'guest' ? '/forecast' : '/')

  if (session) {
    return <Navigate to={session.access === 'guest' ? '/forecast' : from} replace />
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const result = login(username, password)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const next =
      result.access === 'guest'
        ? '/forecast'
        : from && from !== '/login'
          ? from
          : '/'
    navigate(next, { replace: true })
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark">PCM</div>
          <div>
            <h1>Proactive Capacity</h1>
            <p>Sign in to continue</p>
          </div>
        </div>

        <form className="login-form" onSubmit={onSubmit}>
          <label className="field">
            <span>Username</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
            />
          </label>
          {error ? <div className="login-error">{error}</div> : null}
          <button type="submit" className="btn btn-primary login-submit">
            Sign in
          </button>
        </form>

        <div className="login-hint muted">
          <div>
            <strong>Admin:</strong> ttsironis / pcm-admin
          </div>
          <div>
            <strong>Guest:</strong> guest / guest (Capacity forecast only)
          </div>
        </div>
      </div>
    </div>
  )
}
