import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { callFunction, functionsUrl, supabase } from '@/lib/supabase'
import {
  transcriptOf,
  type CallOutcome, type CallStats, type DailyCallPoint, type DialCallLog,
  type MissedCall,
} from '@/lib/types'
import { errorMessage, localTimeZone } from '@/lib/utils'
import { useWorkspace } from './useWorkspace'

export const CALL_LOG_PAGE_SIZE = 50

/**
 * How long after a call a transcript is still plausibly on its way. Past this
 * the silence means it failed or was skipped, and polling for it is just noise.
 */
const TRANSCRIPT_GRACE_MS = 15 * 60 * 1000

/** Matches workspace_missed_calls()'s window, so the two agree by construction. */
export const MISSED_WINDOW_DAYS = 14

export function useCallLog(options: {
  page: number
  search?: string
  outcomes?: CallOutcome[]
  sessionId?: string | null
  leadId?: string | null
  direction?: 'inbound' | 'outbound' | null
  missedOnly?: boolean
  /** Since local midnight. Orthogonal to direction, so it is its own switch. */
  todayOnly?: boolean
}) {
  const { workspaceId } = useWorkspace()
  const { page, search, outcomes, sessionId, leadId, direction, missedOnly, todayOnly } = options

  return useQuery({
    queryKey: [
      'call-log', workspaceId, page, search, outcomes,
      sessionId, leadId, direction, missedOnly, todayOnly,
    ],
    enabled: Boolean(workspaceId),
    placeholderData: (previous) => previous,
    queryFn: async () => {
      let query = supabase
        .from('dial_call_logs')
        .select('*, call_transcripts(transcript_text, speaker_confidence)', { count: 'exact' })
        .eq('workspace_id', workspaceId!)

      if (search?.trim()) {
        // Commas and parentheses are PostgREST filter syntax, so they have to
        // come out before the term is interpolated into an or() expression.
        const term = search.trim().replace(/[(),\\]/g, ' ').trim()
        const digits = term.replace(/\D/g, '')

        const clauses = [`business_name.ilike.%${term}%`, `phone.ilike.%${term}%`]
        // Only match on the normalized column when the term actually contains
        // digits — an empty pattern here would be `ilike.%%`, which matches
        // every row and silently defeats the whole search.
        if (digits) clauses.push(`phone_normalized.ilike.%${digits}%`)

        if (term) query = query.or(clauses.join(','))
      }
      if (outcomes?.length) query = query.in('outcome', outcomes)
      if (todayOnly) {
        // Local midnight, not UTC. The dashboard's "calls today" counts the
        // rep's day in the workspace timezone, and a log that disagreed with
        // the card it was opened from would be worse than no filter.
        const midnight = new Date()
        midnight.setHours(0, 0, 0, 0)
        query = query.gte('called_at', midnight.toISOString())
      }
      if (sessionId) query = query.eq('session_id', sessionId)
      if (leadId) query = query.eq('lead_id', leadId)
      /*
       * The generated column answers "was this missed", which is not the same
       * question as "does this still need attention" — the one the dashboard
       * card asks. Matching it here (unhandled, within the same 14 days) is
       * what stops the badge, the card and this table quoting three different
       * numbers for the same word.
       */
      if (missedOnly) {
        const since = new Date(Date.now() - MISSED_WINDOW_DAYS * 86_400_000)
        query = query
          .eq('missed', true)
          .is('outcome', null)
          .gte('called_at', since.toISOString())
      }
      else if (direction) query = query.eq('direction', direction)

      const from = page * CALL_LOG_PAGE_SIZE
      const { data, error, count } = await query
        .order('called_at', { ascending: false })
        .range(from, from + CALL_LOG_PAGE_SIZE - 1)

      if (error) throw error
      return { calls: (data ?? []) as DialCallLog[], total: count ?? 0 }
    },
    /*
     * Transcription finishes about half a minute after the call does — the
     * audio has to be fetched from Twilio, offloaded, and run through the
     * model. This query had no refetch at all, so expanding a call you had
     * just hung up showed "No transcript for this call" and then went on
     * saying it until the page was reloaded.
     *
     * Poll only while something is actually pending, and stop as soon as
     * nothing is: a call log left open all day should not be asking for the
     * same rows every fifteen seconds forever.
     */
    refetchInterval: (query) => {
      const rows = query.state.data?.calls ?? []
      const pending = rows.some((call) =>
        call.recorded &&
        !transcriptOf(call) &&
        Date.now() - new Date(call.called_at).getTime() < TRANSCRIPT_GRACE_MS,
      )
      return pending ? 15_000 : false
    },
  })
}

/**
 * Missed inbound calls nobody has dealt with yet — no outcome set, and no
 * outbound call to that number since. Backs both the count in the Call Log and
 * the dashboard card, from one definition.
 */
export function useMissedCalls(sinceDays = 14) {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['missed-calls', workspaceId, sinceDays],
    enabled: Boolean(workspaceId),
    // These arrive by phone, not by anything this tab did, so poll rather than
    // wait for a mutation that is never going to come.
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('workspace_missed_calls', {
        ws: workspaceId,
        since_days: sinceDays,
      })
      if (error) throw error
      // A number that has since been called back has been dealt with. Filtering
      // here rather than in one of the two consumers is what stops the
      // dashboard card and the Call Log badge quoting different totals.
      return (data as MissedCall[]).filter((row) => !row.called_back)
    },
  })
}

/** Prior calls on a lead, shown on the lead card between dials. */
export function useLeadCallHistory(leadId: string | null | undefined) {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['lead-calls', leadId],
    enabled: Boolean(leadId && workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dial_call_logs')
        // The transcript rides along so the lead panel can open a call without
        // sending you to the Call Log to read what was said on it.
        .select('*, call_transcripts(transcript_text, speaker_confidence)')
        .eq('lead_id', leadId!)
        .order('called_at', { ascending: false })
        .limit(10)

      if (error) throw error
      return (data ?? []) as DialCallLog[]
    },
  })
}

/** Outcomes stay editable after the fact — an in-call tap is easy to fat-finger. */
export function useUpdateCallOutcome() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      callId,
      outcome,
      notes,
      leadId,
      callbackAt,
    }: {
      callId: string
      outcome: CallOutcome
      notes?: string
      leadId?: string | null
      /** Only ever set alongside callback_requested. Undefined leaves it alone. */
      callbackAt?: string | null
    }) => {
      // Before the outcome, so the playbook trigger it fires can see the hour
      // they gave rather than falling back to tomorrow morning.
      if (leadId && callbackAt !== undefined) {
        const { error: cbError } = await supabase
          .from('leads').update({ callback_at: callbackAt }).eq('id', leadId)
        if (cbError) throw cbError
      }

      const { error } = await supabase
        .from('dial_call_logs')
        .update({ outcome, ...(notes !== undefined ? { notes } : {}) })
        .eq('id', callId)

      if (error) throw error
      // leads.outcome is derived by a trigger from the newest call, so editing
      // an old one no longer stamps the lead with a stale result. leadId is
      // kept because the invalidations below still need it.
      void leadId
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['call-log'] })
      void queryClient.invalidateQueries({ queryKey: ['call-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      // Setting an outcome is precisely what un-misses a call, and it writes
      // leads.outcome, which the open lead sheet reads.
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-calls'] })
      void queryClient.invalidateQueries({ queryKey: ['missed-calls'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change that outcome')),
  })
}

/**
 * The note on a past call.
 *
 * Separate from useUpdateCallOutcome, which demands an outcome and also writes
 * leads.outcome — re-asserting a disposition is not what writing a note means,
 * and it would overwrite the lead's current state with the result of an old
 * call.
 *
 * Until this existed the only way to attach a note was to type it into the
 * disposition bar in the seconds before tapping an outcome. Miss that window
 * and the thought was gone: the bar disappears with the disposition, and
 * nothing else could write the column.
 */
export function useUpdateCallNote() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ callId, notes }: { callId: string; notes: string }) => {
      const { error } = await supabase
        .from('dial_call_logs')
        // Empty clears it rather than storing '', so "has a note" stays a
        // question the database can answer.
        .update({ notes: notes.trim() || null })
        .eq('id', callId)

      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['call-log'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-calls'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not save that note')),
  })
}

/**
 * Delete call logs.
 *
 * Takes a list because clearing test calls or a run of misdials one row at a
 * time is the common case. Transcripts cascade with the call; a database
 * trigger recomputes each affected lead's call_count and last_called_at from
 * the rows that remain.
 */
export function useDeleteCalls() {
  const queryClient = useQueryClient()
  const { workspaceId } = useWorkspace()

  return useMutation({
    // Through an edge function, not a plain delete: the audio lives in R2, and
    // only the server holds the keys to remove it along with the row.
    mutationFn: async (callIds: string[]) => {
      if (callIds.length === 0) return 0
      const result = await callFunction<{
        deleted: number; audio_deleted: number; audio_failed: number
      }>('delete-calls', { workspace_id: workspaceId, call_ids: callIds })
      if (result.audio_failed > 0) {
        toast.warning(
          `${result.audio_failed} ${result.audio_failed === 1 ? 'recording' : 'recordings'} ` +
          'could not be removed from storage — the calls themselves are gone.',
        )
      }
      return result.deleted
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['call-log'] })
      void queryClient.invalidateQueries({ queryKey: ['call-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['daily-calls'] })
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-calls'] })
      void queryClient.invalidateQueries({ queryKey: ['missed-calls'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not delete those calls')),
  })
}

export function useCallStats() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['call-stats', workspaceId],
    enabled: Boolean(workspaceId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('workspace_call_stats', {
        ws: workspaceId,
        tz: localTimeZone(),
      })
      if (error) throw error
      return data as CallStats
    },
  })
}

export function useDailyCalls(days = 14) {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['daily-calls', workspaceId, days],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('workspace_daily_calls', {
        ws: workspaceId,
        days,
        tz: localTimeZone(),
      })
      if (error) throw error
      return (data ?? []) as DailyCallPoint[]
    },
  })
}

/** Signed-in-user-scoped audio URL for a recording. */
export function useRecordingUrl() {
  const { workspaceId } = useWorkspace()

  return async (callId: string): Promise<string> => {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) throw new Error('Not signed in')

    const url = new URL(`${functionsUrl}/recording-proxy`)
    url.searchParams.set('ws', workspaceId!)
    url.searchParams.set('log', callId)

    // <audio src> cannot carry an Authorization header, so fetch the bytes and
    // hand the element a blob instead.
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      const detail = await response.json().catch(() => ({ error: 'Recording unavailable' }))
      throw new Error((detail as { error?: string }).error ?? 'Recording unavailable')
    }

    return URL.createObjectURL(await response.blob())
  }
}
