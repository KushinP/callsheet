import {
  ALL_OUTCOMES, ALL_STAGES, ALL_TIERS,
  type LeadFilters,
} from '@/lib/types'
import { ALL_SORTS, type LeadSort } from '@/hooks/useLeads'

/**
 * Lead filters <-> URL query string.
 *
 * Filters used to live in bare useState, so navigating to Sessions and back
 * reset everything including the page number. Putting them in the URL also
 * makes a filtered view linkable and survives a refresh, which is what you
 * want when a slice took several clicks to build.
 *
 * Keys are short because this ends up in the address bar.
 */
export interface LeadViewState {
  filters: LeadFilters
  page: number
  sort: LeadSort
  includeDnc: boolean
}

// Read from the hook rather than restated here. The list used to be a copy, and
// a copy that goes stale silently drops a bookmarked sort back to the default.
const SORTS = ALL_SORTS

const list = (v: string | null): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []

/**
 * Keeps only values the database actually knows.
 *
 * `sort` was already whitelisted here; the enum params were cast blind, so a
 * hand-edited or stale URL reached PostgREST and came back as an enum cast
 * error instead of a list. A bookmark carrying `?stage=demo` — renamed when
 * Demo split into booked and completed — did exactly that.
 */
function only<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  return list(raw).filter((v): v is T => (allowed as readonly string[]).includes(v))
}

export function readLeadParams(params: URLSearchParams): LeadViewState {
  const filters: LeadFilters = {}

  const q = params.get('q')?.trim()
  if (q) filters.search = q


  const outcomes = only(params.get('outcome'), ALL_OUTCOMES)
  if (outcomes.length) filters.outcomes = outcomes

  const city = params.get('city')
  if (city) filters.city = city
  const state = params.get('state')
  if (state) filters.state = state

  // The funnel on the dashboard links straight into these, which is the whole
  // reason it beats a chart.
  const stages = only(params.get('stage'), ALL_STAGES)
  if (stages.length) filters.stages = stages

  const tiers = only(params.get('tier'), ALL_TIERS)
  if (tiers.length) filters.tiers = tiers

  const tags = list(params.get('tag'))
  if (tags.length) filters.tags = tags

  const roomsMin = Number.parseInt(params.get('rmin') ?? '', 10)
  if (Number.isFinite(roomsMin) && roomsMin > 0) filters.rooms_min = roomsMin
  const roomsMax = Number.parseInt(params.get('rmax') ?? '', 10)
  if (Number.isFinite(roomsMax) && roomsMax > 0) filters.rooms_max = roomsMax

  const next = params.get('next')
  if (next === 'yes' || next === 'no') filters.has_next_step = next === 'yes'
  if (params.get('never') === '1') filters.never_called = true
  const since = params.get('since')
  if (since) filters.not_called_since = since

  const sortParam = params.get('sort') as LeadSort | null
  const page = Number.parseInt(params.get('page') ?? '', 10)

  return {
    filters,
    // Pages are 1-based in the URL because a human may read it; 0-based inside.
    page: Number.isFinite(page) && page > 0 ? page - 1 : 0,
    sort: sortParam && SORTS.includes(sortParam) ? sortParam : 'created_desc',
    includeDnc: params.get('dnc') === '1',
  }
}

/** Only non-default values are written, so a clean view has a clean URL. */
export function writeLeadParams(state: LeadViewState, existing?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams()

  // Preserve anything this module does not own, such as the ?lead= deep link.
  const leadId = existing?.get('lead')
  if (leadId) params.set('lead', leadId)

  const { filters, page, sort, includeDnc } = state
  if (filters.search?.trim()) params.set('q', filters.search.trim())
  if (filters.outcomes?.length) params.set('outcome', filters.outcomes.join(','))
  if (filters.city) params.set('city', filters.city)
  if (filters.state) params.set('state', filters.state)
  if (filters.stages?.length) params.set('stage', filters.stages.join(','))
  if (filters.tiers?.length) params.set('tier', filters.tiers.join(','))
  if (filters.tags?.length) params.set('tag', filters.tags.join(','))
  if (filters.rooms_min !== undefined) params.set('rmin', String(filters.rooms_min))
  if (filters.rooms_max !== undefined) params.set('rmax', String(filters.rooms_max))
  if (filters.has_next_step !== undefined) {
    params.set('next', filters.has_next_step ? 'yes' : 'no')
  }
  if (filters.never_called) params.set('never', '1')
  if (filters.not_called_since) params.set('since', filters.not_called_since)
  if (sort !== 'created_desc') params.set('sort', sort)
  if (includeDnc) params.set('dnc', '1')
  if (page > 0) params.set('page', String(page + 1))

  return params
}
