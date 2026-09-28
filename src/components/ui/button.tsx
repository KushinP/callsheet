import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[5px] font-medium ' +
    'transition-colors disabled:opacity-40 disabled:cursor-not-allowed ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-black hover:bg-accent-dim',
        secondary: 'bg-elevated text-ink border border-line hover:bg-[#262b34]',
        outline: 'border border-line bg-transparent text-ink hover:bg-surface-2',
        ghost: 'text-ink-dim hover:bg-surface-2 hover:text-ink',
        danger: 'bg-danger text-white hover:bg-[#dc2626]',
        dangerGhost: 'text-danger hover:bg-danger/10',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3 text-[13px] [&_svg]:size-4',
        lg: 'h-10 px-4 text-sm [&_svg]:size-4',
        icon: 'h-8 w-8 [&_svg]:size-4',
        iconSm: 'h-7 w-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
