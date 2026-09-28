import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { ImportResult, Lead, LeadFilters } from '@/lib/types'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'
import { useWorkspace } from './useWorkspace'

export const LEADS_PAGE_SIZE = 50

export type LeadSort =
  | 'created_desc' | 'created_asc'
  | 'name_asc' | 'name_desc'
  | 'phone_asc' | 'phone_desc'
  | 'location_asc' | 'location_desc'
  | 'stage_asc' | 'stage_desc'
  | 'outcome_asc' | 'outcome_desc'
  | 'tier_asc' | 'tier_desc'
  | 'tags_asc' | 'tags_desc'
  | 'last_called_desc' | 'last_called_asc'

interface OrderClause {
  column: string
  ascending: boolean
  nullsFirst?: boolean
}

/*
 * One entry per sort the table offers, and the only place the mapping lives —
 * the URL whitelist and the dropdown both read their keys from here so a sort
 * cannot exist in one and not the others.
 *
 * Sorted on phone_normalized rather than phone: the raw column holds whatever
 * was typed or imported, so "(555) 010-4821" and "5550102233" sort into
 * different universes. The normalized column groups by area code, which is what
 * anyone clicking a phone header actually wants.
 *
 * Enum columns sort by enum position, not alphabetically — so Stage comes out
 * in pipeline order and Tier in A, B, C. That is the whole reason those are
 * enums.
 */
const SORTS: Record<LeadSort, OrderClause[]> = {
  created_desc: [{ column: 'created_at', ascending: false }],
  created_asc: [{ column: 'created_at', ascending: true }],
  name_asc: [{ column: 'business_name', ascending: true }],
  name_desc: [{ column: 'business_name', ascending: false }],
  phone_asc: [{ column: 'phone_normalized', ascending: true, nullsFirst: false }],
  phone_desc: [{ column: 'phone_normalized', ascending: false, nullsFirst: false }],
  // State then city, because a location list read by state is a route and a
  // list read by city is an alphabet.
  location_asc: [
    { column: 'state', ascending: true, nullsFirst: false },
    { column: 'city', ascending: true, nullsFirst: false },
  ],
  location_desc: [
    { column: 'state', ascending: false, nullsFirst: false },
    { column: 'city', ascending: false, nullsFirst: false },
  ],
  stage_asc: [{ column: 'pipeline_stage', ascending: true }],
  stage_desc: [{ column: 'pipeline_stage', ascending: false }],
  // Nulls last either way: "never dispositioned" is not an outcome, and it is
  // the biggest group, so letting it lead a descending sort buries the rest.
  outcome_asc: [{ column: 'outcome', ascending: true, nullsFirst: false }],
  outcome_desc: [{ column: 'outcome', ascending: false, nullsFirst: false }],
  tier_asc: [{ column: 'tier', ascending: true, nullsFirst: false }],
  tier_desc: [{ column: 'tier', ascending: false, nullsFirst: false }],
  // An array compares element by element, so this groups leads that share a
  // first tag — which is what "sort by tags" can usefully mean for a set.
  tags_asc: [{ column: 'tags', ascending: true }],
  tags_desc: [{ column: 'tags', ascending: false }],
  last_called_desc: [{ column: 'last_called_at', ascending: false, nullsFirst: false }],
  last_called_asc: [{ column: 'last_called_at', ascending: true, nullsFirst: true }],
}

export const ALL_SORTS = Object.keys(SORTS) as LeadSort[]

/** Human wording, shared by the dropdown and the header tooltips. */
export const SORT_LABELS: Record<LeadSort, string> = {
  created_desc: 'Newest first',
  created_asc: 'Oldest first',
  name_asc: 'Name A–Z',
  name_desc: 'Name Z–A',
  phone_asc: 'Phone, lowest first',
  phone_desc: 'Phone, highest first',
  location_asc: 'Location A–Z',
  location_desc: 'Location Z–A',
  // "Latest", not "furthest": the enum ends with the exits so that the funnel
  // reads in order, which means descending puts Not a fit at the top. Accurate
  // beats flattering — a label promising progress that delivers write-offs is
  // worse than a plain one.
  stage_asc: 'Stage, earliest first',
  stage_desc: 'Stage, latest first',
  outcome_asc: 'Outcome, connected first',
  outcome_desc: 'Outcome, connected last',
  tier_asc: 'Tier A first',
  tier_desc: 'Tier C first',
  tags_asc: 'Tags A–Z',
  tags_desc: 'Tags Z–A',
  last_called_desc: 'Most recently called',
  last_called_asc: 'Least recently called',
}

/** Server-side paged, filtered lead list. The client never holds the full set. */
export function useLeads(options: {
  filters: LeadFilters
  page: number
  sort: LeadSort
  includeDnc?: boolean
}) {
  const { workspaceId } = useWorkspace()
  const { filters, page, sort, includeDnc = false } = options

  return useQuery({
    queryKey: ['leads', workspaceId, filters, page, sort, includeDnc],
    enabled: Boolean(workspaceId),
    placeholderData: (previous) => previous,
    queryFn: async () => {
      let query = supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId!)

      if (!includeDnc) query = query.eq('do_not_call', false)
      if (filters.search?.trim()) {
        query = query.ilike('search_blob', `%${filters.search.trim().toLowerCase()}%`)
      }
      if (filters.outcomes?.length) query = query.in('outcome', filters.outcomes)
      if (filters.city) query = query.ilike('city', filters.city)
      if (filters.state) query = query.ilike('state', filters.state)
      if (filters.stages?.length) query = query.in('pipeline_stage', filters.stages)
      if (filters.tiers?.length) query = query.in('tier', filters.tiers)
      // Match-any: a lead tagged both "innroad" and "small-rooms" should appear
      // under either, which is how anyone actually thinks about tags.
      if (filters.tags?.length) query = query.overlaps('tags', filters.tags)
      // A lead with no count is not "0 rooms", so a bound excludes it rather
      // than sorting it to the bottom.
      if (filters.rooms_min !== undefined) query = query.gte('room_count', filters.rooms_min)
      if (filters.rooms_max !== undefined) query = query.lte('room_count', filters.rooms_max)
      if (filters.has_next_step !== undefined) {
        query = filters.has_next_step
          ? query.gt('open_task_count', 0)
          : query.eq('open_task_count', 0)
      }
      if (filters.never_called) query = query.is('last_called_at', null)
      if (filters.not_called_since) {
        query = query.or(
          `last_called_at.is.null,last_called_at.lt.${filters.not_called_since}`,
        )
      }

      for (const clause of SORTS[sort]) {
        query = query.order(clause.column, {
          ascending: clause.ascending,
          nullsFirst: clause.nullsFirst,
        })
      }
      /*
       * A tiebreak, always. 136 of these leads share a stage and 148 share a
       * tier, and Postgres gives no stable order within a tie — so paging a
       * tied sort can show the same lead on two pages and never show another.
       * Sorting by a column with 136 identical values is exactly the case this
       * feature adds.
       */
      query = query.order('id', { ascending: true })

      const from = page * LEADS_PAGE_SIZE

      const { data, error, count } = await query
        .range(from, from + LEADS_PAGE_SIZE - 1)

      if (error) throw error
      return { leads: (data ?? []) as Lead[], total: count ?? 0 }
    },
  })
}

export function useLead(leadId: string | null) {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['lead', leadId],
    enabled: Boolean(leadId && workspaceId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('id', leadId!)
        .single()

      if (error) throw error
      return data as Lead
    },
  })
}

/** Distinct cities/states for the filter dropdowns, aggregated in Postgres. */
export function useLeadFilterOptions() {
  const { workspaceId } = useWorkspace()

  return useQuery({
    queryKey: ['lead-filter-options', workspaceId],
    enabled: Boolean(workspaceId),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('lead_filter_options', { ws: workspaceId })
      if (error) throw error
      return data as { cities: string[]; states: string[]; tags: string[] }
    },
  })
}

/**
 * Postgres already knows exactly what went wrong; a generic "could not save"
 * throws that away. The two failures a hand edit actually hits are a phone
 * number that collides with another lead and one too short to dial.
 */
function leadWriteError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (code === '23505') {
    return 'Another lead already has that phone number. ' +
      'Edit that lead instead, or delete the duplicate.'
  }
  return errorMessage(error, 'Could not save that lead')
}

export function useUpdateLead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Lead> }) => {
      const { data, error } = await supabase
        .from('leads')
        .update(patch)
        .eq('id', id)
        .select()
        .single()

      if (error) throw error
      return data as Lead
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['funnel'] })
      // scheduled_at moves the reminders anchored to it, so the task list on
      // the dashboard is stale the moment an appointment changes.
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (error) => toast.error(leadWriteError(error)),
  })
}

/**
 * Removes leads outright.
 *
 * Safe by construction rather than by convention: `dial_call_logs.lead_id` is
 * ON DELETE SET NULL, so the call history survives with its denormalized
 * business_name intact, and `session_leads` cascades with an AFTER DELETE
 * trigger that recomputes session progress. Deleting a bad import therefore
 * costs no record of the calls already made against it.
 */
export function useDeleteLeads() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.from('leads').delete().in('id', ids)
      if (error) throw error
      return ids.length
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-filter-options'] })
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void queryClient.invalidateQueries({ queryKey: ['session-queue'] })
      void queryClient.invalidateQueries({ queryKey: ['funnel'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not delete those leads')),
  })
}

/** One patch applied to many leads — bulk stage, bulk do-not-call. */
export function useBulkUpdateLeads() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ ids, patch }: { ids: string[]; patch: Partial<Lead> }) => {
      const { error } = await supabase.from('leads').update(patch).in('id', ids)
      if (error) throw error
      return ids.length
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-filter-options'] })
      void queryClient.invalidateQueries({ queryKey: ['funnel'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not update those leads')),
  })
}

/**
 * Sends parsed CSV rows to import_leads() in batches. Dedup, normalization and
 * the insert-vs-update decision all happen in Postgres.
 */
export function useImportLeads() {
  const { workspaceId } = useWorkspace()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      rows,
      onProgress,
    }: {
      rows: Record<string, unknown>[]
      onProgress?: (done: number, total: number) => void
    }): Promise<ImportResult> => {
      const BATCH = 500
      const totals: ImportResult = { received: 0, inserted: 0, updated: 0, skipped: 0 }

      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)
        const { data, error } = await supabase.rpc('import_leads', {
          ws: workspaceId,
          payload: batch,
        })

        if (error) throw error

        const result = data as ImportResult
        totals.received += result.received
        totals.inserted += result.inserted
        totals.updated += result.updated
        totals.skipped += result.skipped

        onProgress?.(Math.min(i + BATCH, rows.length), rows.length)
      }

      return totals
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-filter-options'] })
      void queryClient.invalidateQueries({ queryKey: ['funnel'] })
      void queryClient.invalidateQueries({ queryKey: ['session-preview'] })
    },
  })
}

/**
 * Add or remove one tag through set_lead_tags(), which does it in a single
 * statement. A client-side read-modify-write of the array would lose whichever
 * of two concurrent edits landed first — and Claude writes this column too.
 */
export function useSetLeadTags() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      id,
      tags,
      mode,
    }: {
      id: string
      tags: string[]
      mode: 'replace' | 'add' | 'remove'
    }) => {
      const { data, error } = await supabase.rpc('set_lead_tags', {
        lead: id,
        new_tags: tags,
        mode,
      })
      if (error) throw error
      return data as string[]
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-filter-options'] })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change those tags')),
  })
}
