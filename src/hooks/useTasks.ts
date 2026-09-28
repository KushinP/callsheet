import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import type { FunnelRow, PipelineStage, Task } from '@/lib/types'
import { errorMessage } from '@/lib/utils'
import { useWorkspace } from './useWorkspace'

const TASK_FIELDS =
  'id, workspace_id, lead_id, title, body_md, kind, status, due_at, source, ' +
  'snooze_count, closed_at, closed_by, outcome_note, created_at, updated_at, ' +
  'leads(id, business_name, phone)'

/** Open work, soonest first. The dashboard's whole job is "what is due". */
export function useTasks(options: { status?: 'open' | 'done' | 'cancelled'; leadId?: string } = {}) {
  const { workspaceId } = useWorkspace()
  const { status = 'open', leadId } = options

  return useQuery({
    queryKey: ['tasks', workspaceId, status, leadId ?? null],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      let q = supabase
        .from('tasks')
        .select(TASK_FIELDS)
        .eq('workspace_id', workspaceId!)
        .eq('status', status)
        .order('due_at', { ascending: true })

      if (leadId) q = q.eq('lead_id', leadId)

      const { data, error } = await q
      if (error) throw error
      return (data ?? []) as unknown as Task[]
    },
  })
}

export function useFunnel() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['funnel', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('workspace_funnel', { ws: workspaceId })
      if (error) throw error
      return (data ?? []) as FunnelRow[]
    },
  })
}

export interface PipelineFlowRow {
  /** Furthest chain stage this group can be proven to have reached. */
  reached: PipelineStage
  /** The setback or exit it left as, or null if it is still sitting at `reached`. */
  exited_as: PipelineStage | null
  /** Whether anything is actually queued for it — an open task. */
  has_next_step: boolean
  /**
   * For a worked lead with nothing queued: its last call's outcome, or
   * 'no_call_logged' / 'no_outcome'. Null for every other lead.
   */
  stall_reason: string | null
  /**
   * Whether this path was observed or reconstructed.
   *
   * False only for leads that predate lead_stage_events, where the table can
   * say where they ended up but not how they got there.
   */
  exact: boolean
  leads: number
}

/**
 * The pipeline as flows rather than a row of counts.
 *
 * Separate from useFunnel, which answers "how many are sitting here". This one
 * answers "of everything that came in, how far did it get and where did it
 * leave" — a different question, and the only one a Sankey can honestly draw.
 *
 * Read from lead_stage_events, so it is a record rather than an inference.
 */
export function usePipelineFlow() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['pipeline-flow', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('workspace_pipeline_flow', { ws: workspaceId })
      if (error) throw error
      return (data ?? []) as PipelineFlowRow[]
    },
  })
}

/**
 * Completing a task records what was done, not just that it was done.
 * `outcome_note` is required by the same argument as the MCP tool: a tick with
 * no record is not worth storing.
 */
export function useCompleteTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note: string }) => {
      const { error } = await supabase
        .from('tasks')
        .update({
          status: 'done',
          closed_at: new Date().toISOString(),
          closed_by: 'human',
          outcome_note: note,
        })
        .eq('id', id)

      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    onError: (error) => toast.error(errorMessage(error, 'Could not complete that task')),
  })
}

export function useCreateTask() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (task: {
      title: string
      due_at: string
      lead_id?: string | null
      body_md?: string | null
      kind?: string
    }) => {
      const { error } = await supabase.from('tasks').insert({
        workspace_id: workspaceId,
        source: 'human',
        kind: 'other',
        ...task,
      })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    onError: (error) => toast.error(errorMessage(error, 'Could not create that task')),
  })
}

/**
 * Pushes a task back, through the same RPC the connector uses — so the
 * three-snooze ceiling and the reason trail apply to a human too. They used to
 * live only inside the MCP tool, which meant Claude was held to a rule the app
 * could ignore.
 */
export function useSnoozeTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, dueAt, reason }: { id: string; dueAt: string; reason: string }) => {
      const { error } = await supabase.rpc('snooze_task', {
        task: id, new_due: dueAt, reason,
      })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    onError: (error) => toast.error(errorMessage(error, 'Could not snooze that task')),
  })
}

/** Stage changes fire playbooks, so this invalidates tasks as well as leads. */
export function useSetLeadStage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: string }) => {
      const { error } = await supabase
        .from('leads')
        .update({ pipeline_stage: stage })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['funnel'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change the stage')),
  })
}

/**
 * Playbook steps that cannot be scheduled until the lead has an appointment
 * date. They are deferred correctly and silently — the playbook lists four
 * steps, the lead shows two tasks, and nothing joins the two facts up.
 */
export function usePendingSteps(leadId: string | null | undefined) {
  return useQuery({
    queryKey: ['pending-steps', leadId],
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('lead_pending_steps', { lead_id: leadId })
      if (error) throw error
      return (data as number) ?? 0
    },
  })
}
