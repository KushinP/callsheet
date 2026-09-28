import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/**
 * Renders a stored document body.
 *
 * No rehype-raw: react-markdown's default refuses raw HTML, which is the right
 * posture for text a model wrote and a browser renders.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('space-y-3 text-xs leading-relaxed text-ink-dim', className)}>
      <ReactMarkdown
        // Tables and strikethrough are GFM, not core markdown, and a report
        // without working tables is mostly pipes.
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="text-sm font-semibold text-ink" {...p} />,
          h2: (p) => <h2 className="pt-1 text-[13px] font-semibold text-ink" {...p} />,
          h3: (p) => (
            <h3
              className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint"
              {...p}
            />
          ),
          p: (p) => <p className="text-xs leading-relaxed text-ink-dim" {...p} />,
          ul: (p) => <ul className="ml-4 list-disc space-y-1 marker:text-ink-faint" {...p} />,
          ol: (p) => <ol className="ml-4 list-decimal space-y-1 marker:text-ink-faint" {...p} />,
          li: (p) => <li className="text-xs leading-relaxed text-ink-dim" {...p} />,
          strong: (p) => <strong className="font-semibold text-ink" {...p} />,
          a: (p) => (
            <a
              className="text-accent hover:underline"
              target="_blank"
              rel="noreferrer noopener"
              {...p}
            />
          ),
          code: (p) => (
            <code className="rounded-[3px] bg-surface-2 px-1 py-0.5 text-[11px] text-ink" {...p} />
          ),
          blockquote: (p) => (
            <blockquote className="border-l-2 border-line pl-3 italic text-ink-faint" {...p} />
          ),
          hr: () => <hr className="border-line-soft" />,
          table: (p) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[11px]" {...p} />
            </div>
          ),
          th: (p) => (
            <th
              className="border border-line-soft bg-surface-2 px-2 py-1 text-left font-semibold text-ink-dim"
              {...p}
            />
          ),
          td: (p) => <td className="border border-line-soft px-2 py-1" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
