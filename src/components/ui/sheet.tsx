import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const Sheet = DialogPrimitive.Root

/**
 * A slide-over panel: a Dialog anchored to the right edge and full height.
 *
 * Preferred over a centred modal for anything consulted mid-task — it opens
 * beside the list rather than on top of it, so the rep keeps their place, and
 * it has room for a lead's whole history without becoming a page.
 */
export function SheetContent({
  className,
  children,
  title,
  description,
  width = 'md',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  title: string
  description?: ReactNode
  width?: 'md' | 'lg'
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-line',
          'bg-surface shadow-2xl shadow-black/60',
          'data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
          'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right',
          width === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <DialogPrimitive.Title className="truncate text-sm font-semibold text-ink">
              {title}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="mt-0.5 text-xs text-ink-faint">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close className="rounded-[4px] p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex-1 overflow-y-auto px-4 py-4', className)} {...props} />
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3',
        className,
      )}
      {...props}
    />
  )
}
