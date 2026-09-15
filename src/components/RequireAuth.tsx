import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { canAccessPath } from '../auth/accounts'

export function RequireAuth() {
  const { session } = useAuth()
  const location = useLocation()

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  if (!canAccessPath(session.access, location.pathname)) {
    return <Navigate to="/forecast" replace />
  }

  return <Outlet />
}
