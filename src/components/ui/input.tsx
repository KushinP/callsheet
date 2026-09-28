import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const fieldStyles =
  'w-full rounded-[5px] border border-line bg-base px-2.5 text-[13px] text-ink ' +
  'placeholder:text-ink-faint transition-colors ' +
  'hover:border-[#323845] focus:border-accent focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldStyles, 'h-8', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldStyles, 'min-h-[72px] py-2 leading-relaxed', className)} {...props} />
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn(
        'block text-[11px] font-medium uppercase tracking-wider text-ink-dim',
        className,
      )}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-ink-faint">{hint}</p>}
    </div>
  )
}
