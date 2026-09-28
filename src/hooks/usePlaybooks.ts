import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import type { Playbook } from '@/lib/types'
import { errorMessage } from '@/lib/utils'
import { useWorkspace } from './useWorkspace'

export function usePlaybooks() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['playbooks', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('playbooks')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('trigger_stage', { ascending: true })

      if (error) throw error
      return (data ?? []) as Playbook[]
    },
  })
}

/**
 * Insert or update in one call.
 *
 * Every rule worth enforcing already lives in the database — at most eight
 * steps, unique ids, a known kind, negative offsets only against a real date —
 * so this deliberately validates nothing itself and lets the CHECK constraint
 * speak. Restating those rules here is how the two would drift.
 */
export function useSavePlaybook() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (playbook: Partial<Playbook> & { id?: string }) => {
      const row = { ...playbook, workspace_id: workspaceId }
      const { data, error } = playbook.id
        ? await supabase.from('playbooks').update(row).eq('id', playbook.id).select().single()
        : await supabase.from('playbooks').insert(row).select().single()

      if (error) throw error
      return data as Playbook
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['playbooks'] })
    },
    onError: (error) => toast.error(playbookError(error)),
  })
}

/**
 * One active playbook per stage, swapped in a single statement — the partial
 * unique index means deactivating and activating separately is transiently
 * invalid.
 */
export function useActivatePlaybook() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('activate_playbook', { ws: workspaceId, playbook: id })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['playbooks'] }),
    onError: (error) => toast.error(errorMessage(error, 'Could not activate that playbook')),
  })
}

export function useDeletePlaybook() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('playbooks').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['playbooks'] })
      toast.success('Playbook deleted')
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not delete that playbook')),
  })
}

/**
 * validate_playbook_steps() returns a readable sentence naming the offending
 * step; Postgres then wraps it in constraint boilerplate. Showing the sentence
 * is the whole reason the validator returns text rather than a boolean.
 */
function playbookError(error: unknown): string {
  const message = errorMessage(error, 'Could not save that playbook')
  if (message.includes('playbooks_steps_valid')) {
    return 'That playbook has a problem in one of its steps — check the ids, kinds and offsets.'
  }
  if (message.includes('playbooks_one_active_per_stage')) {
    return 'Another playbook is already active for that stage. Deactivate it first.'
  }
  if (message.includes('playbooks_stage_not_terminal')) {
    return 'Lost and Not a fit cancel work rather than creating it, so they cannot have a playbook.'
  }
  return message
}
