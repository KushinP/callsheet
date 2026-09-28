import { FileText, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Markdown } from '@/components/ui/markdown'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/table'
import { useDeleteDocument, useReports } from '@/hooks/useDocuments'
import { cn, formatRelative } from '@/lib/utils'

/** A half-open [start, end) window, rendered as the days it actually covers. */
function periodLabel(start: string | null, end: string | null): string {
  if (!start || !end) return '—'
  const from = new Date(`${start}T00:00:00`)
  // period_end is exclusive, so the last day counted is the day before it.
  const to = new Date(new Date(`${end}T00:00:00`).getTime() - 86_400_000)
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return from.getTime() === to.getTime()
    ? fmt(from)
    : `${fmt(from)} – ${fmt(to)}`
}

export function ReportsPage() {
  const reports = useReports()
  const deleteDocument = useDeleteDocument()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const rows = reports.data ?? []
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null

  return (
    <>
      <PageHeader
        title="Reports"
        badge={rows.length ? <Badge tone="neutral">{rows.length}</Badge> : undefined}
      />

      <PageBody>
        {reports.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : reports.isError ? (
          <Panel>
            <ErrorState
              what="reports"
              error={reports.error}
              onRetry={() => void reports.refetch()}
            />
          </Panel>
        ) : rows.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<Sparkles />}
              title="No reports yet"
              description="Ask Claude for a weekly summary through the Callsheet connector and it will save it here — with the numbers it was written from."
            />
          </Panel>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
            <Panel className="h-fit overflow-hidden">
              <ul className="divide-y divide-line-soft">
                {rows.map((report) => (
                  <li key={report.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(report.id)}
                      className={cn(
                        'w-full px-3 py-2.5 text-left transition-colors hover:bg-surface-2',
                        selected?.id === report.id && 'bg-surface-2',
                      )}
                    >
                      <span className="block truncate text-xs font-medium text-ink">
                        {report.title}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-ink-faint">
                        {periodLabel(report.period_start, report.period_end)}
                        {report.kind === 'daily_report' ? ' · daily' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            {selected && (
              <Panel className="overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-ink">{selected.title}</h2>
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {periodLabel(selected.period_start, selected.period_end)}
                      {' · '}
                      {selected.author === 'claude' ? 'Written by Claude' : selected.author}
                      {selected.model ? ` (${selected.model})` : ''}
                      {' · updated '}
                      {formatRelative(selected.updated_at)}
                    </p>
                  </div>
                  <Button
                    variant="dangerGhost"
                    size="sm"
                    onClick={() => {
                      // Every other destructive action in the app confirms;
                      // this one destroyed a report Claude spent a call
                      // writing, on one click, with no toast either way.
                      if (!window.confirm(
                        `Delete "${selected.title}"? This cannot be undone.`,
                      )) return
                      if (selected.id === selectedId) setSelectedId(null)
                      deleteDocument.mutate(selected.id, {
                        onSuccess: () => toast.success('Report deleted'),
                      })
                    }}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                </div>

                <div className="px-4 py-4">
                  <Markdown>{selected.body_md}</Markdown>
                </div>

                {Object.keys(selected.summary_json ?? {}).length > 0 && (
                  <details className="border-t border-line px-4 py-3">
                    <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                      <FileText className="mr-1 inline size-3" />
                      Figures this was written from
                    </summary>
                    <pre className="tabular mt-2 overflow-x-auto rounded-[5px] bg-base p-3 text-[10px] leading-relaxed text-ink-dim">
                      {JSON.stringify(selected.summary_json, null, 2)}
                    </pre>
                  </details>
                )}
              </Panel>
            )}
          </div>
        )}
      </PageBody>
    </>
  )
}
