import { Phone, PhoneCall, Target, Timer, TrendingUp, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { FunnelRow } from '@/components/dashboard/FunnelRow'
import { PipelineSankey } from '@/components/dashboard/PipelineSankey'
import { MissedCalls } from '@/components/dashboard/MissedCalls'
import { TaskList } from '@/components/dashboard/TaskList'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/table'
import { useCallLog, useCallStats, useDailyCalls } from '@/hooks/useCalls'
import { useDialer } from '@/hooks/useDialer'
import { useWorkspace } from '@/hooks/useWorkspace'
import { OUTCOME_LABELS, OUTCOME_TONES } from '@/lib/types'
import { cn, formatDuration, formatPhone, formatRelative } from '@/lib/utils'

function Stat({
  label,
  value,
  sub,
  icon: Icon,
  loading,
  accent,
  to,
}: {
  label: string
  value: string | number
  sub?: string
  icon: React.ElementType
  loading?: boolean
  accent?: boolean
  /** Where the number came from. A count you cannot open is one you have to
   *  take on trust. */
  to?: string
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {label}
          </p>
          {loading ? (
            <Skeleton className="mt-2 h-7 w-16" />
          ) : (
            <p
              className={cn(
                'tabular mt-1.5 text-2xl font-semibold leading-none',
                accent ? 'text-accent' : 'text-ink',
              )}
            >
              {value}
            </p>
          )}
          {sub && <p className="mt-1.5 text-[11px] text-ink-faint">{sub}</p>}
        </div>
        <Icon className="size-4 shrink-0 text-ink-faint" />
      </div>
    </>
  )

  return to ? (
    <Panel className="p-0">
      <Link
        to={to}
        className="block rounded-[inherit] p-4 transition-colors hover:bg-surface-2"
      >
        {body}
      </Link>
    </Panel>
  ) : (
    <Panel className="p-4">{body}</Panel>
  )
}

export function DashboardPage() {
  const { workspace, twilioReady } = useWorkspace()
  const { openWidget } = useDialer()
  const stats = useCallStats()
  const daily = useDailyCalls(14)
  const recent = useCallLog({ page: 0 })

  const s = stats.data
  const chartData = (daily.data ?? []).map((point) => ({
    ...point,
    label: new Date(`${point.day}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }),
  }))

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={workspace?.name}
        actions={
          <>
            {!twilioReady && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/settings">Finish Twilio setup</Link>
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => openWidget()}>
              <Phone />
              Dial
            </Button>
          </>
        }
      />

      <PageBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Calls today"
            value={s?.calls_today ?? 0}
            sub={`${s?.leads_today ?? 0} unique leads touched`}
            icon={PhoneCall}
            loading={stats.isLoading}
            to="/calls?today=1"
            accent
          />
          <Stat
            label="Calls this week"
            value={s?.calls_week ?? 0}
            sub={`${s?.leads_week ?? 0} unique leads`}
            icon={TrendingUp}
            loading={stats.isLoading}
          />
          <Stat
            label="Calls this month"
            value={s?.calls_month ?? 0}
            sub={`${s?.leads_month ?? 0} unique leads`}
            icon={Users}
            loading={stats.isLoading}
          />
          <Stat
            label="Connection rate"
            value={`${s?.connection_rate ?? 0}%`}
            sub={`${s?.connected_month ?? 0} of ${s?.dispositioned_month ?? 0} dispositioned`}
            icon={Target}
            loading={stats.isLoading}
          />
        </div>

        {/* Above the funnel: these are the only rows on this page where
            somebody is waiting on a call back. */}
        <MissedCalls />

        <FunnelRow />

        <PipelineSankey />

        {/* items-start, or the grid stretches every panel to the height of
            the tallest column — which on a day with a long follow-up list left
            a chart panel two-thirds empty and bordered, so the emptiness read
            as a rendering failure rather than a quiet day. */}
        <div className="grid items-start gap-4 xl:grid-cols-3">
          <Panel className="xl:col-span-2">
            <PanelHeader
              title="Daily call volume"
              description="Last 14 days"
              actions={
                <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
                  <span className="flex items-center gap-1.5 text-ink-faint">
                    <span className="size-2 rounded-[2px] bg-accent" /> Calls
                  </span>
                  <span className="flex items-center gap-1.5 text-ink-faint">
                    <span className="size-2 rounded-[2px] bg-info" /> Connects
                  </span>
                </div>
              }
            />
            <div className="h-64 p-3">
              {daily.isLoading ? (
                <Skeleton className="size-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                    <defs>
                      <linearGradient id="calls" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="connects" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1d2027" vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke="#6b7280"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      stroke="#6b7280"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      cursor={{ stroke: '#262a33' }}
                      contentStyle={{
                        background: '#1f232b',
                        border: '1px solid #262a33',
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: '#9ba1ae' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="calls"
                      stroke="#22c55e"
                      strokeWidth={1.5}
                      fill="url(#calls)"
                      name="Calls"
                    />
                    <Area
                      type="monotone"
                      dataKey="connects"
                      stroke="#38bdf8"
                      strokeWidth={1.5}
                      fill="url(#connects)"
                      name="Connects"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </Panel>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <Stat
                label="Talk time today"
                value={formatDuration(s?.talk_seconds_today ?? 0)}
                icon={Timer}
                loading={stats.isLoading}
              />
              <Stat
                label="Calls all time"
                value={(s?.calls_total ?? 0).toLocaleString()}
                icon={PhoneCall}
                loading={stats.isLoading}
              />
            </div>

            <TaskList />

            <Panel>
              <PanelHeader
                title="Recent calls"
                actions={
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/calls">View all</Link>
                  </Button>
                }
              />
              {recent.isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : recent.data?.calls.length ? (
                <ul className="divide-y divide-line-soft">
                  {recent.data.calls.slice(0, 6).map((call) => (
                    <li key={call.id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-ink">
                          {call.business_name ?? formatPhone(call.phone)}
                        </p>
                        <p className="tabular text-[11px] text-ink-faint">
                          {formatRelative(call.called_at)} · {formatDuration(call.duration_seconds)}
                        </p>
                      </div>
                      {call.outcome && (
                        <Badge tone={OUTCOME_TONES[call.outcome]}>
                          {OUTCOME_LABELS[call.outcome]}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<PhoneCall />}
                  title="No calls yet"
                  description="Place a test call from the dialer widget to confirm your Twilio setup works."
                />
              )}
            </Panel>
          </div>
        </div>
      </PageBody>
    </>
  )
}
