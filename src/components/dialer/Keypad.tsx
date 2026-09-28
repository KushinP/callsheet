import { cn } from '@/lib/utils'

const KEYS: { digit: string; letters?: string }[] = [
  { digit: '1' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*' },
  { digit: '0', letters: '+' },
  { digit: '#' },
]

/**
 * The DTMF pad. Rendered from "connecting" right through "conferencing" — a
 * keypad that vanishes mid-dial is useless for phone trees, which is where a
 * cold caller needs it most.
 */
export function Keypad({
  onDigit,
  compact = false,
  className,
}: {
  onDigit: (digit: string) => void
  compact?: boolean
  className?: string
}) {
  return (
    <div className={cn('grid grid-cols-3 gap-1.5', className)}>
      {KEYS.map((key) => (
        <button
          key={key.digit}
          type="button"
          onClick={() => onDigit(key.digit)}
          className={cn(
            'group flex flex-col items-center justify-center rounded-[6px] border border-line',
            'bg-surface-2 transition-colors active:bg-accent active:text-black',
            'hover:border-[#3a4150] hover:bg-elevated',
            compact ? 'h-10' : 'h-12',
          )}
        >
          <span
            className={cn(
              'tabular font-medium leading-none text-ink',
              'group-active:text-black',
              compact ? 'text-sm' : 'text-base',
            )}
          >
            {key.digit}
          </span>
          {key.letters && !compact && (
            <span className="mt-0.5 text-[8px] font-medium tracking-[0.14em] text-ink-faint group-active:text-black/60">
              {key.letters}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
