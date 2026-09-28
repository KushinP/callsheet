import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { useFunnel } from '@/hooks/useTasks'
import { usePipelineFlow } from '@/hooks/useTasks'
import {
  EXIT_STAGES, PIPELINE_STAGES, SETBACK_STAGES, STAGE_LABELS, type PipelineStage,
} from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Deliberately not a Recharts funnel.
 *
 * A funnel chart encodes one number per stage as a width, which asserts
 * monotonic decrease — but two of these stages are exits, not steps, so the
 * shape breaks. And the number worth reading is the RATIO between adjacent
 * stages ("one in three demos becomes a pilot"), which a tapering polygon does
 * not show at all: you would be estimating it from two widths.
 *
 * Counts are CUMULATIVE — how many leads ever reached a stage — read from the
 * same source as the pipeline flow beneath it. They used to be "how many are
 * sitting here", which made this box say 16 Called while the flow said 21, for
 * the same word, on the same screen. A lead marked Not a fit was still called;
 * forgetting that is what made the two disagree.
 *
 * That also makes the percentages mean something. Between snapshot counts they
 * were a ratio of two unrelated populations, which is why this used to carry a
 * caveat admitting they understated conversion.
 */
export function FunnelRow() {
  const funnel = useFunnel()
  const flow = usePipelineFlow()
  const [open, setOpen] = useState(() => localStorage.getItem('cs.funnel_open') !== '0')

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev
      try {
        localStorage.setItem('cs.funnel_open', next ? '1' : '0')
      } catch { /* private mode; it just will not persist */ }
      return next
    })
  }

  if (funnel.isLoading || flow.isLoading) return <Skeleton className="h-28 w-full" />

  const rows = flow.data ?? []
  const byStage = new Map((funnel.data ?? []).map((r) => [r.stage, r]))
  /** Sitting here right now — the number the lead list will actually show. */
  const here = (s: PipelineStage) => byStage.get(s)?.leads ?? 0

  // Everything whose furthest point is this stage or beyond came through here.
  const reached = (stage: PipelineStage) => {
    const from = PIPELINE_STAGES.indexOf(stage)
    if (from === -1) return 0
    return rows
      .filter((r) => PIPELINE_STAGES.indexOf(r.reached) >= from)
      .reduce((sum, r) => sum + r.leads, 0)
  }

  const totalLeads = rows.reduce((sum, r) => sum + r.leads, 0)
  const biggest = Math.max(...PIPELINE_STAGES.map(reached), 1)

  return (
    <Panel>
      <PanelHeader
        title="Pipeline"
        description={
          open
            ? 'How many leads ever reached each stage, and the rate between them.'
            : undefined
        }
        actions={
          <Button variant="ghost" size="sm" onClick={toggle}>
            {open ? <ChevronDown /> : <ChevronRight />}
            {open ? 'Hide' : 'Show'}
          </Button>
        }
      />

      {open && (
      <div className="flex flex-wrap items-end gap-x-1 gap-y-3 p-4">
        {PIPELINE_STAGES.map((stage, i) => {
          const previous = i > 0 ? reached(PIPELINE_STAGES[i - 1]) : null
          const n = reached(stage)
          const rate = previous && previous > 0 ? Math.round((n / previous) * 100) : null
          const stale = byStage.get(stage)?.oldest_days ?? 0
          const share = biggest > 0 ? Math.max((n / biggest) * 100, n > 0 ? 3 : 0) : 0

          return (
            <div key={stage} className="flex items-end gap-1">
              {i > 0 && (
                <div className="flex w-10 flex-col items-center pb-3">
                  <span
                    className={cn(
                      'tabular text-[10px] font-medium',
                      rate === null ? 'text-ink-faint'
                        : rate >= 50 ? 'text-accent'
                        : rate >= 20 ? 'text-ink-dim'
                        : 'text-warn',
                    )}
                  >
                    {rate === null ? '—' : `${rate}%`}
                  </span>
                  <ChevronRight className="size-3 text-ink-faint" />
                </div>
              )}
              <div className="min-w-[6rem] rounded-[6px] border border-line bg-surface-2 px-3 pb-2.5 pt-2">
                <p className="text-[10px] uppercase tracking-wider text-ink-faint">
                  {STAGE_LABELS[stage]}
                </p>
                <p
                  className={cn(
                    'tabular mt-0.5 text-2xl font-semibold leading-none',
                    n > 0 ? 'text-ink' : 'text-ink-faint',
                  )}
                  title={`${n} leads have reached ${STAGE_LABELS[stage]} or gone further`}
                >
                  {n}
                </p>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-accent/70"
                    style={{ width: `${share}%` }}
                  />
                </div>
                {/* The big number is cumulative and no filter reproduces it. This
                    one does, so this one is the link — and having both on the
                    tile is what stops the two numbers looking like a bug. */}
                <Link
                  to={`/leads?stage=${stage}`}
                  className="mt-1 block text-[10px] text-ink-faint hover:text-accent hover:underline"
                >
                  {here(stage)} here now
                </Link>
                {n > 0 && stale >= 14 && (
                  <p className="mt-1 text-[10px] text-warn">oldest {stale}d</p>
                )}
              </div>
            </div>
          )
        })}

        {/* Beside the chain, not in it. A no-show is a step backwards from a
            booked demo, so its rate is measured against demo_booked — which is
            the no-show rate, stated rather than inferred from the gap between
            booked and done. */}
        {SETBACK_STAGES.some((stage) => here(stage) > 0) && (
          <>
            <div className="mx-2 h-12 w-px self-end bg-line" aria-hidden />
            {SETBACK_STAGES.map((stage) => {
              const n = here(stage)
              const booked = reached('demo_booked')
              const rate = booked > 0 ? Math.round((n / booked) * 100) : null

              return (
                <Link
                  key={stage}
                  to={`/leads?stage=${stage}`}
                  className="min-w-[6rem] rounded-[6px] border border-warn/30 bg-warn/[0.06] px-3 pb-2.5 pt-2 transition-colors hover:border-warn/50 hover:bg-elevated"
                >
                  <p className="text-[10px] uppercase tracking-wider text-warn/80">
                    {STAGE_LABELS[stage]}
                  </p>
                  <p className="tabular mt-0.5 text-2xl font-semibold leading-none text-ink">
                    {n}
                  </p>
                  {rate !== null && (
                    <p className="mt-1 text-[10px] text-warn">{rate}% of booked</p>
                  )}
                </Link>
              )
            })}
          </>
        )}

        <div className="mx-2 h-12 w-px self-end bg-line" aria-hidden />

        <div className="flex items-end gap-1">
          {EXIT_STAGES.map((stage) => (
            <Link
              key={stage}
              to={`/leads?stage=${stage}`}
              className="min-w-[6rem] rounded-[6px] border border-line px-3 pb-2.5 pt-2 transition-colors hover:border-danger/40 hover:bg-elevated"
            >
              <p className="text-[10px] uppercase tracking-wider text-ink-faint">
                {STAGE_LABELS[stage]}
              </p>
              <p
                className={cn(
                  'tabular mt-0.5 text-2xl font-semibold leading-none',
                  here(stage) > 0 ? 'text-ink-dim' : 'text-ink-faint',
                )}
              >
                {here(stage)}
              </p>
            </Link>
          ))}
        </div>
      </div>
      )}

      {open && totalLeads === 0 && (
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-ink-faint">
          Nothing in the pipeline yet. Leads move to Called on their first dial; everything
          past that is a judgement call you make.
        </p>
      )}
    </Panel>
  )
}
