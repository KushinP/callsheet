import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type {
  CallOutcome, CallingSession, Lead, LeadFilters, SessionStatus, SessionLead,
} from '@/lib/types'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'
import { useWorkspace } from './useWorkspace'

export function useSessions() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['sessions', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('calling_sessions')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('created_at', { ascending: false })

      if (error) throw error
      return (data ?? []) as CallingSession[]
    },
  })
}

export function useSession(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['session', sessionId],
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('calling_sessions')
        .select('*')
        .eq('id', sessionId!)
        .single()

      if (error) throw error
      return data as CallingSession
    },
  })
}

/** The ordered queue, with each lead's current details joined in. */
export function useSessionQueue(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['session-queue', sessionId],
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_leads')
        .select('*, leads(*)')
        .eq('session_id', sessionId!)
        .order('queue_order', { ascending: true })

      if (error) throw error
      return (data ?? []) as (SessionLead & { leads: Lead | null })[]
    },
  })
}

/** How many leads a filter would queue, before committing to a session. */
export function useSessionPreviewCount(filters: LeadFilters, enabled: boolean) {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['session-preview', workspaceId, filters],
    enabled: enabled && Boolean(workspaceId),
    queryFn: async () => {
      let query = supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId!)
        .eq('do_not_call', false)

      if (filters.search?.trim()) {
        query = query.ilike('search_blob', `%${filters.search.trim().toLowerCase()}%`)
      }
      if (filters.outcomes?.length) query = query.in('outcome', filters.outcomes)
      if (filters.city) query = query.ilike('city', filters.city)
      if (filters.state) query = query.ilike('state', filters.state)
      // These three were missing while the dialog above rendered controls for
      // all of them and build_session honoured them, so the preview promised a
      // number drawn from the whole list and the queue came back filtered.
      if (filters.stages?.length) query = query.in('pipeline_stage', filters.stages)
      if (filters.tiers?.length) query = query.in('tier', filters.tiers)
      if (filters.tags?.length) query = query.overlaps('tags', filters.tags)
      if (filters.never_called) query = query.is('last_called_at', null)
      if (filters.not_called_since) {
        query = query.or(`last_called_at.is.null,last_called_at.lt.${filters.not_called_since}`)
      }

      // Room bounds were applied by the Leads page and by neither the preview
      // nor build_session, so a list filtered to 12 rooms or fewer built a
      // queue that served a 23-room inn. All three now read the same bounds.
      if (filters.rooms_min !== undefined) query = query.gte('room_count', filters.rooms_min)
      if (filters.rooms_max !== undefined) query = query.lte('room_count', filters.rooms_max)
      if (filters.has_next_step !== undefined) {
        query = filters.has_next_step
          ? query.gt('open_task_count', 0)
          : query.eq('open_task_count', 0)
      }

      const { count, error } = await query
      if (error) throw error
      return count ?? 0
    },
  })
}

export function useCreateSession() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      name,
      filters,
      maxLeads,
      scriptId,
      recordCalls,
    }: {
      name: string
      filters: LeadFilters
      maxLeads: number
      scriptId?: string | null
      /** undefined leaves it inheriting the workspace default. */
      recordCalls?: boolean | null
    }): Promise<string> => {
      const { data, error } = await supabase.rpc('build_session', {
        ws: workspaceId,
        session_name: name,
        filters,
        max_leads: maxLeads,
      })

      if (error) throw error
      const sessionId = data as string

      // A follow-up update rather than extra parameters on build_session: a
      // defaulted parameter creates a SECOND PostgREST overload alongside the
      // existing 4-arg signature, and the session is pending with nobody
      // dialling it, so there is nothing to race with.
      if (scriptId !== undefined || recordCalls !== undefined) {
        const { error: patchError } = await supabase
          .from('calling_sessions')
          .update({
            ...(scriptId !== undefined ? { script_id: scriptId } : {}),
            ...(recordCalls !== undefined ? { record_calls: recordCalls } : {}),
          })
          .eq('id', sessionId)

        if (patchError) throw patchError
      }

      return sessionId
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not build the session')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
}

export function useUpdateSessionStatus() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: SessionStatus }) => {
      const patch: Record<string, unknown> = { status }
      if (status === 'active') patch.started_at = new Date().toISOString()
      if (status === 'completed') patch.completed_at = new Date().toISOString()

      const { error } = await supabase.from('calling_sessions').update(patch).eq('id', id)
      if (error) throw error
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not update the session')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void queryClient.invalidateQueries({ queryKey: ['session'] })
    },
  })
}

/** Marks one queue entry finished; a trigger recomputes session progress. */
export function useCompleteSessionLead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      id,
      outcome,
      status = 'done',
    }: {
      id: string
      outcome?: CallOutcome | null
      status?: 'done' | 'skipped' | 'dialing' | 'queued'
    }) => {
      const { error } = await supabase
        .from('session_leads')
        .update({
          status,
          outcome: outcome ?? null,
          completed_at: status === 'done' || status === 'skipped' ? new Date().toISOString() : null,
        })
        .eq('id', id)

      if (error) throw error
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not update the queue')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['session-queue'] })
      void queryClient.invalidateQueries({ queryKey: ['session'] })
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('calling_sessions').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      toast.success('Session deleted')
    },
    // Alone in this file in having neither, so a failed delete did nothing
    // visible at all — no toast, no row change.
    onError: (error) => toast.error(errorMessage(error, 'Could not delete that session')),
  })
}
