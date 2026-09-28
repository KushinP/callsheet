import { cn, formatDuration } from '@/lib/utils'
import type { CallState } from '@/hooks/useDialer'

const LABELS: Record<CallState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  ringing: 'Ringing',
  live: 'Live',
  conferencing: 'Conference',
  ending: 'Hanging up',
}

const TONES: Record<CallState, string> = {
  idle: 'border-line bg-surface-2 text-ink-faint',
  connecting: 'border-warn/30 bg-warn/10 text-warn',
  ringing: 'border-warn/30 bg-warn/10 text-warn',
  live: 'border-accent/30 bg-accent/10 text-accent',
  conferencing: 'border-violet/30 bg-violet/10 text-violet',
  ending: 'border-line bg-surface-2 text-ink-dim',
}

export function CallStatePill({
  state,
  duration,
  className,
}: {
  state: CallState
  duration?: number
  className?: string
}) {
  const pulsing = state === 'connecting' || state === 'ringing'
  const showTimer = state === 'live' || state === 'conferencing'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-0.5',
        'text-[10px] font-semibold uppercase tracking-wider',
        TONES[state],
        className,
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full bg-current',
          pulsing && 'animate-pulse',
        )}
      />
      {LABELS[state]}
      {showTimer && duration !== undefined && (
        <span className="tabular font-normal tracking-normal opacity-80">
          {formatDuration(duration)}
        </span>
      )}
    </span>
  )
}
