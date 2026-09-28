import { Loader2, Play, Radio, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { LeadFilterBar } from '@/components/leads/LeadFilterBar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Select } from '@/components/ui/select'
import { TableSkeleton } from '@/components/ui/skeleton'
import { EmptyState, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import {
  useCreateSession, useDeleteSession, useSessionPreviewCount, useSessions,
} from '@/hooks/useSessions'
import { useScripts } from '@/hooks/useScripts'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { LeadFilters, SessionStatus } from '@/lib/types'
import { errorMessage, formatRelative } from '@/lib/utils'

/** Sentinel for "no explicit choice — follow the workspace". */
const INHERIT = '__inherit__'

const STATUS_TONES: Record<SessionStatus, 'good' | 'info' | 'warn' | 'neutral'> = {
  pending: 'info',
  active: 'good',
  paused: 'warn',
  completed: 'neutral',
}

export function SessionsPage() {
  const sessions = useSessions()
  const deleteSession = useDeleteSession()
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <>
      <PageHeader
        title="Sessions"
        description="A frozen, ordered queue built from a filtered slice of your leads"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Radio />
            New session
          </Button>
        }
      />

      <PageBody>
        <Panel className="overflow-hidden">
          {sessions.isLoading ? (
            <TableSkeleton rows={6} cols={5} />
          ) : sessions.isError ? (
            <ErrorState
              what="sessions"
              error={sessions.error}
              onRetry={() => void sessions.refetch()}
            />
          ) : sessions.data?.length ? (
            <Table>
              <THead>
                <tr>
                  <TH>Session</TH>
                  <TH>Status</TH>
                  <TH className="w-56">Progress</TH>
                  <TH>Created</TH>
                  <TH className="w-px" />
                </tr>
              </THead>
              <TBody>
                {sessions.data.map((session) => {
                  const pct = session.total_leads
                    ? Math.round((session.completed_leads / session.total_leads) * 100)
                    : 0

                  return (
                    <TR key={session.id}>
                      <TD className="max-w-72">
                        <Link
                          to={`/sessions/${session.id}`}
                          className="truncate font-medium hover:text-accent"
                        >
                          {session.name}
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone={STATUS_TONES[session.status]}>{session.status}</Badge>
                      </TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-elevated">
                            <div
                              className="h-full bg-accent transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="tabular whitespace-nowrap text-[11px] text-ink-faint">
                            {session.completed_leads}/{session.total_leads}
                          </span>
                        </div>
                      </TD>
                      <TD className="text-ink-faint">{formatRelative(session.created_at)}</TD>
                      <TD>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="iconSm" asChild title="Open dialer">
                            <Link to={`/sessions/${session.id}`}>
                              <Play className="text-accent" />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="iconSm"
                            title="Delete session"
                            onClick={() => {
                              if (!window.confirm(`Delete "${session.name}"? Calls already logged are kept.`)) return
                              deleteSession.mutate(session.id)
                            }}
                          >
                            <Trash2 className="text-ink-faint hover:text-danger" />
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          ) : (
            <EmptyState
              icon={<Radio />}
              title="No sessions yet"
              description="A session freezes a filtered slice of your leads into an ordered queue, deduplicated by phone number, so the same business is never dialed twice in one run."
              action={
                <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                  <Radio />
                  New session
                </Button>
              }
            />
          )}
        </Panel>
      </PageBody>

      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  )
}

function CreateSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const createSession = useCreateSession()
  const scripts = useScripts()
  const { workspace } = useWorkspace()

  const [name, setName] = useState('')
  const [filters, setFilters] = useState<LeadFilters>({})
  const [maxLeads, setMaxLeads] = useState(200)
  const [scriptId, setScriptId] = useState(INHERIT)
  const [recordCalls, setRecordCalls] = useState(INHERIT)

  const preview = useSessionPreviewCount(filters, open)
  const matched = preview.data ?? 0
  const queued = Math.min(matched, maxLeads)

  const submit = async () => {
    const finalName = name.trim() || `Session ${new Date().toLocaleDateString()}`

    try {
      const sessionId = await createSession.mutateAsync({
        name: finalName,
        filters,
        maxLeads,
        scriptId: scriptId === INHERIT ? null : scriptId,
        recordCalls: recordCalls === INHERIT ? null : recordCalls === 'always',
      })
      toast.success(`Queued ${queued.toLocaleString()} leads`)
      onOpenChange(false)
      setName('')
      setFilters({})
      navigate(`/sessions/${sessionId}`)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not build the session'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New calling session"
        description="Pick the slice of leads to work through."
        size="xl"
      >
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Session name" className="sm:col-span-2">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={`Session ${new Date().toLocaleDateString()}`}
              />
            </Field>
            <Field label="Max leads" hint="Caps the queue length.">
              <Input
                type="number"
                min={1}
                max={5000}
                value={maxLeads}
                onChange={(event) => setMaxLeads(Number(event.target.value) || 1)}
                className="tabular"
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Script" hint="What the prompter reads from.">
              <Select
                value={scriptId}
                onValueChange={setScriptId}
                options={[
                  { value: INHERIT, label: 'Workspace default' },
                  ...(scripts.data ?? []).map((sc) => ({
                    value: sc.id,
                    label: sc.is_default ? `${sc.name} (default)` : sc.name,
                  })),
                ]}
              />
            </Field>
            <Field
              label="Record calls"
              hint={
                recordCalls === INHERIT
                  ? `Following the workspace setting (${workspace?.recording_enabled === false ? 'off' : 'on'}).`
                  : 'Overrides the workspace setting for this session only.'
              }
            >
              <Select
                value={recordCalls}
                onValueChange={setRecordCalls}
                options={[
                  { value: INHERIT, label: 'Workspace default' },
                  { value: 'always', label: 'Always record' },
                  { value: 'never', label: 'Never record' },
                ]}
              />
            </Field>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">
              Filter the leads
            </p>
            <LeadFilterBar filters={filters} onChange={setFilters} />
          </div>

          <div className="rounded-[6px] border border-line bg-base px-3 py-3">
            <div className="flex items-baseline gap-2">
              {preview.isLoading ? (
                <Loader2 className="size-4 animate-spin text-ink-faint" />
              ) : (
                <span className="tabular text-2xl font-semibold text-accent">
                  {queued.toLocaleString()}
                </span>
              )}
              <span className="text-xs text-ink-dim">leads will be queued</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              {matched.toLocaleString()} match these filters
              {matched > maxLeads && `, capped at ${maxLeads.toLocaleString()}`}. Leads
              flagged Do Not Call are excluded, and the queue is deduplicated by phone
              number so one business is never dialed twice in this session.
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={createSession.isPending || queued === 0}
          >
            {createSession.isPending && <Loader2 className="animate-spin" />}
            Build session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
