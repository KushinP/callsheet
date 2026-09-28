import { AlertTriangle, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useMonthUsage } from '@/hooks/useAnalytics'
import { useWorkspace } from '@/hooks/useWorkspace'
import { estimateSpend } from '@/lib/spend'
import { cn } from '@/lib/utils'

/**
 * Rounding a real cost to $0.00 reads as free, which is the one thing a
 * spend breakdown must not imply. Anything non-zero says so.
 */
const usd = (n: number) => {
  if (n === 0) return '$0.00'
  if (n < 0.005) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/**
 * Month-to-date spend against a talk-minute ceiling.
 *
 * At roughly two cents a minute the ceiling is invisible until the invoice
 * arrives — going from ten conversations a day to twenty doubles the bill
 * without a single thing feeling different. This exists so that shows up on
 * day twelve rather than day thirty.
 */
export function BudgetMeter() {
  const { workspace } = useWorkspace()
  const usage = useMonthUsage()

  const budget = workspace?.monthly_minute_budget ?? null
  const spend = estimateSpend(usage.data, budget)
  const talkMinutes = Math.round(Number(usage.data?.talk_seconds ?? 0) / 60)

  if (usage.isLoading) return <Skeleton className="h-28 w-full" />
  // "$0.00 spent so far" on a failed query reads as "you have spent nothing",
  // which is the single most misleading thing this panel could say.
  if (usage.isError) {
    return (
      <Panel className="p-4">
        <ErrorState error={usage.error} what="this month's usage" onRetry={usage.refetch} />
      </Panel>
    )
  }

  const pct = spend.usedFraction === null ? null : Math.min(spend.usedFraction * 100, 100)
  const over = spend.usedFraction !== null && spend.usedFraction >= 1
  const near = spend.usedFraction !== null && spend.usedFraction >= 0.8 && !over

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <Wallet className="size-3.5 text-ink-faint" />
            This month
          </span>
        }
        description="An estimate from list prices — Twilio's invoice is the real number."
      />
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <p className="tabular text-2xl font-semibold text-ink">{usd(spend.total)}</p>
            <p className="text-[10px] text-ink-faint">spent so far</p>
          </div>
          <div>
            <p className="tabular text-sm font-medium text-ink-dim">
              {usd(spend.projectedTotal)}
            </p>
            <p className="text-[10px] text-ink-faint">on pace for the month</p>
          </div>
          <div>
            <p className="tabular text-sm font-medium text-ink-dim">
              {talkMinutes.toLocaleString()}
              {budget ? ` / ${budget.toLocaleString()}` : ''} min
            </p>
            <p className="text-[10px] text-ink-faint">connected talk time</p>
          </div>
        </div>

        {pct !== null ? (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  over ? 'bg-danger' : near ? 'bg-warn' : 'bg-accent',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {(over || near) && (
              <p
                className={cn(
                  'flex items-start gap-1.5 text-[11px] leading-relaxed',
                  over ? 'text-danger' : 'text-warn',
                )}
              >
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                {over
                  ? `You are past your ${budget?.toLocaleString()} minute ceiling. Every further connected minute adds about two cents.`
                  : `You have used ${Math.round(spend.usedFraction! * 100)}% of your talk-time budget with the month not over.`}
              </p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-ink-faint">
            No budget set.{' '}
            <Link to="/settings" className="text-accent hover:underline">
              Set a monthly talk-time ceiling
            </Link>{' '}
            and this becomes a warning rather than a number.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-3 border-t border-line-soft pt-3 sm:grid-cols-4">
          {([
            ['Calls & minutes', spend.telephony],
            ['Recording', spend.recording],
            ['Transcripts & briefs', spend.ai],
            ['Phone number', spend.fixed],
          ] as [string, number][]).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</dt>
              <dd className="tabular mt-0.5 text-xs text-ink-dim">{usd(value)}</dd>
            </div>
          ))}
        </dl>

        <p className="text-[10px] leading-relaxed text-ink-faint">
          Transcripts and briefs are actual billed amounts, stored per call and per document.
          The rest is estimated from published rates, with each call leg rounded up to the
          whole minute Twilio charges for.
        </p>
      </div>
    </Panel>
  )
}
