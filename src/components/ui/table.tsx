import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-left', className)} {...props} />
    </div>
  )
}

export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      className={cn('sticky top-0 z-10 bg-surface-2 [&_th]:border-b [&_th]:border-line', className)}
      {...props}
    />
  )
}

export function TH({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint whitespace-nowrap',
        className,
      )}
      {...props}
    />
  )
}

export function TBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-line-soft', className)} {...props} />
}

export function TR({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('transition-colors hover:bg-surface-2/60', className)} {...props} />
}

export function TD({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-2.5 text-[13px] text-ink align-middle', className)} {...props} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && (
        <div className="flex size-10 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-faint [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-ink">{title}</p>
        {description && (
          <p className="max-w-sm text-xs leading-relaxed text-ink-faint">{description}</p>
        )}
      </div>
      {action}
    </div>
  )
}

/** Cursor-free pagination bar for server-side paged tables. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min((page + 1) * pageSize, total)
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)

  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
      <p className="text-xs text-ink-faint">
        <span className="tabular text-ink-dim">{from.toLocaleString()}</span>
        {'–'}
        <span className="tabular text-ink-dim">{to.toLocaleString()}</span>
        {' of '}
        <span className="tabular text-ink-dim">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 0}
          className="h-7 rounded-[4px] border border-line px-2.5 text-xs text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          Previous
        </button>
        <span className="px-1 text-xs text-ink-faint tabular">
          {page + 1} / {lastPage + 1}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= lastPage}
          className="h-7 rounded-[4px] border border-line px-2.5 text-xs text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  )
}
