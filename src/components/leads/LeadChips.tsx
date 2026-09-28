import { useId, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  STAGE_LABELS, STAGE_TONES, type LeadTier, type PipelineStage,
} from '@/lib/types'
import { cn } from '@/lib/utils'

export function StageBadge({ stage }: { stage: PipelineStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>
}

/**
 * A single letter, because three values force a commitment a 0-100 score does
 * not. Solid when a human decided it, outlined when it is only Claude's
 * suggestion — so the table shows at a glance which tiers have been reviewed.
 */
export function TierChip({
  tier,
  isOverride,
  reason,
}: {
  tier: LeadTier | null
  isOverride: boolean
  reason?: string | null
}) {
  if (!tier) return <span className="text-ink-faint">—</span>

  const tone =
    tier === 'a' ? 'border-accent/50 text-accent'
    : tier === 'b' ? 'border-info/50 text-info'
    : 'border-line text-ink-faint'

  return (
    <span
      title={
        isOverride
          ? 'Set by you'
          : reason
            ? `Claude suggests ${tier.toUpperCase()} — ${reason}`
            : `Suggested by Claude`
      }
      className={cn(
        'inline-flex size-5 items-center justify-center rounded-[4px] border text-[10px] font-semibold uppercase',
        tone,
        isOverride ? 'bg-current/10' : 'border-dashed opacity-70',
      )}
    >
      {tier}
    </span>
  )
}

/** First two, then a count — a tag list that wraps makes every row a different height. */
export function TagList({ tags, max = 2 }: { tags: string[]; max?: number }) {
  if (!tags?.length) return <span className="text-ink-faint">—</span>

  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length

  return (
    <span className="flex flex-wrap items-center gap-1" title={tags.join(', ')}>
      {shown.map((t) => (
        <span
          key={t}
          className="rounded-[3px] border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-dim"
        >
          {t}
        </span>
      ))}
      {rest > 0 && <span className="text-[10px] text-ink-faint">+{rest}</span>}
    </span>
  )
}

/**
 * Tags, editable in place.
 *
 * Each add or remove is its own atomic statement rather than a draft saved with
 * the rest of the panel: Claude writes this column too, and a whole-array save
 * would silently drop whatever it had added since the panel opened.
 *
 * The regex is the database's own CHECK, restated here only so a bad tag is
 * refused while you are still typing it rather than after a round trip.
 */
const TAG_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,31}$/
const MAX_TAGS = 12

export function TagEditor({
  tags,
  suggestions = [],
  disabled,
  onAdd,
  onRemove,
}: {
  tags: string[]
  suggestions?: string[]
  disabled?: boolean
  onAdd: (tag: string) => void
  onRemove: (tag: string) => void
}) {
  const [draft, setDraft] = useState('')
  const listId = useId()

  const clean = draft.trim().toLowerCase()
  const full = tags.length >= MAX_TAGS
  const problem =
    !clean ? null
    : tags.includes(clean) ? 'Already on this lead.'
    : full ? `A lead carries at most ${MAX_TAGS} tags.`
    : !TAG_PATTERN.test(clean) ? 'Lowercase letters, numbers, spaces and dashes.'
    : null

  const commit = () => {
    if (!clean || problem) return
    onAdd(clean)
    setDraft('')
  }

  // Anything already in use in this workspace, minus what this lead has —
  // reusing a tag is what keeps the list filterable, so make it the easy path.
  const unused = suggestions.filter((t) => !tags.includes(t))

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-[3px] border border-line bg-surface-2 py-0.5 pl-1.5 pr-1 text-[11px] text-ink-dim"
          >
            {tag}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(tag)}
              aria-label={`Remove tag ${tag}`}
              className="rounded-[2px] p-0.5 text-ink-faint transition-colors hover:bg-danger/15 hover:text-danger disabled:opacity-50"
            >
              <X className="size-2.5" />
            </button>
          </span>
        ))}
        {tags.length === 0 && <span className="text-[11px] text-ink-faint">No tags yet.</span>}
      </div>

      <div className="flex gap-1.5">
        <Input
          value={draft}
          list={listId}
          disabled={disabled || full}
          placeholder={full ? `${MAX_TAGS} tags is the limit` : 'Add a tag…'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              commit()
            }
          }}
          className="h-7 text-[12px]"
        />
        <datalist id={listId}>
          {unused.map((t) => <option key={t} value={t} />)}
        </datalist>
        <Button
          variant="secondary"
          disabled={disabled || !clean || Boolean(problem)}
          onClick={commit}
          className="h-7 shrink-0 px-2 text-[11px]"
        >
          Add
        </Button>
      </div>

      {problem && <p className="text-[11px] text-warn">{problem}</p>}
    </div>
  )
}
