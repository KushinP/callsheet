import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { CallOutcome } from '@/lib/types'
import type { MonthUsage } from '@/lib/spend'
import { useWorkspace } from './useWorkspace'

/** The browser's own zone, so "when to call" means the rep's clock. */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export interface HourPoint {
  hour: number
  dials: number
  connects: number
  appointments: number
  connect_rate: number
}
export interface DowPoint {
  dow: number
  dials: number
  connects: number
  connect_rate: number
}
export interface OutcomePoint {
  day: string
  outcome: CallOutcome
  calls: number
}
export interface SegmentRow {
  segment: string
  leads_touched: number
  dials: number
  connects: number
  appointments: number
  connect_rate: number
}
export interface ScriptRow {
  script_id: string | null
  name: string
  dials: number
  connects: number
  appointments: number
  connect_rate: number
}
export interface Pace {
  calls: number
  connects: number
  talk_seconds: number
  median_talk_seconds: number
  active_hours: number
  calls_per_active_hour: number
  dials_per_connect: number | null
  attempts_to_contact: { attempt: number; leads: number }[]
}

function useRpc<T>(key: string, fn: string, args: Record<string, unknown>, enabledExtra = true) {
  const { workspaceId } = useWorkspace()
  return useQuery({
    queryKey: [key, workspaceId, args],
    enabled: Boolean(workspaceId) && enabledExtra,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(fn, { ws: workspaceId, ...args })
      if (error) throw error
      return data as T
    },
  })
}

export const useHourlyPerformance = (days = 30) =>
  useRpc<HourPoint[]>('hourly-performance', 'workspace_hourly_performance', { days, tz: TZ })

export const useDowPerformance = (days = 90) =>
  useRpc<DowPoint[]>('dow-performance', 'workspace_dow_performance', { days, tz: TZ })


export const useSegmentPerformance = (dimension: string, days = 365) =>
  useRpc<SegmentRow[]>('segment-performance', 'workspace_segment_performance', { dimension, days })

export const useScriptPerformance = (days = 90) =>
  useRpc<ScriptRow[]>('script-performance', 'workspace_script_performance', { days })

export const usePace = (days = 30) =>
  useRpc<Pace>('pace', 'workspace_pace', { days, tz: TZ })

export const useMonthUsage = () =>
  useRpc<MonthUsage>('month-usage', 'workspace_month_usage', { tz: TZ })
