import { CalendarClock, ChevronDown, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from '@/components/ui/dropdown'
import {
  OUTCOME_LABELS, OUTCOME_TONES, QUICK_DISPOSITIONS, SECONDARY_DISPOSITIONS,
  type CallOutcome,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const CHIP_TONES: Record<string, string> = {
  good: 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20',
  info: 'border-info/40 bg-info/10 text-info hover:bg-info/20',
  warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
  bad: 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
  neutral: 'border-line bg-surface-2 text-ink-dim hover:bg-elevated hover:text-ink',
}

/**
 * One-click disposition chips. Human labels on the surface, snake_case values
 * underneath — the rep never sees connected_dm, and the database never sees
 * "Connected – DM".
 */
/** Local-clock value for a datetime-local input, rounded to the next half hour. */
function defaultCallbackAt(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function DispositionBar({
  onSelect,
  selected,
  disabled,
  size = 'md',
  className,
  showKeys = false,
}: {
  /**
   * `callbackAt` is an ISO instant, and only ever arrives with
   * callback_requested. Undefined means "do not touch what is already on the
   * lead"; null means "clear it".
   */
  onSelect: (outcome: CallOutcome, callbackAt?: string | null) => void
  selected?: CallOutcome | null
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
  /** Show the 1-6 hints that match the keyboard shortcuts. */
  showKeys?: boolean
}) {
  /*
   * Asking for the time lives here rather than in each of the four surfaces
   * that render this bar. A callback is the one outcome where the useful fact
   * is not the outcome — it is the hour they gave you, and until now nothing
   * carried it, so the playbook guessed the next morning and left a note asking
   * you to remember.
   */
  const [callbackAt, setCallbackAt] = useState<string | null>(null)

  const choose = (outcome: CallOutcome) => {
    if (outcome === 'callback_requested') setCallbackAt(defaultCallbackAt())
    else onSelect(outcome)
  }

  if (callbackAt !== null) {
    return (
      <div className={cn('space-y-2', className)}>
        <div className="flex items-center gap-2">
          <CalendarClock className="size-3.5 text-info" />
          <span className="text-[11px] font-medium text-ink">When do they want the call?</span>
          <Button
            variant="ghost"
            size="iconSm"
            className="ml-auto"
            onClick={() => setCallbackAt(null)}
          >
            <X />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            type="datetime-local"
            value={callbackAt}
            onChange={(event) => setCallbackAt(event.target.value)}
            className="w-52"
            autoFocus
          />
          <Button
            variant="primary"
            size={size === 'sm' ? 'sm' : 'md'}
            disabled={disabled}
            onClick={() => {
              const at = callbackAt ? new Date(callbackAt).toISOString() : null
              setCallbackAt(null)
              onSelect('callback_requested', at)
            }}
          >
            Save callback
          </Button>
          {/* Not every callback comes with a time, and logging one without is
              a real answer — but it creates no task. A callback at a guessed
              hour reads as a kept promise; this used to guess, and got three
              for three wrong. The lead waits under Nothing queued until a time
              is set on it. */}
          <Button
            variant="ghost"
            size={size === 'sm' ? 'sm' : 'md'}
            disabled={disabled}
            title="Logs the callback without a task. Set a time on the lead and its follow-ups appear."
            onClick={() => {
              setCallbackAt(null)
              onSelect('callback_requested', null)
            }}
          >
            No time agreed
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {QUICK_DISPOSITIONS.map((outcome, index) => (
        <button
          key={outcome}
          type="button"
          disabled={disabled}
          onClick={() => choose(outcome)}
          title={showKeys ? `Press ${index + 1}` : undefined}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[4px] border font-medium transition-colors',
            'disabled:pointer-events-none disabled:opacity-40',
            size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs',
            CHIP_TONES[OUTCOME_TONES[outcome]],
            selected === outcome && 'ring-1 ring-current ring-offset-1 ring-offset-base',
          )}
        >
          {showKeys && (
            <kbd className="rounded-[3px] border border-current/30 px-1 text-[9px] leading-4 opacity-70">
              {index + 1}
            </kbd>
          )}
          {OUTCOME_LABELS[outcome]}
        </button>
      ))}

      <Dropdown>
        <DropdownTrigger asChild>
          <Button variant="ghost" size={size === 'sm' ? 'sm' : 'md'} disabled={disabled}>
            More
            <ChevronDown />
          </Button>
        </DropdownTrigger>
        <DropdownContent align="start">
          {SECONDARY_DISPOSITIONS.map((outcome) => (
            <DropdownItem key={outcome} onSelect={() => choose(outcome)}>
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  OUTCOME_TONES[outcome] === 'good' && 'bg-accent',
                  OUTCOME_TONES[outcome] === 'info' && 'bg-info',
                  OUTCOME_TONES[outcome] === 'warn' && 'bg-warn',
                  OUTCOME_TONES[outcome] === 'bad' && 'bg-danger',
                  OUTCOME_TONES[outcome] === 'neutral' && 'bg-ink-faint',
                )}
              />
              {OUTCOME_LABELS[outcome]}
            </DropdownItem>
          ))}
        </DropdownContent>
      </Dropdown>
    </div>
  )
}
