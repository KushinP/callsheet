import { Check, ClipboardList, Clock3, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/table'
import { useCompleteTask, useCreateTask, useSnoozeTask, useTasks } from '@/hooks/useTasks'
import type { Task } from '@/lib/types'
import { cn, formatRelative } from '@/lib/utils'

/** Overdue first, because that is the only grouping that changes what you do next. */
function bucket(due: string): 'overdue' | 'today' | 'later' {
  const d = new Date(due)
  const now = new Date()
  if (d < now) return 'overdue'
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  return d <= endOfDay ? 'today' : 'later'
}

const GROUPS = [
  { key: 'overdue' as const, label: 'Overdue', tone: 'bad' as const },
  { key: 'today' as const, label: 'Today', tone: 'good' as const },
  { key: 'later' as const, label: 'Coming up', tone: 'neutral' as const },
]

export function TaskList() {
  const tasks = useTasks({ status: 'open' })
  const complete = useCompleteTask()
  const [closing, setClosing] = useState<Task | null>(null)
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [snoozing, setSnoozing] = useState<Task | null>(null)
  const [snoozeReason, setSnoozeReason] = useState('')
  const snooze = useSnoozeTask()
  const [draft, setDraft] = useState({ title: '', due: '', body: '' })
  const createTask = useCreateTask()

  const rows = tasks.data ?? []
  const grouped = GROUPS.map((g) => ({
    ...g,
    items: rows.filter((t) => bucket(t.due_at) === g.key),
  })).filter((g) => g.items.length > 0)

  return (
    <>
      <Panel>
        <PanelHeader
          title="Follow-ups"
          description="Created when a lead changes stage. Claude can work these through the connector."
          actions={
            <div className="flex items-center gap-2">
              {rows.length > 0 && <Badge tone="neutral">{rows.length}</Badge>}
              {/* The mutation behind this was written and never called, so
                  "remind me to ring them Thursday" was a thing only Claude
                  could do. */}
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                <Plus />
                Add
              </Button>
            </div>
          }
        />

        {tasks.isLoading ? (
          <div className="p-3"><Skeleton className="h-24 w-full" /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ClipboardList />}
            title="Nothing due"
            description="Move a lead into Demo booked or Pilot and its playbook will put the follow-ups here — or add one yourself."
          />
        ) : (
          <div className="divide-y divide-line-soft">
            {grouped.map((group) => (
              <div key={group.key} className="px-3 py-2">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  {group.label}
                </p>
                <ul className="space-y-1">
                  {group.items.map((task) => (
                    <li key={task.id} className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="iconSm"
                        title="Mark done"
                        onClick={() => {
                          setClosing(task)
                          setNote('')
                        }}
                      >
                        <Check />
                      </Button>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-ink">{task.title}</span>
                        {task.leads && (
                          <Link
                            to={`/leads?lead=${task.lead_id}`}
                            className="text-[10px] text-ink-faint hover:text-accent hover:underline"
                          >
                            {task.leads.business_name}
                          </Link>
                        )}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-[10px]',
                          group.key === 'overdue' ? 'text-warn' : 'text-ink-faint',
                        )}
                      >
                        {formatRelative(task.due_at)}
                      </span>
                      {/* Without this the only honest options for work you
                          cannot do today were marking it done, which is a lie,
                          or leaving it overdue for ever. */}
                      <Button
                        variant="ghost"
                        size="iconSm"
                        title={
                          task.snooze_count >= 3
                            ? 'Snoozed three times already — finish it or hand it to someone'
                            : 'Push this back'
                        }
                        disabled={task.snooze_count >= 3}
                        onClick={() => {
                          setSnoozing(task)
                          setSnoozeReason('')
                        }}
                      >
                        <Clock3 />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Dialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open)
          if (!open) setDraft({ title: '', due: '', body: '' })
        }}
      >
        <DialogContent
          title="Add a follow-up"
          description="Yours, not a playbook's — it will sit in this list until you close it."
          size="sm"
        >
          <DialogBody className="space-y-3">
            <Field label="What needs doing">
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="Ring them back about pricing"
              />
            </Field>
            <Field label="When" hint="Defaults to 9am tomorrow if left blank.">
              <Input
                type="datetime-local"
                value={draft.due}
                onChange={(e) => setDraft((d) => ({ ...d, due: e.target.value }))}
              />
            </Field>
            <Field label="Notes" hint="Optional. Claude reads these too.">
              <Textarea
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                rows={3}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!draft.title.trim() || createTask.isPending}
              onClick={() => {
                // A follow-up with no date would never surface in a list
                // grouped by when things are due.
                const due = draft.due
                  ? new Date(draft.due)
                  : (() => {
                      const d = new Date()
                      d.setDate(d.getDate() + 1)
                      d.setHours(9, 0, 0, 0)
                      return d
                    })()
                createTask.mutate(
                  {
                    title: draft.title.trim(),
                    due_at: due.toISOString(),
                    body_md: draft.body.trim() || null,
                  },
                  {
                    onSuccess: () => {
                      toast.success('Follow-up added')
                      setAdding(false)
                      setDraft({ title: '', due: '', body: '' })
                    },
                  },
                )
              }}
            >
              {createTask.isPending ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(snoozing)} onOpenChange={(open) => !open && setSnoozing(null)}>
        <DialogContent
          title="Push this back"
          description={snoozing?.title}
          size="sm"
        >
          <DialogBody className="space-y-3">
            <Field
              label="Why"
              hint={
                snoozing
                  ? `Snoozed ${snoozing.snooze_count} of 3 times. The reason is appended to the task.`
                  : undefined
              }
            >
              <Textarea
                value={snoozeReason}
                onChange={(event) => setSnoozeReason(event.target.value)}
                placeholder="Waiting on their booking manager to be back Monday."
                rows={3}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSnoozing(null)}>Cancel</Button>
            {[
              { label: 'Tomorrow', days: 1 },
              { label: '3 days', days: 3 },
              { label: 'Next week', days: 7 },
            ].map((option) => (
              <Button
                key={option.label}
                variant="secondary"
                disabled={!snoozeReason.trim() || snooze.isPending}
                onClick={() => {
                  const due = new Date()
                  due.setDate(due.getDate() + option.days)
                  due.setHours(9, 0, 0, 0)
                  snooze.mutate(
                    { id: snoozing!.id, dueAt: due.toISOString(), reason: snoozeReason.trim() },
                    {
                      onSuccess: () => {
                        toast.success(`Pushed back to ${option.label.toLowerCase()}`)
                        setSnoozing(null)
                      },
                    },
                  )
                }}
              >
                {option.label}
              </Button>
            ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(closing)} onOpenChange={(open) => !open && setClosing(null)}>
        <DialogContent title="Mark done" description={closing?.title} size="sm">
          <DialogBody>
            {/* A tick with no record is not worth storing — the same rule the MCP
                tool enforces on Claude applies here. */}
            <Field label="What did you do?" hint="Kept with the task, so the list stays a record.">
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="Sent the recap with pilot pricing."
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!note.trim() || complete.isPending}
              onClick={() =>
                complete.mutate(
                  { id: closing!.id, note: note.trim() },
                  {
                    onSuccess: () => {
                      toast.success('Done')
                      setClosing(null)
                    },
                  },
                )
              }
            >
              <Check />
              Mark done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
