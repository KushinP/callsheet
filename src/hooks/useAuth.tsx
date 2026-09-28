import type { Session, User } from '@supabase/supabase-js'
import {
  createContext, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { supabase } from '@/lib/supabase'

interface AuthContextValue {
  session: Session | null
  user: User | null
  /**
   * False until Supabase has restored (or ruled out) a persisted session.
   * Every route guard waits on this — redirecting while auth is still unknown
   * is what produces login/dashboard redirect loops.
   */
  initialized: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, fullName: string, workspaceName: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    let active = true

    // Subscribe before the initial read so a token refresh landing mid-flight
    // is not missed.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return
      setSession(next)
      setInitialized(true)
    })

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setInitialized(true)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      initialized,

      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      },

      async signUp(email, password, fullName, workspaceName) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          // handle_new_user() reads these to name the profile and the
          // workspace it creates for this signup.
          options: { data: { full_name: fullName, workspace_name: workspaceName } },
        })
        if (error) throw error
      },

      async signOut() {
        await supabase.auth.signOut()
      },
    }),
    [session, initialized],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
