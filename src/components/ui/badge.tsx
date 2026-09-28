import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 ' +
    'text-[10px] font-medium uppercase tracking-wide whitespace-nowrap',
  {
    variants: {
      tone: {
        good: 'border-accent/30 bg-accent/10 text-accent',
        info: 'border-info/30 bg-info/10 text-info',
        warn: 'border-warn/30 bg-warn/10 text-warn',
        bad: 'border-danger/30 bg-danger/10 text-danger',
        neutral: 'border-line bg-surface-2 text-ink-dim',
        violet: 'border-violet/30 bg-violet/10 text-violet',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
