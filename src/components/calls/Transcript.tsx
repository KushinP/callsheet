/**
 * A call transcript, as a conversation rather than a paragraph.
 *
 * The model writes one turn per line, prefixed with the speaker. Rendered into
 * a <p> those newlines collapse to spaces, which is how six minutes of dialogue
 * became a single 5,000-character block with "Agent:" and "Lead:" buried inside
 * it — every word present and none of it readable.
 *
 * Consecutive turns from the same speaker are merged: the model emits a new
 * line per sentence, so without this a single answer becomes six labelled
 * fragments and the labels stop meaning anything.
 */
import { Check, ClipboardCopy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Turn {
  speaker: string
  /** True for the rep's side, which is worth telling apart at a glance. */
  isAgent: boolean
  text: string
}

/** "Agent: Yo." — anything before the first colon, if it looks like a label. */
const TURN = /^([A-Za-z][A-Za-z0-9 _-]{0,24}):\s*(.*)$/

function parse(raw: string): Turn[] {
  const turns: Turn[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = TURN.exec(trimmed)
    const speaker = match ? match[1].trim() : null
    const text = match ? match[2].trim() : trimmed

    // A line with no label continues whoever was last speaking, which is what
    // a wrapped sentence or an unlabelled aside actually is.
    if (!speaker && turns.length > 0) {
      turns[turns.length - 1].text += ` ${text}`
      continue
    }

    const last = turns[turns.length - 1]
    if (last && speaker && last.speaker === speaker) {
      last.text += ` ${text}`
      continue
    }

    turns.push({
      speaker: speaker ?? 'Unknown',
      isAgent: /agent|rep|you/i.test(speaker ?? ''),
      text,
    })
  }

  return turns
}

export function Transcript({
  text,
  speakerConfidence,
}: {
  text: string
  /** 'low' means the labels were inferred from the audio, not read off channels. */
  speakerConfidence?: string | null
}) {
  const turns = useMemo(() => parse(text), [text])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // Long enough to be worth collapsing. A short call should just be readable
  // without a second click.
  const isLong = turns.length > 8

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      },
      () => { /* clipboard blocked; the text is still on screen to select */ },
    )
  }

  if (turns.length === 0) return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-ink-faint">
          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
        </span>
        {/* Said out loud, because a confidently mislabelled transcript is worse
            than none: it gets quoted into a script with the wrong person's
            words in it. */}
        {speakerConfidence === 'low' && (
          <span
            className="text-[10px] text-warn"
            title="This provider downmixes the call to mono and infers who is speaking. Check the labels before quoting anyone."
          >
            speakers inferred
          </span>
        )}
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5" onClick={copy}>
          {copied ? <Check className="text-accent" /> : <ClipboardCopy />}
          <span className="text-[10px]">{copied ? 'Copied' : 'Copy'}</span>
        </Button>
      </div>

      <div
        className={cn(
          'space-y-2 rounded-[6px] border border-line bg-base p-2.5',
          // Scrolls rather than pushing the rest of the row off the page. Six
          // minutes of talk is a lot of vertical space to hand one call.
          isLong && !expanded && 'max-h-72 overflow-y-auto',
        )}
      >
        {turns.map((turn, index) => (
          <div key={index} className="flex gap-2">
            <span
              className={cn(
                'w-12 shrink-0 pt-px text-[10px] font-semibold uppercase tracking-wider',
                turn.isAgent ? 'text-accent' : 'text-info',
              )}
            >
              {turn.speaker}
            </span>
            <p
              className={cn(
                'min-w-0 flex-1 text-[11px] leading-relaxed',
                turn.isAgent ? 'text-ink-dim' : 'text-ink',
              )}
            >
              {turn.text}
            </p>
          </div>
        ))}
      </div>

      {isLong && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[10px]"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Collapse' : 'Expand full transcript'}
        </Button>
      )}
    </div>
  )
}
