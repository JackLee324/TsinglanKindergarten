import { useContext } from 'react'
import { AuthContext, type AuthState } from './AuthProvider'

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
