import { useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { ErrorState } from '@/components/ui/error-state'
import { BudgetMeter } from '@/components/analytics/BudgetMeter'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import {
  useDowPerformance, useHourlyPerformance, usePace, useScriptPerformance,
  useSegmentPerformance,
} from '@/hooks/useAnalytics'
import { cn } from '@/lib/utils'

const AXIS = { stroke: '#6b7280', fontSize: 10, tickLine: false, axisLine: false } as const
const TOOLTIP = {
  cursor: { fill: '#1d2027' },
  contentStyle: {
    background: '#1f232b', border: '1px solid #262a33', borderRadius: 6, fontSize: 12,
  },
  labelStyle: { color: '#9ba1ae' },
} as const

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/*
 * Two colours, one meaning each, on both timing charts.
 *
 * They used to mean two different things on the same screen: on the hour chart
 * blue and green were RATE BANDS of a single dials bar, and on the weekday
 * chart they were the dials and connects SERIES. Same two colours, same page,
 * unrelated encodings, no legend on either.
 *
 * Stacked instead of side by side, because the question is a rate: the bar is
 * the dials, the green is the part that reached a person, and the proportion is
 * the answer without reading two heights against each other.
 */
const CONNECTED = '#22c55e'
const UNANSWERED = '#39404d'

/** Below this, one lucky pickup is a 100% hour. */
const MIN_DIALS_TO_RANK = 5

interface TimingRow {
  label: string
  dials: number
  connects: number
  unanswered: number
  connect_rate: number
}

function ConnectLegend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-ink-dim">
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-[2px]" style={{ background: CONNECTED }} />
        Reached a person
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-[2px]" style={{ background: UNANSWERED }} />
        No answer
      </span>
    </div>
  )
}

/** Dials, connects and the rate — the tooltip used to show only "Dials : 1". */
function ConnectTooltip({
  active, payload, label,
}: {
  active?: boolean
  payload?: { payload: TimingRow }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload

  return (
    <div className="rounded-[6px] border border-line bg-elevated px-2.5 py-2 text-[11px]">
      <p className="mb-1 font-medium text-ink">{label}</p>
      <p className="text-ink-dim">
        {row.dials} {row.dials === 1 ? 'dial' : 'dials'}
      </p>
      <p style={{ color: CONNECTED }}>
        {row.connects} reached {row.dials > 0 && `· ${row.connect_rate}%`}
      </p>
    </div>
  )
}

/** Both timing charts, so their encodings cannot drift apart again. */
function ConnectChart({ data, interval }: { data: TimingRow[]; interval?: number }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid stroke="#1d2027" vertical={false} />
        <XAxis dataKey="label" {...AXIS} interval={interval} />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip cursor={{ fill: '#1d2027' }} content={<ConnectTooltip />} />
        <Bar dataKey="connects" name="Reached a person" stackId="calls" fill={CONNECTED} />
        <Bar
          dataKey="unanswered"
          name="No answer"
          stackId="calls"
          fill={UNANSWERED}
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

const DIMENSIONS = [
  { value: 'state', label: 'State' },
  { value: 'city', label: 'City' },
  { value: 'business_type', label: 'Property type' },
  { value: 'segment', label: 'Segment' },
  { value: 'size_band', label: 'Size' },
  { value: 'independent', label: 'Independent vs chain' },
]

function hourLabel(h: number): string {
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  return h < 12 ? `${h}a` : `${h - 12}p`
}

/**
 * A chart is only worth drawing once there is something in it. Everything here
 * reads from the rep's own history, so an empty state should say "keep dialling",
 * not imply something is broken.
 */
function Waiting({
  what,
  query,
}: {
  what: string
  // A failed query is not an empty one. Without this every panel on this page
  // answered a dropped connection or an RLS denial with "keep dialling", which
  // is the one thing that is definitely not the problem.
  query?: { isError: boolean; error: unknown; refetch: () => void }
}) {
  if (query?.isError) {
    return <ErrorState error={query.error} what={what.toLowerCase()} onRetry={query.refetch} />
  }
  return (
    <EmptyState
      title="Not enough calls yet"
      description={`${what} builds up as you dial. Come back once you have a few days of calls behind you.`}
    />
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-ink-faint">{hint}</p>}
    </div>
  )
}

export function AnalyticsPage() {
  const [dimension, setDimension] = useState('state')

  const hourly = useHourlyPerformance(30)
  const dow = useDowPerformance(90)
  const segments = useSegmentPerformance(dimension)
  const scripts = useScriptPerformance(90)
  const pace = usePace(30)

  const hourRows = useMemo(
    () => {
      const all = (hourly.data ?? []).map((h) => ({
        ...h,
        label: hourLabel(h.hour),
        unanswered: Math.max(h.dials - h.connects, 0),
      }))
      /*
       * Trimmed to the hours that have anything in them, padded by one either
       * side. Nobody cold-calls inns at 3am, so two thirds of the axis was
       * permanently blank and the bars that mattered were squeezed into a
       * third of the panel.
       */
      const busy = all.filter((h) => h.dials > 0).map((h) => h.hour)
      if (busy.length === 0) return all
      const from = Math.max(Math.min(...busy) - 1, 0)
      const to = Math.min(Math.max(...busy) + 1, 23)
      return all.filter((h) => h.hour >= from && h.hour <= to)
    },
    [hourly.data],
  )
  const dowRows = useMemo(
    () => (dow.data ?? []).map((d) => ({
      ...d,
      label: DOW_LABELS[d.dow] ?? String(d.dow),
      unanswered: Math.max(d.dials - d.connects, 0),
    })),
    [dow.data],
  )

  const anyDials = hourRows.some((h) => h.dials > 0)
  // Ranked only among hours with enough dials to mean anything. One pickup out
  // of one dial is a 100% hour, and calling that "best so far" sends you to
  // rearrange your day around a single call.
  const bestHour =
    [...hourRows].filter((h) => h.dials >= MIN_DIALS_TO_RANK && h.connect_rate > 0)
      .sort((a, b) => b.connect_rate - a.connect_rate)[0] ?? null

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Everything here is your own call history — no benchmarks, no industry averages."
      />

      <PageBody className="space-y-4">
        <BudgetMeter />

        <Tabs defaultValue="timing">
          <TabsList>
            <TabsTrigger value="timing">When to call</TabsTrigger>
            <TabsTrigger value="segments">Who to call</TabsTrigger>
            <TabsTrigger value="effort">Effort</TabsTrigger>
          </TabsList>

          {/* ── When to call ─────────────────────────────────────────────── */}
          <TabsContent value="timing" className="space-y-4">
            <Panel>
              <PanelHeader
                title="When calls get answered — by hour"
                description={
                  bestHour
                    ? `Bar height is dials, green is the part that reached a person. Best so far: ${hourLabel(bestHour.hour)}, ${bestHour.connect_rate}% of ${bestHour.dials} dials.`
                    : anyDials
                      ? `Bar height is dials, green is the part that reached a person. No hour has ${MIN_DIALS_TO_RANK} dials yet, so there is no best one to name.`
                      : 'Last 30 days, in your local time.'
                }
                actions={<ConnectLegend />}
              />
              <div className="h-64 p-3">
                {hourly.isLoading ? (
                  <Skeleton className="size-full" />
                ) : !anyDials ? (
                  <Waiting what="Hour-by-hour performance" query={hourly} />
                ) : (
                  <ConnectChart data={hourRows} interval={0} />
                )}
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="When calls get answered — by weekday"
                description="Same reading as above: the bar is dials, the green is who picked up. Last 90 days."
                actions={<ConnectLegend />}
              />
              <div className="h-56 p-3">
                {dow.isLoading ? (
                  <Skeleton className="size-full" />
                ) : !dowRows.some((d) => d.dials > 0) ? (
                  <Waiting what="Day-of-week performance" query={dow} />
                ) : (
                  <ConnectChart data={dowRows} />
                )}
              </div>
            </Panel>
          </TabsContent>

          {/* ── Who to call ──────────────────────────────────────────────── */}
          <TabsContent value="segments" className="space-y-4">
            <Panel className="overflow-hidden">
              <PanelHeader
                title="Performance by segment"
                description="Property attributes come from the briefs Claude writes, so leads without a brief group under 'unknown'."
                actions={
                  <Select
                    value={dimension}
                    onValueChange={setDimension}
                    options={DIMENSIONS}
                    className="w-48"
                  />
                }
              />
              {segments.isLoading ? (
                <div className="p-3"><Skeleton className="h-40 w-full" /></div>
              ) : (segments.data ?? []).length === 0 ? (
                <Waiting what="Segment performance" query={segments} />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Segment</TH>
                      <TH className="text-right">Leads</TH>
                      <TH className="text-right">Dials</TH>
                      <TH className="text-right">Connects</TH>
                      <TH className="text-right">Appts</TH>
                      <TH className="text-right">Connect rate</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {(segments.data ?? []).map((row) => (
                      <TR key={row.segment}>
                        <TD className="font-medium capitalize">
                          {row.segment.replace(/_/g, ' ')}
                        </TD>
                        <TD className="tabular text-right text-ink-dim">{row.leads_touched}</TD>
                        <TD className="tabular text-right text-ink-dim">{row.dials}</TD>
                        <TD className="tabular text-right text-ink-dim">{row.connects}</TD>
                        <TD className="tabular text-right text-ink-dim">{row.appointments}</TD>
                        <TD
                          className={cn(
                            'tabular text-right font-medium',
                            row.connect_rate >= 40 ? 'text-accent' : 'text-ink-dim',
                          )}
                        >
                          {row.connect_rate}%
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Panel>

            <Panel className="overflow-hidden">
              <PanelHeader
                title="Script performance"
                description="Which script actually books. Only counts calls placed since scripts started being recorded against them."
              />
              {scripts.isLoading ? (
                <div className="p-3"><Skeleton className="h-32 w-full" /></div>
              ) : (scripts.data ?? []).length === 0 ? (
                <Waiting what="Script performance" query={scripts} />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Script</TH>
                      <TH className="text-right">Dials</TH>
                      <TH className="text-right">Connects</TH>
                      <TH className="text-right">Appts</TH>
                      <TH className="text-right">Connect rate</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {(scripts.data ?? []).map((row) => (
                      <TR key={row.script_id ?? 'none'}>
                        <TD className={cn('font-medium', !row.script_id && 'text-ink-faint')}>
                          {row.name}
                        </TD>
                        <TD className="tabular text-right text-ink-dim">{row.dials}</TD>
                        <TD className="tabular text-right text-ink-dim">{row.connects}</TD>
                        <TD className="tabular text-right text-ink-dim">{row.appointments}</TD>
                        <TD className="tabular text-right font-medium text-ink-dim">
                          {row.connect_rate}%
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Panel>
          </TabsContent>

          {/* ── Effort ───────────────────────────────────────────────────── */}
          <TabsContent value="effort" className="space-y-4">
            {pace.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !pace.data || pace.data.calls === 0 ? (
              <Panel><Waiting what="Pace" query={pace} /></Panel>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Calls per hour"
                    value={String(pace.data.calls_per_active_hour)}
                    hint={`across ${pace.data.active_hours} hour${pace.data.active_hours === 1 ? '' : 's'} of actual dialling`}
                  />
                  <Stat
                    label="Dials per connect"
                    value={pace.data.dials_per_connect?.toString() ?? '—'}
                    hint={pace.data.dials_per_connect ? 'lower is better' : 'no connects yet'}
                  />
                  <Stat
                    label="Median conversation"
                    value={`${Math.round(pace.data.median_talk_seconds)}s`}
                    hint="connected calls only"
                  />
                  <Stat
                    label="Total talk time"
                    value={`${Math.round(pace.data.talk_seconds / 60)}m`}
                    hint="last 30 days"
                  />
                </div>

                <Panel>
                  <PanelHeader
                    title="Attempts to first contact"
                    description="How many dials it took to reach someone — the number behind deciding when to stop calling."
                  />
                  <div className="h-56 p-3">
                    {pace.data.attempts_to_contact.length === 0 ? (
                      <Waiting what="Attempts to contact" />
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={pace.data.attempts_to_contact}
                          margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                        >
                          <CartesianGrid stroke="#1d2027" vertical={false} />
                          <XAxis dataKey="attempt" {...AXIS} />
                          <YAxis {...AXIS} allowDecimals={false} />
                          <Tooltip {...TOOLTIP} />
                          <Bar dataKey="leads" name="Leads reached" fill="#22c55e" radius={[2, 2, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </Panel>
              </>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  )
}
