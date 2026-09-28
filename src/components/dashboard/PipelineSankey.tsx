import { Link } from 'react-router-dom'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { usePipelineFlow, type PipelineFlowRow } from '@/hooks/useTasks'
import {
  OUTCOME_LABELS, PIPELINE_STAGES, STAGE_LABELS, type CallOutcome, type PipelineStage,
} from '@/lib/types'

/**
 * The pipeline as a flow.
 *
 * The funnel row answers "how many are sitting in each stage". This answers the
 * question you actually ask of a cold list: of everything that came in, how far
 * did it get, and where did it leave.
 *
 * Each stage's outgoing width is split three ways — what moved on, what left,
 * and what is still sitting there — and those three always sum to what came in,
 * which is the property that makes a Sankey worth drawing instead of a row of
 * numbers.
 *
 * Where a lead left is now read from lead_stage_events rather than inferred:
 * every stage change is recorded as it happens, so a deal that reached a
 * completed demo and then died shows as leaving from Demo done, which no amount
 * of looking at the lead row could ever have told you.
 */

/**
 * What "stopped here" means, said in each stage's own terms.
 *
 * Split by whether anything is queued, because lumping them together was a lie
 * about the leads it most mattered for: the moment a callback playbook gave a
 * lead three tasks, the chart still filed it under "No next step yet".
 */
const STALLED_LABELS: Partial<Record<PipelineStage, string>> = {
  new: 'Not called yet',
  called: 'No next step',
  demo_booked: 'No next step',
  demo_completed: 'No next step',
  pilot: 'No next step',
  paying: 'No next step',
}

const WORKING_LABELS: Partial<Record<PipelineStage, string>> = {
  new: 'Queued for research',
  called: 'Follow-up booked',
  demo_booked: 'Demo upcoming',
  demo_completed: 'Awaiting decision',
  pilot: 'In pilot',
  paying: 'Paying',
}

/** Reasons that are not themselves call outcomes, and one outcome worth renaming here. */
const STALL_REASON_LABELS: Record<string, string> = {
  // A callback with no agreed time creates no task, so it lands under No next
  // step — the right place for it: it needs a time, not a guess.
  callback_requested: 'Callback, no time set',
  // Not "never dialled": all this proves is that nothing is on the log. The
  // first six filed under that name had all been dialled from a mobile, and
  // the tier-A one had called back and left a voicemail.
  no_call_logged: 'No call on the log',
  no_outcome: 'No outcome logged',
}

const COLORS = {
  advance: 'var(--color-accent)',
  waiting: 'var(--color-ink-faint)',
  /* Amber for a worked lead with nothing queued. That is the leak, and it
     should not look the same as a cold lead nobody has got to yet. */
  stalled: 'var(--color-warn)',
  setback: 'var(--color-warn)',
  exit: 'var(--color-danger)',
} as const

type Kind = keyof typeof COLORS

interface Node {
  id: string
  label: string
  value: number
  kind: Kind
  /**
   * Where clicking lands you in the lead list — set only where the node's count
   * is EXACTLY what that filter returns.
   *
   * The chain nodes are cumulative: "17 Called" means seventeen leads got at
   * least this far, while ?stage=called returns the fourteen still sitting
   * there. A tile whose number disagrees with the page it opens is worse than
   * a tile you cannot click, so those explain themselves instead.
   */
  stage: PipelineStage | null
  hint?: string
  /** Narrows the link to leads with, or without, something queued. */
  next?: 'yes' | 'no'
  /** Further query params, for a breakdown node that narrows by outcome. */
  extra?: string
  x: number
  y: number
  h: number
}

interface Ribbon {
  id: string
  kind: Kind
  /** Source band top, target band top, and the shared thickness. */
  x0: number
  y0: number
  x1: number
  y1: number
  h: number
}

const NODE_W = 9
const COL_W = 178
/** Two lines of label sit beside every node, so siblings cannot be closer than
 *  that or the text of one lands on the next. This is a typographic minimum,
 *  not a decorative one. */
const GAP = 27
/** A single lead has to be visible, and at real scale it is under two pixels. */
const MIN_H = 6
const FULL_H = 330
const PAD_TOP = 16
/** Room to the right of the last column for its labels. */
const LABEL_W = 150

function ribbonPath(r: Ribbon): string {
  const xm = (r.x0 + r.x1) / 2
  const top0 = r.y0
  const top1 = r.y1
  const bot0 = r.y0 + r.h
  const bot1 = r.y1 + r.h
  return (
    `M ${r.x0},${top0} C ${xm},${top0} ${xm},${top1} ${r.x1},${top1} ` +
    `L ${r.x1},${bot1} C ${xm},${bot1} ${xm},${bot0} ${r.x0},${bot0} Z`
  )
}

function build(rows: PipelineFlowRow[]) {
  const reachedTotal = new Map<PipelineStage, number>()
  for (const row of rows) {
    reachedTotal.set(row.reached, (reachedTotal.get(row.reached) ?? 0) + row.leads)
  }

  // Everything whose furthest point is this stage OR beyond it came through
  // here. Progression along the chain is monotonic, so this is arithmetic
  // rather than an assumption.
  const entered = PIPELINE_STAGES.map((_, i) =>
    PIPELINE_STAGES.slice(i).reduce((sum, s) => sum + (reachedTotal.get(s) ?? 0), 0),
  )

  const total = entered[0] ?? 0
  if (total === 0) return { nodes: [] as Node[], ribbons: [] as Ribbon[], height: 0, width: 0 }

  const scale = FULL_H / total
  const nodes: Node[] = []
  const ribbons: Ribbon[] = []

  const root: Node = {
    id: 'root',
    label: 'Leads',
    value: total,
    kind: 'advance',
    stage: null,
    x: 0,
    y: PAD_TOP,
    h: FULL_H,
    hint: `${total} leads, all time`,
  }
  nodes.push(root)

  const toBreakDown: { node: Node; stage: PipelineStage }[] = []

  let source = root
  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    const stage = PIPELINE_STAGES[i]
    if ((entered[i] ?? 0) === 0) break

    const here = rows.filter((r) => r.reached === stage)
    const sum = (rs: PipelineFlowRow[]) => rs.reduce((total, r) => total + r.leads, 0)
    const still = here.filter((r) => r.exited_as === null)
    const working = sum(still.filter((r) => r.has_next_step))
    const stalled = sum(still.filter((r) => !r.has_next_step))

    // Rows arrive split by `exact` as well as by stage, so the same exit can
    // appear twice. Summing first is what stops it drawing two ribbons to two
    // nodes with the same label.
    const exits = new Map<PipelineStage, number>()
    for (const row of here) {
      if (!row.exited_as) continue
      exits.set(row.exited_as, (exits.get(row.exited_as) ?? 0) + row.leads)
    }

    // Advance on top, then what left, then what is still here — so the eye
    // follows the deal down the page and the losses read as branches off it.
    const children: {
      id: string; label: string; value: number; kind: Kind
      stage: PipelineStage | null; hint?: string; next?: 'yes' | 'no'
    }[] = []

    const next = PIPELINE_STAGES[i + 1]
    if (next && (entered[i + 1] ?? 0) > 0) {
      children.push({
        id: `stage-${next}`, label: STAGE_LABELS[next], value: entered[i + 1],
        kind: 'advance', stage: null,
        hint: `${entered[i + 1]} reached ${STAGE_LABELS[next]} or went further`,
      })
    }
    for (const [to, value] of exits) {
      children.push({
        id: `exit-${stage}-${to}`,
        label: STAGE_LABELS[to],
        value,
        // A no-show still has a pulse; lost and not-a-fit do not.
        kind: to === 'demo_no_show' ? 'setback' : 'exit',
        stage: to,
      })
    }
    if (working > 0) {
      children.push({
        id: `work-${stage}`,
        label: WORKING_LABELS[stage] ?? STAGE_LABELS[stage],
        value: working,
        kind: 'waiting',
        stage,
        next: 'yes',
      })
    }
    if (stalled > 0) {
      children.push({
        id: `stall-${stage}`,
        label: STALLED_LABELS[stage] ?? STAGE_LABELS[stage],
        value: stalled,
        // A cold lead nobody has reached yet is not a leak; a lead you called
        // and then queued nothing for is.
        kind: stage === 'new' ? 'waiting' : 'stalled',
        stage,
        next: 'no',
      })
    }

    if (children.length === 0) break

    /*
     * Children are laid out inside their parent's vertical extent, so each
     * column nests in the one before it and the ribbons stay near-horizontal.
     * A minimum height means a single lead is still visible; that overflows the
     * parent slightly on lopsided data, which is why every node also carries
     * its number.
     */
    const x = source.x + COL_W
    let cursorSource = source.y
    let cursorTarget = source.y

    for (const child of children) {
      const h = Math.max(child.value * scale, MIN_H)
      const node: Node = { ...child, x, y: cursorTarget, h }
      nodes.push(node)
      ribbons.push({
        id: `${source.id}->${child.id}`,
        kind: child.kind,
        x0: source.x + NODE_W,
        y0: cursorSource,
        x1: x,
        y1: cursorTarget,
        h,
      })
      cursorSource += h
      cursorTarget += h + GAP
    }

    const stallNode = nodes.find((n) => n.id === `stall-${stage}` && n.kind === 'stalled')
    if (stallNode) toBreakDown.push({ node: stallNode, stage })

    const advance = nodes.find((n) => n.id === `stage-${next}`)
    if (!advance) break
    source = advance
  }

  /*
   * Why "No next step" has none.
   *
   * One amber number was hiding unrelated situations: a voicemail nobody
   * followed, a callback logged without a time, a call never dispositioned,
   * and leads at Called with no call on the log at all — which can mean calls
   * made off-app that were never logged, and so can hide the warmest lead on
   * the board. Every one of them is work owed, so every one is amber.
   *
   * Laid out after the main flow and below whatever it already put in the same
   * column. Placed first, these would push the next stage's own branches
   * underneath them and cross every ribbon on the way down.
   */
  const colBottom = new Map<number, number>()
  for (const n of nodes) colBottom.set(n.x, Math.max(colBottom.get(n.x) ?? 0, n.y + n.h))

  for (const { node: stall, stage } of toBreakDown) {
    const reasons = new Map<string, number>()
    for (const r of rows) {
      if (r.reached !== stage || r.exited_as !== null || r.has_next_step || !r.stall_reason) continue
      reasons.set(r.stall_reason, (reasons.get(r.stall_reason) ?? 0) + r.leads)
    }
    if (reasons.size === 0) continue

    const ordered = [...reasons].sort((a, b) => b[1] - a[1])

    const x = stall.x + COL_W
    let cursorSource = stall.y
    let cursorTarget = Math.max(stall.y, (colBottom.get(x) ?? -Infinity) + GAP)

    for (const [reason, value] of ordered) {
      const h = Math.max(value * scale, MIN_H)
      // "No outcome logged" has no lead filter that reproduces it, so it
      // explains itself rather than opening a list with a different count.
      const linkable = reason !== 'no_outcome'
      const node: Node = {
        id: `why-${stage}-${reason}`,
        label: STALL_REASON_LABELS[reason] ?? OUTCOME_LABELS[reason as CallOutcome] ?? reason,
        value,
        kind: 'stalled',
        stage: linkable ? stage : null,
        next: linkable ? 'no' : undefined,
        extra: reason === 'no_call_logged' ? '&never=1' : linkable ? `&outcome=${reason}` : undefined,
        hint: linkable
          ? undefined
          : `${value} called with no outcome logged — disposition them from the call log`,
        x,
        y: cursorTarget,
        h,
      }
      nodes.push(node)
      ribbons.push({
        id: `${stall.id}->${node.id}`,
        kind: node.kind,
        x0: stall.x + NODE_W,
        y0: cursorSource,
        x1: x,
        y1: cursorTarget,
        h,
      })
      cursorSource += h
      cursorTarget += h + GAP
      colBottom.set(x, node.y + node.h)
    }
  }

  const height = Math.max(...nodes.map((n) => n.y + n.h)) + PAD_TOP
  const width = Math.max(...nodes.map((n) => n.x)) + NODE_W + LABEL_W

  return { nodes, ribbons, height, width }
}

export function PipelineSankey() {
  const flow = usePipelineFlow()

  if (flow.isLoading) return <Skeleton className="h-72 w-full" />

  const rows = flow.data ?? []
  const { nodes, ribbons, height, width } = build(rows)

  const total = rows.reduce((sum, r) => sum + r.leads, 0)
  const reconstructed = rows.filter((r) => !r.exact).reduce((sum, r) => sum + r.leads, 0)

  return (
    <Panel>
      <PanelHeader
        title="Pipeline flow"
        description="Of every lead that came in, how far it got and where it left. Widths are lead counts; each stage's branches sum to what reached it."
      />

      {nodes.length === 0 ? (
        <p className="px-4 py-6 text-[11px] text-ink-faint">
          Nothing in the pipeline yet. Leads move to Called on their first dial; everything
          past that is a judgement call you make.
        </p>
      ) : (
        <div className="overflow-x-auto p-4">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            className="max-w-full"
            role="img"
            aria-label="Pipeline flow from leads to outcomes"
          >
            {ribbons.map((r) => (
              <path
                key={r.id}
                d={ribbonPath(r)}
                fill={COLORS[r.kind]}
                // Faint enough to read the labels through where two ribbons
                // cross, solid enough to follow one across the chart.
                opacity={0.28}
              />
            ))}

            {nodes.map((node) => (
              <g key={node.id}>
                <rect
                  x={node.x}
                  y={node.y}
                  width={NODE_W}
                  height={node.h}
                  rx={2}
                  fill={COLORS[node.kind]}
                />
                <text
                  x={node.x + NODE_W + 8}
                  y={node.y + 12}
                  className="fill-ink text-[14px] font-semibold"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {node.value}
                </text>
                <text
                  x={node.x + NODE_W + 8}
                  y={node.y + 25}
                  className="fill-ink-dim text-[11px]"
                >
                  {node.label}
                </text>
                {/* The chart is also a way in: every node is the lead list
                    filtered to exactly the leads it counts. */}
                {node.stage ? (
                  <Link
                    to={`/leads?stage=${node.stage}${node.next ? `&next=${node.next}` : ''}${node.extra ?? ''}`}
                  >
                    <rect
                      x={node.x}
                      y={node.y}
                      width={COL_W - 12}
                      height={Math.max(node.h, 26)}
                      fill="transparent"
                      className="cursor-pointer"
                    >
                      <title>{`${node.value} · ${node.label} — open in Leads`}</title>
                    </rect>
                  </Link>
                ) : (
                  <rect
                    x={node.x}
                    y={node.y}
                    width={COL_W - 12}
                    height={Math.max(node.h, 26)}
                    fill="transparent"
                  >
                    <title>{node.hint ?? node.label}</title>
                  </rect>
                )}
              </g>
            ))}
          </svg>
        </div>
      )}

      {/* Say how much of the picture is measured. A chart that quietly mixes
          recorded history with reconstruction is the kind that gets quoted in a
          board deck and then cannot be defended. */}
      <p className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-ink-faint">
        {reconstructed === 0 ? (
          <>Every stage change is recorded as it happens, so these paths are exact.</>
        ) : (
          <>
            <span className="text-ink-dim">{total - reconstructed} of {total}</span> leads have
            their full path recorded. The other {reconstructed} predate stage history and are
            placed by the evidence on the row — its first call, a booked date — which understates
            rather than flatters. Everything that moves from now on is exact.
          </>
        )}
      </p>
    </Panel>
  )
}
