import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { CallScript, ScriptBlock } from '@/lib/types'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'
import { useWorkspace } from './useWorkspace'

export function useScripts() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['scripts', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('call_scripts')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('is_default', { ascending: false })
        .order('updated_at', { ascending: false })

      if (error) throw error
      return (data ?? []) as CallScript[]
    },
  })
}

/**
 * The script a session should run: the one pinned to it, else the workspace
 * default, else none. Resolved in one place so the dialer and the session page
 * can never disagree about which script is live.
 */
export function useSessionScript(sessionScriptId: string | null | undefined) {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['session-script', workspaceId, sessionScriptId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      if (sessionScriptId) {
        const { data } = await supabase
          .from('call_scripts').select('*').eq('id', sessionScriptId).maybeSingle()
        if (data) return data as CallScript
      }
      const { data } = await supabase
        .from('call_scripts')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .eq('is_default', true)
        .maybeSingle()
      return (data as CallScript | null) ?? null
    },
  })
}

export interface ScriptInput {
  id?: string
  name: string
  description?: string | null
  blocks: ScriptBlock[]
  entry_block_id: string
  variables?: string[]
}

export function useSaveScript() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: ScriptInput) => {
      const row = {
        workspace_id: workspaceId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        blocks: input.blocks,
        entry_block_id: input.entry_block_id,
        ...(input.variables ? { variables: input.variables } : {}),
      }

      const query = input.id
        ? supabase.from('call_scripts').update(row).eq('id', input.id)
        : supabase.from('call_scripts').insert(row)

      const { data, error } = await query.select().single()

      if (error) {
        // The CHECK constraint carries a specific reason from
        // validate_script_blocks(); surface it instead of "violates constraint".
        if (error.message.includes('call_scripts_blocks_valid')) {
          throw new Error('That script is not valid. Check that every branch points at a real block.')
        }
        if (error.code === '23505') {
          throw new Error(`A script named "${input.name.trim()}" already exists.`)
        }
        throw error
      }
      return data as CallScript
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scripts'] })
      void queryClient.invalidateQueries({ queryKey: ['script'] })
      void queryClient.invalidateQueries({ queryKey: ['session-script'] })
    },
  })
}

export function useSetDefaultScript() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (scriptId: string) => {
      const { error } = await supabase.rpc('set_default_script', {
        ws: workspaceId, script: scriptId,
      })
      if (error) throw error
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not set the default script')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scripts'] })
      void queryClient.invalidateQueries({ queryKey: ['session-script'] })
    },
  })
}

export function useDeleteScript() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (scriptId: string) => {
      const { error } = await supabase.from('call_scripts').delete().eq('id', scriptId)
      if (error) throw error
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not delete the script')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scripts'] })
      void queryClient.invalidateQueries({ queryKey: ['session-script'] })
    },
  })
}

/** Attach a script to a session, or clear it to fall back to the default. */
export function useSetSessionScript() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ sessionId, scriptId }: { sessionId: string; scriptId: string | null }) => {
      const { error } = await supabase
        .from('calling_sessions').update({ script_id: scriptId }).eq('id', sessionId)
      if (error) throw error
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change the script')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['session'] })
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void queryClient.invalidateQueries({ queryKey: ['session-script'] })
    },
  })
}
