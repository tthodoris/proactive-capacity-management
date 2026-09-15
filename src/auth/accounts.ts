export type AppAccess = 'admin' | 'guest'

export type AppAccount = {
  username: string
  password: string
  access: AppAccess
  displayName: string
}

/** Simple local demo accounts (not Entra). */
export const APP_ACCOUNTS: AppAccount[] = [
  {
    username: 'ttsironis',
    password: 'pcm-admin',
    access: 'admin',
    displayName: 'Theodoros Tsironis',
  },
  {
    username: 'guest',
    password: 'guest',
    access: 'guest',
    displayName: 'Guest',
  },
]

export function authenticateAppUser(username: string, password: string): AppAccount | null {
  const user = username.trim().toLowerCase()
  const pass = password
  return (
    APP_ACCOUNTS.find(
      (a) => a.username.toLowerCase() === user && a.password === pass,
    ) || null
  )
}

export function isForecastPath(pathname: string) {
  return pathname === '/forecast' || pathname.startsWith('/forecast/')
}

export function canAccessPath(access: AppAccess, pathname: string) {
  if (access === 'admin') return true
  return isForecastPath(pathname)
}
