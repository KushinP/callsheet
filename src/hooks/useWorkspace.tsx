import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createContext, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { supabase } from '@/lib/supabase'
import type { TwilioSettings, Workspace, WorkspaceRole } from '@/lib/types'
import { useAuth } from './useAuth'

const ACTIVE_WORKSPACE_KEY = 'cs.active_workspace'

type ActiveWorkspace = Workspace & { role: WorkspaceRole }

interface WorkspaceContextValue {
  workspace: ActiveWorkspace | null
  workspaceId: string | null
  role: WorkspaceRole | null
  isAdmin: boolean
  workspaces: ActiveWorkspace[]
  twilio: TwilioSettings | null
  twilioReady: boolean
  loading: boolean
  setWorkspaceId: (id: string) => void
  refreshTwilio: () => void
  /** Re-reads the workspace row after changing something on it. */
  refreshWorkspaces: () => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, initialized } = useAuth()
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_WORKSPACE_KEY),
  )

  const membershipsQuery = useQuery({
    queryKey: ['workspaces', user?.id],
    enabled: initialized && Boolean(user),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_members')
        .select('role, workspaces(id, name, created_by, created_at, recording_enabled, calendly_url, monthly_minute_budget, forward_to_number, record_inbound, answer_inbound, voice_agent_number, timezone, min_rooms)')
        .order('created_at', { ascending: true })

      if (error) throw error

      return (data ?? [])
        .filter((row) => row.workspaces)
        .map((row) => ({
          ...(row.workspaces as unknown as Workspace),
          role: row.role as WorkspaceRole,
        }))
    },
  })

  const workspaces = useMemo(() => membershipsQuery.data ?? [], [membershipsQuery.data])

  // Fall back to the first workspace whenever the stored one is gone (or this
  // is a brand-new signup that has never picked one).
  const resolvedId = useMemo(() => {
    if (workspaces.length === 0) return null
    if (activeId && workspaces.some((w) => w.id === activeId)) return activeId
    return workspaces[0].id
  }, [workspaces, activeId])

  useEffect(() => {
    if (resolvedId && resolvedId !== activeId) {
      setActiveId(resolvedId)
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, resolvedId)
    }
  }, [resolvedId, activeId])


  const twilioQuery = useQuery({
    queryKey: ['twilio-settings', resolvedId],
    enabled: Boolean(resolvedId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_twilio_settings')
        .select('*')
        .eq('workspace_id', resolvedId!)
        .maybeSingle()

      if (error) throw error
      return (data as TwilioSettings | null) ?? null
    },
  })

  const active = workspaces.find((w) => w.id === resolvedId) ?? null

  // Playbook due dates are resolved by a database trigger, which has no caller
  // to ask for a timezone. Left at the 'UTC' default every task lands at 9am UTC
  // — 4am in Texas — and is overdue the moment it is created. The browser knows
  // the answer, so adopt it once rather than making someone find a setting they
  // do not know is broken.
  useEffect(() => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!active || !browserZone || browserZone === 'UTC') return
    if (active.timezone !== 'UTC') return

    void supabase
      .from('workspaces')
      .update({ timezone: browserZone })
      .eq('id', active.id)
      .then(() => queryClient.invalidateQueries({ queryKey: ['workspaces'] }))
  }, [active, queryClient])

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspace: active,
      workspaceId: resolvedId,
      role: active?.role ?? null,
      isAdmin: active?.role === 'owner' || active?.role === 'admin',
      workspaces,
      twilio: twilioQuery.data ?? null,
      twilioReady: Boolean(twilioQuery.data?.is_configured),
      loading: membershipsQuery.isLoading,
      setWorkspaceId(id) {
        setActiveId(id)
        localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
        queryClient.clear()
      },
      refreshTwilio() {
        void queryClient.invalidateQueries({ queryKey: ['twilio-settings'] })
      },
      async refreshWorkspaces() {
        await queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      },
    }),
    [active, resolvedId, workspaces, twilioQuery.data, membershipsQuery.isLoading, queryClient],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  return ctx
}
