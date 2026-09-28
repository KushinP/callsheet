import {
  ArrowLeft, Ban, Bot, CalendarPlus, Check, Globe, MapPin, Mic, MicOff, Pause, Phone, PhoneCall, PhoneOff, Play, SkipForward, Square, Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { CallStatePill } from '@/components/dialer/CallStatePill'
import { DispositionBar } from '@/components/dialer/DispositionBar'
import { Keypad } from '@/components/dialer/Keypad'
import { MicPicker } from '@/components/dialer/MicPicker'
import { ScriptPicker } from '@/components/dialer/ScriptPicker'
import { ScriptPrompter } from '@/components/dialer/ScriptPrompter'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/table'
import { useLeadCallHistory } from '@/hooks/useCalls'
import { ACTIVE_STATES, useDialer } from '@/hooks/useDialer'
import {
  useCompleteSessionLead, useSession, useSessionQueue, useUpdateSessionStatus,
} from '@/hooks/useSessions'
import { useSessionScript } from '@/hooks/useScripts'
import { useWorkspace } from '@/hooks/useWorkspace'
import {
  OUTCOME_LABELS, OUTCOME_TONES, QUICK_DISPOSITIONS, type CallOutcome,
} from '@/lib/types'
import { cn, formatDateTime, formatPhone, formatRelative, errorMessage } from '@/lib/utils'

/** Breathing room between hanging up and the next number ringing. */
const AUTO_DIAL_DELAY_SECONDS = 3

export function SessionDialerPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { twilioReady, workspace } = useWorkspace()

  const session = useSession(sessionId)
  const queue = useSessionQueue(sessionId)
  const script = useSessionScript(session.data?.script_id)
  const updateStatus = useUpdateSessionStatus()
  const completeLead = useCompleteSessionLead()

  const {
    state, pendingDisposition, duration, muted, digits,
    startCall, hangUp, toggleMute, sendDigit, disposition, addAgent, closeWidget,
    openBooking,
  } = useDialer()

  const [countdown, setCountdown] = useState<number | null>(null)
  const [addingAgent, setAddingAgent] = useState(false)
  const [callNote, setCallNote] = useState('')

  // Read through a ref so changing the script mid-session does not re-create
  // dialNow and reset the auto-dial countdown.
  const scriptIdRef = useRef<string | null>(null)
  useEffect(() => {
    scriptIdRef.current = script.data?.id ?? null
  }, [script.data?.id])

  const entries = queue.data ?? []
  const current = useMemo(() => entries.find((e) => e.status === 'queued') ?? null, [entries])
  const upNext = useMemo(
    () => entries.filter((e) => e.status === 'queued').slice(1, 9),
    [entries],
  )
  const done = entries.filter((e) => e.status === 'done' || e.status === 'skipped').length

  /*
   * The last lead you finished with, so you can go back to it.
   *
   * A session only ever moved forward, which is fine until you mis-tap a
   * disposition or hang up before they finish a sentence — and then the only
   * way back was to leave the session, find the lead, and dial it by hand.
   *
   * By completed_at rather than queue order: "back" means the one you just
   * left, and if you have already gone back once, forward again, the most
   * recently touched is still the right answer.
   */
  const previous = useMemo(() => {
    const finished = entries.filter(
      (e) => (e.status === 'done' || e.status === 'skipped') && e.completed_at,
    )
    if (finished.length === 0) return null
    return finished.reduce((latest, e) =>
      (e.completed_at ?? '') > (latest.completed_at ?? '') ? e : latest)
  }, [entries])

  const isActive = session.data?.status === 'active'
  const inCall = ACTIVE_STATES.includes(state)
  const awaitingDisposition = Boolean(pendingDisposition)

  /*
   * Leads whose dial could not even start. The database rejects a do-not-call
   * insert outright, so startCall returns null with nothing to disposition and
   * the queue entry stays 'queued' — which the auto-dialer reads as "dial this
   * again in three seconds", forever. Remembering the failure is what breaks
   * that; the entry is also marked skipped so the queue actually advances.
   */
  const undialable = useRef<Set<string>>(new Set())

  const dialCurrent = useCallback(() => {
    if (!current?.leads || !sessionId) return
    setCountdown(null)
    const entryId = current.id
    void startCall({
      phone: current.leads.phone,
      businessName: current.leads.business_name,
      leadId: current.leads.id,
      sessionId,
      scriptId: scriptIdRef.current,
    }).then((logId) => {
      if (logId) return
      undialable.current.add(entryId)
      completeLead.mutate({ id: entryId, status: 'skipped' })
    })
  }, [current, sessionId, startCall, completeLead])

  // Auto-advance: while the session is active and nothing is in flight, count
  // down and dial the next lead in the queue.
  useEffect(() => {
    if (
      !isActive || inCall || awaitingDisposition || !current || !twilioReady ||
      // The manual Call button has always been guarded on do_not_call; the
      // automatic path was not, which is how a flagged number at the head of a
      // queue produced a rejection toast every three seconds.
      current.leads?.do_not_call ||
      undialable.current.has(current.id)
    ) {
      setCountdown(null)
      return
    }

    setCountdown(AUTO_DIAL_DELAY_SECONDS)
    const timer = setInterval(() => {
      setCountdown((value) => {
        if (value === null) return null
        if (value <= 1) {
          clearInterval(timer)
          return 0
        }
        return value - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [isActive, inCall, awaitingDisposition, current?.id, twilioReady, current])

  // Separate from the ticker so the dial fires exactly once at zero.
  useEffect(() => {
    if (countdown === 0) dialCurrent()
  }, [countdown, dialCurrent])

  // The queue ran dry — close the session out.
  const closedOut = useRef(false)
  useEffect(() => {
    if (isActive && !current && entries.length > 0 && !inCall && !awaitingDisposition) {
      // updateStatus's identity changes as isPending flips while isActive stays
      // true until the refetch lands, so this effect re-runs two or three times
      // and toasts each time. The ref makes it fire exactly once per session.
      if (closedOut.current) return
      closedOut.current = true
      updateStatus.mutate({ id: sessionId!, status: 'completed' })
      toast.success('Session complete')
    }
  }, [isActive, current, entries.length, inCall, awaitingDisposition, sessionId, updateStatus])

  const canDisposition = awaitingDisposition || inCall

  /*
   * Two ScriptPrompters would each bind their own window keydown and own their
   * own cursor, so Space advances both and they drift onto different steps of
   * the same script. Leads.tsx collapses the widget for exactly this reason;
   * this page has a full-width prompter of its own, so it must too.
   */
  useEffect(() => {
    if (inCall) closeWidget()
  }, [inCall, closeWidget])

  // Mirrors call_should_record() in SQL: the session's explicit choice wins,
  // otherwise the workspace default. The database is still the authority; this
  // only decides what the rep is told.
  const isRecording =
    session.data?.record_calls ?? workspace?.recording_enabled ?? true

  // The listener is bound once and reads through refs, so it never re-attaches
  // mid-call and never closes over a stale handler.
  const canDispositionRef = useRef(canDisposition)
  const handleDispositionRef = useRef<(o: CallOutcome) => Promise<void>>(async () => {})
  const skipRef = useRef<() => Promise<void>>(async () => {})
  canDispositionRef.current = canDisposition

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (target?.isContentEditable) return
      // Any open dialog or sheet owns the keyboard. Without this, pressing S
      // while looking at the booking form silently skips the NEXT lead, and
      // 1-6 disposition a call you are no longer looking at.
      if (target?.closest('[role="dialog"]')) return

      // 1-6 disposition, in the order the chips are drawn.
      const digit = Number.parseInt(event.key, 10)
      if (digit >= 1 && digit <= QUICK_DISPOSITIONS.length) {
        if (!canDispositionRef.current) return
        event.preventDefault()
        void handleDispositionRef.current(QUICK_DISPOSITIONS[digit - 1])
        return
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        void skipRef.current()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleDisposition = async (outcome: CallOutcome, callbackAt?: string | null) => {
    const entry = pendingDisposition
      ? entries.find((e) => e.lead_id === pendingDisposition.leadId && e.status === 'queued')
      : current

    try {
      await disposition(outcome, callNote.trim() || undefined, callbackAt)
      setCallNote('')
    } catch (error) {
      // The outcome did not save, so the lead must stay in the queue rather
      // than being marked done against a call that has no recorded result.
      toast.error((error as Error).message)
      return
    }

    if (entry) await completeLead.mutateAsync({ id: entry.id, outcome })
    toast.success(`Logged: ${OUTCOME_LABELS[outcome]}`)

    // Book it now, while it is still in mind. This is the moment the
    // appointment gets forgotten, so the booking comes to the rep rather than
    // waiting on a page they have to remember to open.
    if (outcome === 'appointment_set') {
    }
  }

  const skipCurrent = async () => {
    if (!current) return
    await completeLead.mutateAsync({ id: current.id, status: 'skipped' })
  }

  handleDispositionRef.current = handleDisposition
  skipRef.current = skipCurrent

  if (session.isLoading) {
    return (
      <>
        <PageHeader title="Session" />
        <PageBody>
          <Skeleton className="h-96 w-full" />
        </PageBody>
      </>
    )
  }

  const lead = current?.leads ?? null
  const progressPct = session.data?.total_leads
    ? Math.round((done / session.data.total_leads) * 100)
    : 0

  return (
    <>
      <PageHeader
        title={session.data?.name ?? 'Session'}
        badge={
          <span className="flex items-center gap-2">
            <CallStatePill state={state} duration={duration} />
            {isRecording && (
              <Badge tone="bad">
                <span className="size-1.5 rounded-full bg-current" />
                REC
              </Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/sessions">
                <ArrowLeft />
                Sessions
              </Link>
            </Button>

            {/* useCallLog has always supported a session filter; nothing linked
                to it, so a finished session could not be reviewed. */}
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/calls?session=${sessionId}`}>
                <PhoneCall />
                Calls
              </Link>
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={!previous || inCall}
              title={
                previous
                  ? `Back to ${previous.leads?.business_name ?? 'the last lead'}`
                  : 'Nothing behind you yet'
              }
              onClick={() => {
                if (!previous) return
                /*
                 * Pause as well as re-queue. Re-queueing alone makes it the
                 * current lead, and the auto-dialer would ring it three seconds
                 * later — which is not what "go back" means when you came back
                 * to fix a disposition rather than to redial.
                 */
                undialable.current.delete(previous.id)
                completeLead.mutate({
                  id: previous.id,
                  status: 'queued',
                  // Keep what was logged. Coming back to look at a lead should
                  // not erase the outcome you are coming back to look at.
                  outcome: previous.outcome ?? null,
                })
                if (isActive) updateStatus.mutate({ id: sessionId!, status: 'paused' })
              }}
            >
              <ArrowLeft />
              Back
            </Button>

            {isActive ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateStatus.mutate({ id: sessionId!, status: 'paused' })}
              >
                <Pause />
                Pause
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!current || !twilioReady}
                onClick={() => updateStatus.mutate({ id: sessionId!, status: 'active' })}
              >
                <Play />
                {session.data?.status === 'paused' ? 'Resume' : 'Start'}
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              disabled={session.data?.status === 'completed'}
              onClick={() => {
                if (inCall) hangUp()
                updateStatus.mutate({ id: sessionId!, status: 'completed' })
              }}
            >
              <Square />
              Stop
            </Button>
          </>
        }
      />


      <PageBody className="space-y-4">
        {!twilioReady && (
          <p className="rounded-[6px] border border-warn/30 bg-warn/10 px-3 py-2.5 text-xs text-warn">
            Twilio is not configured. Add your credentials in{' '}
            <Link to="/settings" className="font-medium underline">
              Settings
            </Link>{' '}
            before starting this session.
          </p>
        )}

        {/* Progress */}
        <Panel className="px-4 py-3">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                  Progress
                </span>
                <span className="tabular text-xs text-ink-dim">
                  {done} of {session.data?.total_leads ?? 0} · {progressPct}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
                <div
                  className="h-full bg-accent transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
            <Badge tone={isActive ? 'good' : 'neutral'}>
              {session.data?.status ?? 'pending'}
            </Badge>
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-[1fr_20rem] xl:grid-cols-[1fr_24rem]">
          {/* Current lead */}
          <div className="space-y-4">
            {lead ? (
              <Panel>
                <PanelHeader
                  title={lead.business_name}
                  description={formatPhone(lead.phone)}
                  actions={
                    <>
                      {lead.outcome && (
                        <Badge tone={OUTCOME_TONES[lead.outcome]}>
                          {OUTCOME_LABELS[lead.outcome]}
                        </Badge>
                      )}
                      <Badge tone="neutral">
                        {lead.call_count} prior {lead.call_count === 1 ? 'call' : 'calls'}
                      </Badge>
                    </>
                  }
                />

                <div className="grid gap-4 p-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <dl className="space-y-2">
                      {lead.address && (
                        <div className="flex items-start gap-2 text-xs">
                          <MapPin className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
                          <span className="text-ink-dim">
                            {lead.address}
                            {lead.city && `, ${lead.city}`}
                            {lead.state && `, ${lead.state}`}
                            {lead.zip && ` ${lead.zip}`}
                          </span>
                        </div>
                      )}
                      {lead.website && (
                        <div className="flex items-start gap-2 text-xs">
                          <Globe className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
                          <a
                            href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="truncate text-accent hover:underline"
                          >
                            {lead.website}
                          </a>
                        </div>
                      )}
                    </dl>

                    {lead.notes && (
                      <div className="rounded-[6px] border border-line bg-base p-3">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                          Notes
                        </p>
                        <p className="text-xs leading-relaxed text-ink-dim">{lead.notes}</p>
                      </div>
                    )}

                    <PriorCalls leadId={lead.id} />
                  </div>

                  {/* Call controls */}
                  <div className="space-y-3">
                    {inCall ? (
                      <>
                        <div className="rounded-[6px] border border-line bg-base px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <CallStatePill state={state} duration={duration} />
                            {digits && (
                              <span className="tabular text-xs text-accent">{digits}</span>
                            )}
                          </div>
                        </div>

                        {/* Visible for the entire call, phone trees included. */}
                        <Keypad compact onDigit={sendDigit} />

                        {workspace?.voice_agent_number && (
                          <Button
                            variant="secondary"
                            className="w-full"
                            disabled={addingAgent}
                            onClick={() => {
                              setAddingAgent(true)
                              addAgent()
                                .catch((e: Error) =>
                                  toast.error(errorMessage(e, 'Could not add the agent')))
                                .finally(() => setAddingAgent(false))
                            }}
                          >
                            <Bot />
                            {addingAgent ? 'Bringing them in…' : 'Add agent to this call'}
                          </Button>
                        )}

                        <div className="grid grid-cols-3 gap-2">
                          <Button variant={muted ? 'primary' : 'secondary'} onClick={toggleMute}>
                            {muted ? <MicOff /> : <Mic />}
                            {muted ? 'Unmute' : 'Mute'}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              openBooking({ id: lead?.id, businessName: lead?.business_name })
                            }
                          >
                            <CalendarPlus />
                            Book
                          </Button>
                          <Button variant="danger" onClick={hangUp}>
                            <PhoneOff />
                            Hang up
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        <Button
                          variant="primary"
                          size="lg"
                          className="w-full"
                          disabled={!twilioReady || lead.do_not_call}
                          onClick={dialCurrent}
                        >
                          <Phone />
                          {countdown !== null && countdown > 0
                            ? `Dialing in ${countdown}…`
                            : `Call ${formatPhone(lead.phone)}`}
                        </Button>

                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            variant="secondary"
                            disabled={!twilioReady || lead.do_not_call}
                            onClick={() => {
                              setCountdown(null)
                              void startCall({
                                phone: lead.phone,
                                businessName: lead.business_name,
                                leadId: lead.id,
                                sessionId,
                                scriptId: script.data?.id ?? null,
                                mode: 'conference',
                              })
                            }}
                          >
                            <Users />
                            Join-me
                          </Button>
                          <Button variant="outline" onClick={() => void skipCurrent()}>
                            <SkipForward />
                            Skip
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 rounded-[6px] border border-line bg-base p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                        {awaitingDisposition ? 'How did it go?' : 'Disposition'}
                      </p>
                      <Textarea
                        value={callNote}
                        onChange={(event) => setCallNote(event.target.value)}
                        placeholder="What happened? Saved with the outcome."
                        rows={2}
                        className="mb-2 text-[11px]"
                      />
                      <DispositionBar
                        size="sm"
                        showKeys
                        onSelect={(outcome, callbackAt) => void handleDisposition(outcome, callbackAt)}
                        disabled={!canDisposition}
                      />
                      <p className="mt-2 text-[10px] text-ink-faint">
                        {canDisposition
                          ? 'Press 1–6 to log · S to skip'
                          : 'Dispositions unlock once a call is connected or has just ended.'}
                      </p>
                    </div>

                    <MicPicker compact />
                  </div>
                </div>
              </Panel>
            ) : (
              <Panel>
                <EmptyState
                  icon={<Check />}
                  title={entries.length ? 'Queue complete' : 'Nothing queued'}
                  description={
                    entries.length
                      ? `All ${entries.length} leads in this session have been called or skipped.`
                      : 'This session has no leads. Build a new one from a filtered slice of your list.'
                  }
                  action={
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/sessions">Back to sessions</Link>
                    </Button>
                  }
                />
              </Panel>
            )}
          </div>

          {/* Right column: the script the rep reads from, then the queue.
              Sticky so the script stays put while the lead card scrolls. */}
          <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
            {sessionId && (
              <ScriptPicker sessionId={sessionId} scriptId={session.data?.script_id} />
            )}

            {script.data ? (
              <ScriptPrompter
                script={script.data}
                lead={lead}
                resetKey={current?.id ?? null}
                recording={isRecording}
              />
            ) : (
              // Previously this was `{script.data && …}` — with no script and no
              // workspace default, the panel rendered nothing at all and gave no
              // hint that a script was even possible.
              <Panel className="h-fit">
                <EmptyState
                  title="No script attached"
                  description="Pick one above to read from during the call, or write one first."
                  action={
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/scripts">Go to Scripts</Link>
                    </Button>
                  }
                />
              </Panel>
            )}

            <Panel className="h-fit">
            <PanelHeader
              title="Up next"
              description={`${entries.filter((e) => e.status === 'queued').length} remaining`}
            />
            {upNext.length ? (
              <ul className="divide-y divide-line-soft">
                {upNext.map((entry, index) => (
                  <li key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="tabular w-5 shrink-0 text-[11px] text-ink-faint">
                      {index + 2}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-ink">
                        {entry.leads?.business_name ?? 'Unknown'}
                      </p>
                      <p className="tabular text-[11px] text-ink-faint">
                        {formatPhone(entry.leads?.phone)}
                      </p>
                    </div>
                    {entry.leads?.do_not_call && (
                      <Badge tone="bad">
                        <Ban className="size-2.5" />
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-ink-faint">
                Nothing else queued.
              </p>
            )}
            </Panel>
          </div>
        </div>
      </PageBody>
    </>
  )
}

function PriorCalls({ leadId }: { leadId: string }) {
  const history = useLeadCallHistory(leadId)

  if (!history.data?.length) return null

  return (
    <div className="rounded-[6px] border border-line bg-base p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        Previous calls
      </p>
      <ul className="space-y-1.5">
        {history.data.slice(0, 4).map((call) => (
          <li key={call.id} className="flex items-center gap-2 text-[11px]">
            <span className="tabular text-ink-faint" title={formatDateTime(call.called_at)}>
              {formatRelative(call.called_at)}
            </span>
            {call.outcome && (
              <span className={cn('text-ink-dim')}>{OUTCOME_LABELS[call.outcome]}</span>
            )}
            {call.notes && <span className="truncate text-ink-faint">— {call.notes}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
