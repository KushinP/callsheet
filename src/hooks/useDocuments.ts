import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { callFunction, supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/utils'
import { useWorkspace } from './useWorkspace'

export type DocumentKind = 'weekly_report' | 'daily_report' | 'lead_brief' | 'call_analysis'

export interface CallsheetDocument {
  id: string
  workspace_id: string
  kind: DocumentKind
  lead_id: string | null
  call_id: string | null
  title: string
  body_md: string
  summary_json: Record<string, unknown>
  period_start: string | null
  period_end: string | null
  author: 'claude' | 'system' | 'human'
  model: string | null
  cost_usd: string | null
  created_at: string
  updated_at: string
}

const REPORT_KINDS: DocumentKind[] = ['weekly_report', 'daily_report']

/**
 * Each hook pins its own kind. The table is polymorphic by design, so a
 * forgotten `kind` filter would render a weekly report inside a lead panel —
 * keeping the filter here means no caller can omit it.
 */
export function useReports() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['documents', 'reports', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .in('kind', REPORT_KINDS)
        .order('period_start', { ascending: false })

      if (error) throw error
      return (data ?? []) as CallsheetDocument[]
    },
  })
}

export function useLeadBrief(leadId: string | null | undefined) {
  return useQuery({
    queryKey: ['documents', 'lead_brief', leadId],
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('*')
        .eq('lead_id', leadId!)
        .eq('kind', 'lead_brief')
        .maybeSingle()

      if (error) throw error
      return (data as CallsheetDocument | null) ?? null
    },
  })
}

export function useDeleteDocument() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('documents').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['documents'] }),
    onError: (error) => toast.error(errorMessage(error, 'Could not delete that document')),
  })
}

export interface BriefRun {
  available: boolean
  generated: number
  failed: number
  remaining: number
  cost_usd?: number
  reason?: string
  error?: string
}

/**
 * Generates pre-call briefs for leads that have none.
 *
 * Loops rather than firing once: the edge function caps its own batch so an
 * import of thousands does not become thousands of model calls in one
 * invocation, and it reports what is left. Stops on its own when the queue
 * drains, when nothing is configured, or when a pass makes no progress.
 */
export function useGenerateBriefs() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (opts?: { onProgress?: (done: number, remaining: number) => void }) => {
      let generated = 0
      let failed = 0
      let cost = 0

      for (let pass = 0; pass < 40; pass += 1) {
        const run = await callFunction<BriefRun>('generate-lead-briefs', { workspaceId })

        // A missing key is a silent no-op by contract, not an error.
        if (!run.available) return { available: false, generated, failed, cost, reason: run.reason }

        // A malformed or errored response has no counters. Without this the
        // arithmetic goes NaN, neither break condition matches, and the loop
        // hammers the endpoint forty times over.
        if (typeof run.generated !== 'number' || typeof run.remaining !== 'number') {
          throw new Error(run.error ?? 'The brief generator returned an unexpected response.')
        }

        generated += run.generated
        failed += run.failed ?? 0
        cost += run.cost_usd ?? 0
        opts?.onProgress?.(generated, run.remaining)

        if (run.error) throw new Error(run.error)
        if (run.remaining === 0) break
        // No progress with work still outstanding means the whole batch failed;
        // another identical pass would only burn money.
        if (run.generated === 0) break
      }

      return { available: true, generated, failed, cost }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not generate briefs')),
  })
}
