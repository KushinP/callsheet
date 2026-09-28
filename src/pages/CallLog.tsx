import {
  ChevronDown, ChevronRight, ExternalLink, Mic, PhoneCall, PhoneIncoming,
  CalendarDays, PhoneMissed, Radio, Search, Trash2, X,
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { RecordingPlayer } from '@/components/calls/RecordingPlayer'
import { CallNote } from '@/components/calls/CallNote'
import { Transcript } from '@/components/calls/Transcript'
import { DispositionBar } from '@/components/dialer/DispositionBar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import {
  Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger,
} from '@/components/ui/dropdown'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/misc'
import { Panel } from '@/components/ui/panel'
import { TableSkeleton } from '@/components/ui/skeleton'
import { EmptyState, Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table'
import {
  CALL_LOG_PAGE_SIZE, useCallLog, useDeleteCalls, useMissedCalls, useUpdateCallOutcome,
} from '@/hooks/useCalls'
import {
  ALL_OUTCOMES, OUTCOME_LABELS, OUTCOME_TONES, transcriptOf, transcriptRow, type CallOutcome,
} from '@/lib/types'
import { describeQuality } from '@/lib/callQuality'
import { cn, errorMessage, formatDateTime, formatDuration, formatPhone } from '@/lib/utils'

export function CallLogPage() {
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [outcomes, setOutcomes] = useState<CallOutcome[]>([])
  const [view, setView] = useState<'all' | 'inbound' | 'outbound' | 'missed'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const missed = useMissedCalls()

  const [searchParams, setSearchParams] = useSearchParams()
  /*
   * In the URL rather than local state, so the dashboard's "Calls today" card
   * can open exactly what it counts. A number on a card that cannot be clicked
   * into is a number you have to take on trust.
   */
  const todayOnly = searchParams.get('today') === '1'
  const leadFilter = searchParams.get('lead')
  const sessionFilter = searchParams.get('session')
  const callParam = searchParams.get('call')

  /*
   * Deep link to one call. `expanded` is local state, so before this a call
   * could be filtered to but never opened — the lead panel could say "here is
   * the call" and had no way to hand you the call itself.
   */
  useEffect(() => {
    if (callParam) setExpanded(callParam)
  }, [callParam])

  const calls = useCallLog({
    direction: view === 'inbound' || view === 'outbound' ? view : null,
    missedOnly: view === 'missed',
    todayOnly,
    page,
    search: debouncedSearch,
    outcomes,
    leadId: leadFilter,
    sessionId: sessionFilter,
  })

  // Same dead end as Leads: Pagination renders only when there are rows, so a
  // page past the end has no way back.
  useEffect(() => {
    const total = calls.data?.total
    if (total === undefined) return
    const last = Math.max(0, Math.ceil(total / CALL_LOG_PAGE_SIZE) - 1)
    if (page > last) setPage(last)
  }, [calls.data?.total, page])
  const updateOutcome = useUpdateCallOutcome()
  const deleteCalls = useDeleteCalls()

  const rows = calls.data?.calls ?? []
  const allOnPageSelected = rows.length > 0 && rows.every((c) => selected.has(c.id))

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      // Select every row on this page, or clear them if they are all already on.
      for (const c of rows) allOnPageSelected ? next.delete(c.id) : next.add(c.id)
      return next
    })

  const confirmDelete = async () => {
    const ids = [...selected]
    try {
      const count = await deleteCalls.mutateAsync(ids)
      toast.success(`Deleted ${count} ${count === 1 ? 'call' : 'calls'}`)
      setSelected(new Set())
      setConfirmingDelete(false)
      if (expanded && ids.includes(expanded)) setExpanded(null)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not delete'))
    }
  }

  // Debounce the query without firing one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const reDisposition = async (
    callId: string,
    leadId: string | null,
    outcome: CallOutcome,
    callbackAt?: string | null,
  ) => {
    try {
      await updateOutcome.mutateAsync({ callId, leadId, outcome, callbackAt })
      toast.success(`Updated to ${OUTCOME_LABELS[outcome]}`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <>
      <PageHeader
        title="Call Log"
        badge={
          calls.data ? <Badge tone="neutral">{calls.data.total.toLocaleString()}</Badge> : undefined
        }
      />

      <PageBody className="space-y-3">
        {(leadFilter || sessionFilter) && (
          <div className="flex items-center gap-2 rounded-[5px] border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
            <span className="text-ink-dim">
              Showing calls for one {leadFilter ? 'lead' : 'session'} only.
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setSearchParams({})
                setPage(0)
              }}
            >
              <X />
              Show all calls
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(0)
                // A selection made under one filter must not survive into
                // another, or Delete reaches rows that are no longer on screen.
                setSelected(new Set())
              }}
              placeholder="Search business or phone…"
              className="pl-8"
            />
          </div>

          {/* The one your voicemail light would have shown you. It reads the
              generated `missed` column, so it cannot disagree with the count
              on the dashboard. */}
          <Button
            variant={todayOnly ? 'primary' : 'outline'}
            title="Calls since midnight, in your local time"
            onClick={() => {
              setPage(0)
              setSelected(new Set())
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev)
                if (todayOnly) next.delete('today')
                else next.set('today', '1')
                return next
              })
            }}
          >
            <CalendarDays />
            Today
          </Button>

          <Button
            variant={view === 'missed' ? 'primary' : 'outline'}
            onClick={() => {
              setPage(0)
              setSelected(new Set())
              setView((prev) => (prev === 'missed' ? 'all' : 'missed'))
            }}
          >
            <PhoneMissed />
            Missed
            {missed.data && missed.data.length > 0 && view !== 'missed' && (
              <span className="tabular rounded-[3px] bg-danger/15 px-1 text-[10px] text-danger">
                {missed.data.length}
              </span>
            )}
          </Button>

          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant={view === 'inbound' || view === 'outbound' ? 'primary' : 'outline'}>
                {view === 'inbound' ? 'Inbound' : view === 'outbound' ? 'Outbound' : 'Direction'}
                <ChevronDown />
              </Button>
            </DropdownTrigger>
            <DropdownContent align="start">
              {([
                ['all', 'All calls'],
                ['inbound', 'Inbound only'],
                ['outbound', 'Outbound only'],
              ] as const).map(([value, label]) => (
                <DropdownItem
                  key={value}
                  onSelect={() => {
                    setPage(0)
                    setSelected(new Set())
                    setView(value)
                  }}
                >
                  <Checkbox
                    checked={view === value || (value === 'all' && view === 'missed')}
                    className="pointer-events-none"
                  />
                  {label}
                </DropdownItem>
              ))}
            </DropdownContent>
          </Dropdown>

          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="outline" className="gap-1.5">
                Outcome
                {outcomes.length > 0 && (
                  <span className="tabular rounded-[3px] bg-accent/15 px-1 text-[10px] text-accent">
                    {outcomes.length}
                  </span>
                )}
                <ChevronDown />
              </Button>
            </DropdownTrigger>
            <DropdownContent align="start" className="max-h-80 overflow-y-auto">
              <DropdownLabel>Filter by outcome</DropdownLabel>
              {ALL_OUTCOMES.map((outcome) => (
                <DropdownItem
                  key={outcome}
                  onSelect={(event) => {
                    event.preventDefault()
                    setPage(0)
                    setSelected(new Set())
                    setOutcomes((prev) =>
                      prev.includes(outcome)
                        ? prev.filter((o) => o !== outcome)
                        : [...prev, outcome],
                    )
                  }}
                >
                  <Checkbox checked={outcomes.includes(outcome)} className="pointer-events-none" />
                  {OUTCOME_LABELS[outcome]}
                </DropdownItem>
              ))}
              {outcomes.length > 0 && (
                <>
                  <DropdownSeparator />
                  <DropdownItem onSelect={() => setOutcomes([])}>Clear</DropdownItem>
                </>
              )}
            </DropdownContent>
          </Dropdown>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-[6px] border border-accent/30 bg-accent/5 px-3 py-2">
            <span className="text-xs text-ink">
              <span className="tabular font-medium">{selected.size}</span>{' '}
              {selected.size === 1 ? 'call' : 'calls'} selected
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                <X />
                Clear
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
                <Trash2 />
                Delete
              </Button>
            </div>
          </div>
        )}

        <Panel className="overflow-hidden">
          {calls.isLoading ? (
            <TableSkeleton rows={10} cols={6} />
          ) : calls.isError ? (
            <ErrorState what="calls" error={calls.error} onRetry={() => void calls.refetch()} />
          ) : calls.data?.calls.length ? (
            <>
              <Table>
                <THead>
                  <tr>
                    <TH className="w-px pr-0">
                      <Checkbox
                        checked={allOnPageSelected}
                        onCheckedChange={togglePage}
                        aria-label="Select all calls on this page"
                      />
                    </TH>
                    <TH className="w-px" />
                    <TH>Business</TH>
                    <TH>Phone</TH>
                    <TH>Outcome</TH>
                    <TH className="text-right">Duration</TH>
                    <TH>Recording</TH>
                    <TH>Called at</TH>
                  </tr>
                </THead>
                <TBody>
                  {calls.data.calls.map((call) => {
                    const isOpen = expanded === call.id
                    const transcript = transcriptOf(call)

                    return (
                      <Fragment key={call.id}>
                        <TR
                          className="cursor-pointer"
                          onClick={() => setExpanded(isOpen ? null : call.id)}
                        >
                          <TD className="pr-0" onClick={(event) => event.stopPropagation()}>
                            <Checkbox
                              checked={selected.has(call.id)}
                              onCheckedChange={() => toggleOne(call.id)}
                              aria-label={`Select call to ${call.business_name ?? call.phone}`}
                            />
                          </TD>
                          <TD className="pr-0 text-ink-faint">
                            {isOpen ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )}
                          </TD>
                          <TD className="max-w-64 font-medium">
                            <span className="flex items-center gap-1.5">
                              {/* Inbound is the warmest thing in this list and
                                  was indistinguishable from outbound before. */}
                              {call.direction === 'inbound' && (
                                <PhoneIncoming
                                  className="size-3 shrink-0 text-accent"
                                  aria-label="Incoming call"
                                />
                              )}
                              <span className="truncate">
                                {call.business_name ?? formatPhone(call.phone)}
                              </span>
                            </span>
                            {/* One line of the note in the row itself. A note
                                readable only after expanding the row it belongs
                                to cannot be scanned, which is the only thing
                                anybody wants to do with a call log. */}
                            {call.notes && (
                              <span
                                className="mt-0.5 block truncate text-[11px] font-normal text-ink-faint"
                                title={call.notes}
                              >
                                {call.notes}
                              </span>
                            )}
                          </TD>
                          <TD className="tabular text-ink-dim">{formatPhone(call.phone)}</TD>
                          <TD>
                            <span className="flex items-center gap-1.5">
                              {/* The outcome outranks missed, not the other way
                                  round. Missed was winning on the argument that
                                  a call nobody took has nothing to disposition —
                                  which is true right up until somebody
                                  dispositions it, and then a row reading "Not
                                  interested, too few rooms" was still shouting
                                  MISSED in red at the person who wrote it. */}
                              {call.outcome ? (
                                <Badge tone={OUTCOME_TONES[call.outcome]}>
                                  {OUTCOME_LABELS[call.outcome]}
                                </Badge>
                              ) : call.missed ? (
                                <Badge tone="bad">
                                  {call.recording_sid ? 'Voicemail' : 'Missed'}
                                </Badge>
                              ) : (
                                <Badge tone="neutral">Not set</Badge>
                              )}
                              {/* Still true, and still worth knowing: this one
                                  rang out before it was dealt with. Said quietly,
                                  because it is history now rather than a task. */}
                              {call.missed && call.outcome && (
                                <span
                                  className="text-[10px] text-ink-faint"
                                  title="Nobody picked up when this call came in"
                                >
                                  missed
                                </span>
                              )}
                            </span>
                          </TD>
                          <TD className="tabular text-right text-ink-dim">
                            {formatDuration(call.duration_seconds)}
                          </TD>
                          <TD>
                            {call.recording_sid ? (
                              <span className="flex items-center gap-1.5 text-[11px] text-accent">
                                <Mic className="size-3" />
                                Available
                              </span>
                            ) : (
                              <span className="text-[11px] text-ink-faint">—</span>
                            )}
                          </TD>
                          <TD className="whitespace-nowrap text-ink-faint">
                            {formatDateTime(call.called_at)}
                          </TD>
                        </TR>

                        {isOpen && (
                          <tr className="bg-base">
                            <td colSpan={8} className="px-6 py-4">
                              {/* lead_id was used for writes and never rendered,
                                  so a call was a dead end. */}
                              {call.lead_id && (
                                <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px]">
                                  <Link
                                    to={`/leads?lead=${call.lead_id}`}
                                    className="inline-flex items-center gap-1 text-accent hover:underline"
                                  >
                                    <ExternalLink className="size-3" />
                                    Open this lead
                                  </Link>
                                  <Link
                                    to={`/calls?lead=${call.lead_id}`}
                                    onClick={() => setPage(0)}
                                    className="inline-flex items-center gap-1 text-ink-dim hover:text-ink hover:underline"
                                  >
                                    <PhoneCall className="size-3" />
                                    All calls to this lead
                                  </Link>
                                  {call.session_id && (
                                    <Link
                                      to={`/calls?session=${call.session_id}`}
                                      onClick={() => setPage(0)}
                                      className="inline-flex items-center gap-1 text-ink-dim hover:text-ink hover:underline"
                                    >
                                      <Radio className="size-3" />
                                      All calls in this session
                                    </Link>
                                  )}
                                </div>
                              )}
                              <div className="grid gap-4 lg:grid-cols-2">
                                <div className="space-y-3">
                                  <div>
                                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                                      Recording
                                    </p>
                                    {call.recording_sid ? (
                                      <RecordingPlayer callId={call.id} />
                                    ) : (
                                      <p className="text-[11px] text-ink-faint">
                                        No recording. Twilio can take a few seconds to
                                        finish processing after a call ends.
                                      </p>
                                    )}
                                  </div>

                                  <div>
                                    <div className="mb-1.5 flex items-center justify-between">
                                      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                                        Change outcome
                                      </p>
                                      <Button
                                        variant="dangerGhost"
                                        size="sm"
                                        onClick={() => {
                                          setSelected(new Set([call.id]))
                                          setConfirmingDelete(true)
                                        }}
                                      >
                                        <Trash2 />
                                        Delete call
                                      </Button>
                                    </div>
                                    <DispositionBar
                                      size="sm"
                                      selected={call.outcome}
                                      onSelect={(outcome, callbackAt) =>
                                        void reDisposition(
                                          call.id, call.lead_id, outcome, callbackAt,
                                        )
                                      }
                                    />
                                  </div>
                                </div>

                                <div className="space-y-3">
                                  <dl className="grid grid-cols-2 gap-3">
                                    {[
                                      ['Status', call.call_status],
                                      ['Mode', call.mode],
                                      ['Twilio call SID', call.twilio_call_sid ?? '—'],
                                      ['Parent SID', call.parent_call_sid ?? '—'],
                                      // Which mic, which codec, how the line held
                                      // up. The first report of muffled audio had
                                      // nothing to check but a transcript.
                                      ['Audio', describeQuality(call.quality)],
                                    ].map(([label, value]) => (
                                      <div key={label}>
                                        <dt className="text-[10px] uppercase tracking-wider text-ink-faint">
                                          {label}
                                        </dt>
                                        <dd
                                          className={cn(
                                            'mt-0.5 truncate text-[11px] text-ink-dim',
                                            label?.includes('SID') && 'tabular',
                                          )}
                                          title={value ?? undefined}
                                        >
                                          {value}
                                        </dd>
                                      </div>
                                    ))}
                                  </dl>

                                  <CallNote callId={call.id} notes={call.notes ?? null} />

                                </div>
                              </div>

                              {/* Full width, below the two columns. A six-minute
                                  conversation read at half the row width was the
                                  other half of why it was unreadable. */}
                              <div className="mt-4">
                                <p className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">
                                  Transcript
                                </p>
                                {transcript ? (
                                  <Transcript
                                    text={transcript}
                                    speakerConfidence={transcriptRow(call)?.speaker_confidence}
                                  />
                                ) : (
                                  <p className="text-[11px] leading-relaxed text-ink-dim">
                                    {/* "No transcript" is a claim, and for the first
                                        minute after a call it is a false one — the
                                        audio is still being fetched and run through
                                        the model. */}
                                    {call.recorded &&
                                      Date.now() - new Date(call.called_at).getTime() <
                                        15 * 60 * 1000
                                      ? 'Transcribing… this usually lands about a minute after the call.'
                                      : 'No transcript for this call.'}
                                  </p>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </TBody>
              </Table>
              <Pagination
                page={page}
                pageSize={CALL_LOG_PAGE_SIZE}
                total={calls.data.total}
                // Clear the selection when the page changes. Otherwise the
                // action bar keeps reporting rows that are no longer on screen,
                // and Delete reaches records the user cannot see.
                onPageChange={(next) => {
                  setSelected(new Set())
                  setPage(next)
                }}
              />
            </>
          ) : (
            <EmptyState
              icon={<PhoneCall />}
              title="No calls logged"
              description="Every call placed from the session dialer or the floating widget lands here automatically, with its recording and outcome."
            />
          )}
        </Panel>
      </PageBody>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent
          title={`Delete ${selected.size} ${selected.size === 1 ? 'call' : 'calls'}?`}
          description="This cannot be undone."
          size="sm"
        >
          <DialogBody className="space-y-3 text-xs leading-relaxed text-ink-dim">
            <p>
              {selected.size === 1
                ? 'The call, its recording and any transcript'
                : 'The calls, their recordings and any transcripts'}{' '}
              will be removed, and the affected leads' call counts recalculated.
            </p>
            <p className="text-ink-faint">
              Leads flagged Do Not Call keep that flag — it lives on the lead, not the call.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmDelete()}
              disabled={deleteCalls.isPending}
            >
              <Trash2 />
              Delete {selected.size === 1 ? 'call' : `${selected.size} calls`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
