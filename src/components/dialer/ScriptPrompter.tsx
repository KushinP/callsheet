import { ChevronLeft, ChevronRight, FileText, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { blockById, interpolate, nextBlockId, previousBlockId } from '@/lib/script'
import { SCRIPT_BLOCK_LABELS, SCRIPT_BLOCK_TONES, type CallScript, type Lead } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * The in-call prompter.
 *
 * Deliberately has no dependency on transcription or any model: advance, branch
 * and interpolation are plain client-side state. Live transcription will later
 * add auto-advance on top, and suggestions on top of that, but each layer is
 * additive — remove them and this still works exactly as it does now.
 */
/**
 * What on a card is said, and what is direction.
 *
 * The scripts follow one rule — anything in quotes is spoken, anything else is a
 * cue — and the prompter checked it by asking whether a line STARTS with a
 * quote. Two shapes of real script broke that:
 *
 *   Then: "What does having somebody there run you in a week?"
 *
 * rendered the whole line, question included, as a dimmed uppercase cue, so the
 * question was never read out. And a quote that opens on one line and closes on
 * a later one rendered its continuation as a cue, which stops the reader dead
 * mid-sentence — the shape of the "or who's on…" stall on 7 Sep.
 *
 * A short label ending in a colon before a quote is a lead-in: kept, but small.
 * Labels that say NOT to say something stay cues, or `Avoid: "we're an AI
 * company"` would be read out as the pitch.
 */
interface CardLine {
  kind: 'spoken' | 'cue'
  leadIn?: string
  text: string
}

const LEAD_IN = /^([A-Za-z][\w ,'\/-]{0,24}):\s*(["“].*)$/
const NEGATIVE_LEAD_IN = /^(don'?t|do not|avoid|never|not|instead of|skip)\b/i
const quoteCount = (s: string) => (s.match(/["“”]/g) ?? []).length

function classifyLines(text: string): CardLine[] {
  const out: CardLine[] = []
  let insideQuote = false

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue

    if (insideQuote) {
      out.push({ kind: 'spoken', text: line })
      if (quoteCount(line) % 2 === 1) insideQuote = false
      continue
    }

    if (/^["“]/.test(line)) {
      out.push({ kind: 'spoken', text: line })
      if (quoteCount(line) % 2 === 1) insideQuote = true
      continue
    }

    const lead = LEAD_IN.exec(line)
    if (lead && !NEGATIVE_LEAD_IN.test(lead[1])) {
      out.push({ kind: 'spoken', leadIn: lead[1], text: lead[2] })
      if (quoteCount(lead[2]) % 2 === 1) insideQuote = true
      continue
    }

    out.push({ kind: 'cue', text: line })
  }

  return out
}

export function ScriptPrompter({
  script,
  lead,
  resetKey,
  recording,
  live = true,
  className,
}: {
  script: CallScript
  lead: Lead | null | undefined
  /** Changes when the dialer moves to a new lead, which rewinds the script. */
  resetKey?: string | null
  /** Drives the consent reminder; resolved by the caller, not looked up here. */
  recording?: boolean
  /**
   * True while a call is actually happening. Defaults to true so the safe
   * behaviour is the default: rationale is hidden unless a caller says it is
   * safe to show. The script preview is the one place that says so.
   */
  live?: boolean
  className?: string
}) {
  const [currentId, setCurrentId] = useState(script.entry_block_id)
  const [history, setHistory] = useState<string[]>([])

  // A new lead starts the script from the top; nothing carries over.
  useEffect(() => {
    setCurrentId(script.entry_block_id)
    setHistory([])
  }, [resetKey, script.id, script.entry_block_id])

  const block = blockById(script, currentId) ?? script.blocks[0]
  const nextId = useMemo(() => nextBlockId(script, block.id), [script, block.id])
  const prevId = useMemo(
    () => history.at(-1) ?? previousBlockId(script, block.id),
    [history, script, block.id],
  )

  const goTo = useCallback((id: string | null) => {
    if (!id) return
    setHistory((h) => [...h, currentId])
    setCurrentId(id)
  }, [currentId])

  const goBack = useCallback(() => {
    setHistory((h) => {
      if (h.length > 0) {
        setCurrentId(h[h.length - 1])
        return h.slice(0, -1)
      }
      const fallback = previousBlockId(script, currentId)
      if (fallback) setCurrentId(fallback)
      return h
    })
  }, [script, currentId])

  // Space advances, arrows navigate — a rep on a call should never have to aim
  // at a button. Ignored while typing so notes and search keep working.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (target?.isContentEditable) return
      // Buttons and links activate on Space too. Without this, focusing "Hang
      // up" or a disposition chip and pressing Space advanced the script and
      // suppressed the press — during a live call.
      const active = document.activeElement as HTMLElement | null
      if (active && (/^(BUTTON|A)$/.test(active.tagName) || active.role === 'button')) return

      if (event.code === 'Space' || event.key === 'ArrowRight') {
        event.preventDefault()
        goTo(nextId)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, goBack, nextId])

  /*
   * A script is a graph, not a list. Counting position among all 31 blocks —
   * 21 of which are objections and closes that may never be touched — told a
   * rep they were 3% through a call that was about to be a third done.
   *
   * The main path is what you walk when nobody objects: follow `next` from the
   * entry until it runs out. Off that path you are handling something, and a
   * position is the wrong idea entirely.
   */
  const mainPath = useMemo(() => {
    const byId = new Map(script.blocks.map((b) => [b.id, b]))
    const path: string[] = []
    const seen = new Set<string>()
    let id: string | null | undefined = script.entry_block_id
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id)
      path.push(id)
      id = byId.get(id)?.next
    }
    return path
  }, [script.blocks, script.entry_block_id])

  /*
   * Authored when the script says so, otherwise a generic in the same voice —
   * never "Next". The hint is the block's own advance_on phrases, which is the
   * literal answer to "what did they just say".
   */
  const advanceLabel = block.advance_label?.trim()
    || (block.advance_on?.length ? 'They answered' : 'Next')
  const advanceHint = block.advance_on?.length
    ? block.advance_on.slice(0, 3).map((p) => `"${p}"`).join('  ')
    : null

  const mainIndex = mainPath.indexOf(block.id)
  const position = mainIndex >= 0
    ? `Step ${mainIndex + 1} of ${mainPath.length}`
    : SCRIPT_BLOCK_LABELS[block.kind]

  return (
    <Panel className={cn('h-fit', className)}>
      {/* Recording law in roughly a dozen US states requires every party to
          consent. The obligation belongs where the rep's eyes already are —
          on the words they are about to read — not on a settings page they
          saw once. */}
      {recording && (
        <div className="flex items-center gap-2 border-b border-danger/25 bg-danger/[0.07] px-3 py-1.5">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-danger" />
          <span className="text-[10px] font-medium uppercase tracking-wider text-danger">
            Recording — say so before you go further
          </span>
        </div>
      )}
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <FileText className="size-3.5 text-ink-faint" />
            {script.name}
          </span>
        }
        description={position}
        actions={
          <Badge tone={SCRIPT_BLOCK_TONES[block.kind]}>
            {block.label || SCRIPT_BLOCK_LABELS[block.kind]}
          </Badge>
        }
      />

      <div className="space-y-3 p-4">
        {/*
          * Spoken words and delivery cues are different things and must not
          * look alike. Line breaks were collapsing, so "Say the state. Small
          * talk first." sat inline with the sentence above it — and a rep
          * skimming a card mid-call will read a cue out loud.
          *
          * The rule is the one the scripts already follow: anything in quotes
          * is said, anything else is direction.
          */}
        <div className="space-y-2">
          {classifyLines(interpolate(block.text, lead))
            .map((line, i) =>
              line.kind === 'spoken' ? (
                <p key={i} className="text-[15px] leading-relaxed text-ink">
                  {line.leadIn && (
                    <span className="mr-1.5 align-middle text-[11px] uppercase tracking-wide text-ink-faint">
                      {line.leadIn}
                    </span>
                  )}
                  {/* A placeholder that did not resolve — a manual dial has no
                      lead behind it — must not look like a word. Dimmed and
                      bracketed, it reads as a blank to fill rather than
                      something to say. */}
                  {line.text.split(/(\{\{\s*\w+\s*\}\})/g).map((part, j) =>
                    /^\{\{/.test(part) ? (
                      <span
                        key={j}
                        className="rounded-[3px] bg-warn/15 px-1 text-[13px] text-warn"
                      >
                        {part.replace(/[{}]/g, '').replace(/_/g, ' ').trim()}
                      </span>
                    ) : (
                      part
                    ),
                  )}
                </p>
              ) : (
                <p
                  key={i}
                  className="border-l-2 border-line pl-2 text-[11px] uppercase tracking-wide text-ink-faint"
                >
                  {line.text}
                </p>
              ),
            )}
        </div>

        {/* Why it is worded this way. Collapsed, and gone entirely while a call
            is live — rationale shown at the moment it cannot be read is worse
            than rationale kept somewhere else. */}
        {block.notes && !live && (
          <details className="group">
            <summary className="cursor-pointer list-none text-[10px] uppercase tracking-wider text-ink-faint hover:text-ink-dim">
              Why this block
            </summary>
            <p className="mt-1.5 whitespace-pre-line rounded-[5px] border border-line bg-base px-2.5 py-2 text-[11px] leading-relaxed text-ink-dim">
              {block.notes}
            </p>
          </details>
        )}

        {/*
          * Next is the default and branches are the exception, which is what
          * the schema has always said — advance_on means "this block worked",
          * branches mean "they objected". Rendering them at equal weight made
          * a rep read and choose mid-sentence. On a live call you react; you
          * do not shop.
          */}
        <div className="border-t border-line-soft pt-3">
          {/*
            * In the prospect's voice, like the chips beside it.
            *
            * Four options read as things a prospect says and the fifth read
            * "Next", so the rep had to translate mid-call — and there is no
            * answer, because "Next" is not something anyone can say. The
            * phrases underneath are the ones this block actually listens for.
            */}
          <Button
            variant="primary"
            className="h-auto w-full flex-col gap-0.5 py-2 text-[13px]"
            onClick={() => goTo(nextId)}
            disabled={!nextId}
          >
            <span className="flex items-center gap-1.5">
              {advanceLabel}
              <ChevronRight />
            </span>
            {advanceHint && (
              <span className="text-[10px] font-normal opacity-70">{advanceHint}</span>
            )}
          </Button>

          {block.branches && block.branches.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                or
              </span>
              {block.branches.map((branch) => (
                <button
                  key={branch.goto}
                  type="button"
                  onClick={() => goTo(branch.goto)}
                  /*
                   * The trigger phrases are deliberately not shown. They exist
                   * for matching, not reading — nobody scans "press one /
                   * phone menu / auto attendant" while a prospect is talking.
                   */
                  title={`If they say: ${branch.trigger.join(', ')}`}
                  className="rounded-full border border-line bg-base px-2.5 py-1 text-[11px] text-ink-dim transition-colors hover:border-warn/50 hover:bg-warn/5 hover:text-ink"
                >
                  {branch.label ?? branch.trigger[0]}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 border-t border-line-soft pt-3">
          <Button variant="ghost" size="sm" onClick={goBack} disabled={!prevId}>
            <ChevronLeft />
            Back
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="iconSm"
            title="Back to the start"
            onClick={() => {
              setCurrentId(script.entry_block_id)
              setHistory([])
            }}
          >
            <RotateCcw />
          </Button>
        </div>

        <p className="text-center text-[10px] text-ink-faint">
          Space or → to advance · ← to go back
        </p>
      </div>
    </Panel>
  )
}
