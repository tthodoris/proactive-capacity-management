import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  authenticateAppUser,
  type AppAccess,
  type AppAccount,
} from '../auth/accounts'

const STORAGE_KEY = 'pcm.appAuth'

export type AuthSession = {
  username: string
  displayName: string
  access: AppAccess
}

type AuthContextValue = {
  session: AuthSession | null
  isAdmin: boolean
  isGuest: boolean
  login: (username: string, password: string) =>
    | { ok: true; access: AppAccess }
    | { ok: false; error: string }
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function readStoredSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AuthSession
    if (!parsed?.username || !parsed?.access) return null
    return parsed
  } catch {
    return null
  }
}

function toSession(account: AppAccount): AuthSession {
  return {
    username: account.username,
    displayName: account.displayName,
    access: account.access,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(() => readStoredSession())

  const login = useCallback((username: string, password: string) => {
    const account = authenticateAppUser(username, password)
    if (!account) {
      return { ok: false as const, error: 'Invalid username or password.' }
    }
    const next = toSession(account)
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setSession(next)
    return { ok: true as const, access: account.access }
  }, [])

  const logout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY)
    setSession(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isAdmin: session?.access === 'admin',
      isGuest: session?.access === 'guest',
      login,
      logout,
    }),
    [session, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
