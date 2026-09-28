import {
  CalendarPlus, FileText, Grip, Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff, Users, X,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ConferenceControls } from '@/components/dialer/ConferenceControls'
import { useDialer } from '@/hooks/useDialer'
import { useDraggable } from '@/hooks/useDraggable'
import { useLead } from '@/hooks/useLeads'
import { useSessionScript } from '@/hooks/useScripts'
import { useWorkspace } from '@/hooks/useWorkspace'
import { OUTCOME_LABELS, type CallOutcome } from '@/lib/types'
import { cn, formatPhone } from '@/lib/utils'
import { ScriptPrompter } from './ScriptPrompter'
import { CallStatePill } from './CallStatePill'
import { DispositionBar } from './DispositionBar'
import { Keypad } from './Keypad'
import { MicPicker } from './MicPicker'
import { toast } from 'sonner'

/**
 * The global dial-anything widget. Available from every page, and the surface
 * a rep should use to smoke-test Twilio before ever touching a lead list.
 */
export function FloatingDialer() {
  const {
    state, activeCall, pendingDisposition, duration, muted, digits,
    widgetOpen, widgetDraft, deviceError,
    startCall, hangUp, toggleMute, sendDigit,
    disposition, dismissDisposition, openWidget, closeWidget, setWidgetDraft,
    openBooking,
  } = useDialer()
  const { twilioReady, workspace } = useWorkspace()

  const { position, dragging, nodeRef, onPointerDown, reset } = useDraggable('cs.dialer_position')

  // The prompter used to exist only inside a calling session, so the most
  // common flow — click a lead, dial from the widget — had no script at all.
  // Passing null falls back to the workspace default.
  const script = useSessionScript(null)
  const promptLead = useLead(activeCall?.leadId ?? null)
  const [showScript, setShowScript] = useState(true)
  /*
   * The panel was a fixed 19rem, which is fine for a keypad and cramped for a
   * script you are reading aloud mid-call. Remembered like the position is:
   * whoever widens it once means it.
   */
  const [wide, setWide] = useState(() => localStorage.getItem('cs.dialer_wide') === '1')
  const toggleWide = () => {
    setWide((prev) => {
      const next = !prev
      try {
        localStorage.setItem('cs.dialer_wide', next ? '1' : '0')
      } catch { /* private mode; the size just will not persist */ }
      return next
    })
  }
  const [callNote, setCallNote] = useState('')

  const inCall = state !== 'idle'
  const isConference = state === 'conferencing' || activeCall?.mode === 'conference'

  // Collapsed: a live call keeps a visible handle so it can never be lost
  // behind a page navigation.
  if (!widgetOpen) {
    return (
      <>
      <button
        type="button"
        onClick={() => openWidget()}
        className={cn(
          'fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border px-4 py-3',
          'shadow-xl shadow-black/50 transition-colors',
          inCall
            ? 'animate-pulse-ring border-accent/40 bg-accent text-black'
            : 'border-line bg-elevated text-ink hover:bg-[#262b34]',
        )}
      >
        <Phone className="size-4" />
        <span className="text-[13px] font-medium">
          {inCall ? formatPhone(activeCall?.phone) : 'Dialer'}
        </span>
        {inCall && (
          <span className="tabular text-xs opacity-80">
            {String(Math.floor(duration / 60)).padStart(2, '0')}:
            {String(duration % 60).padStart(2, '0')}
          </span>
        )}
      </button>
      </>
    )
  }

  const handleDial = () => {
    if (!widgetDraft.trim()) return
    void startCall({
      phone: widgetDraft,
      mode: isConference ? 'conference' : 'direct',
      // The widget shows the default script, so the call was worked from one.
      scriptId: script.data?.id ?? null,
    })
  }

  const handleDisposition = (outcome: CallOutcome, callbackAt?: string | null) => {
    // The booking sheet is opened by disposition() itself now, so every
    // surface gets it rather than only the ones that remembered to ask.
    disposition(outcome, callNote.trim() || undefined, callbackAt)
      .then(() => {
        setCallNote('')
        toast.success(`Logged: ${OUTCOME_LABELS[outcome]}`)
      })
      .catch((error: Error) => toast.error(error.message))
  }

  return (
    <>
    <div
      ref={nodeRef as React.RefObject<HTMLDivElement>}
      className={cn(
        'fixed z-40 overflow-hidden rounded-lg border border-line bg-surface',
        wide ? 'w-[30rem]' : 'w-[19rem]',
        'shadow-2xl shadow-black/60',
        // Only anchor to the corner while the panel has never been moved.
        position ? 'bottom-auto right-auto' : 'bottom-5 right-5',
        dragging && 'select-none',
      )}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div
        onPointerDown={onPointerDown}
        onDoubleClick={reset}
        title="Drag to move · double-click to reset"
        className={cn(
          'flex items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-2',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <div className="flex items-center gap-2">
          <Grip className="size-3.5 text-ink-faint" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
            Dialer
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <CallStatePill state={state} duration={duration} />
          {inCall && script.data && (
            <Button
              variant="ghost"
              size="iconSm"
              title={showScript ? 'Hide the script' : 'Show the script'}
              onClick={() => setShowScript((v) => !v)}
            >
              <FileText className={cn(showScript && 'text-accent')} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="iconSm"
            title={wide ? 'Make the dialer narrow' : 'Make the dialer wider'}
            onClick={toggleWide}
          >
            {wide ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button variant="ghost" size="iconSm" onClick={closeWidget}>
            <X />
          </Button>
        </div>
      </div>


      {inCall && script.data && showScript && (
        <div className={cn(
          'overflow-y-auto border-b border-line',
          wide ? 'max-h-[34rem]' : 'max-h-[22rem]',
        )}>
          <ScriptPrompter
            script={script.data}
            lead={promptLead.data}
            resetKey={activeCall?.logId ?? null}
            recording={workspace?.recording_enabled ?? true}
            className="rounded-none border-0"
          />
        </div>
      )}

      <div className="space-y-3 p-3">
        {!twilioReady && (
          <p className="rounded-[5px] border border-warn/30 bg-warn/10 px-2.5 py-2 text-[11px] leading-relaxed text-warn">
            Twilio is not configured yet. Add your Account SID, Auth Token, and
            number in Settings to place calls.
          </p>
        )}

        {deviceError && (
          <p className="rounded-[5px] border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] leading-relaxed text-danger">
            {deviceError}
          </p>
        )}

        {/* Number / active call header */}
        {inCall ? (
          <div className="rounded-[6px] border border-line bg-base px-3 py-2.5">
            <p className="truncate text-[13px] font-medium text-ink">
              {activeCall?.businessName
                ?? (activeCall?.direction === 'inbound' ? 'Incoming call' : 'Outbound call')}
            </p>
            <p className="tabular mt-0.5 text-xs text-ink-dim">
              {formatPhone(activeCall?.phone)}
            </p>
            {digits && (
              <p className="tabular mt-1.5 border-t border-line-soft pt-1.5 text-xs text-accent">
                Sent: {digits}
              </p>
            )}
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Input
              value={widgetDraft}
              onChange={(event) => setWidgetDraft(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleDial()}
              placeholder="(555) 010-9999"
              className="tabular"
              inputMode="tel"
              autoFocus
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setWidgetDraft('')}
              disabled={!widgetDraft}
              title="Clear"
            >
              <X />
            </Button>
          </div>
        )}

        {/* The keypad is always mounted while a call exists, at every state. */}
        <Keypad
          compact
          onDigit={(digit) => (inCall ? sendDigit(digit) : setWidgetDraft(widgetDraft + digit))}
        />

        {/* Call controls */}
        {inCall ? (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-1.5">
              <Button variant={muted ? 'primary' : 'secondary'} onClick={toggleMute}>
                {muted ? <MicOff /> : <Mic />}
                {muted ? 'Muted' : 'Mute'}
              </Button>
              <Button
                variant="secondary"
                title="Book an appointment while they are on the line"
                onClick={() =>
                  openBooking({
                    id: activeCall?.leadId,
                    businessName: activeCall?.businessName,
                  })
                }
              >
                <CalendarPlus />
                Book
              </Button>
              <Button variant="danger" onClick={hangUp}>
                <PhoneOff />
                End
              </Button>
            </div>

            {/* Roster and "bring someone in", shared with the lead panel. The
                old Add button here demanded a number typed by hand every time,
                which left the agent number saved in Settings unreachable from
                anywhere in the app. */}
            <ConferenceControls compact />
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            <Button
              variant="primary"
              className="col-span-3"
              onClick={handleDial}
              disabled={!widgetDraft.trim() || !twilioReady}
            >
              <Phone />
              Call
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (!widgetDraft.trim()) return
                void startCall({
                  phone: widgetDraft,
                  mode: 'conference',
                  scriptId: script.data?.id ?? null,
                })
              }}
              disabled={!widgetDraft.trim() || !twilioReady}
              title="Join-me mode: you enter a conference and the lead is dialed in"
            >
              <Users />
            </Button>
          </div>
        )}

        {/* Post-call disposition */}
        {pendingDisposition && !inCall && (
          <div className="space-y-2 rounded-[6px] border border-line bg-base p-2.5">
            <div className="flex items-center justify-between">
              <Badge tone="info">How did it go?</Badge>
              <Button variant="ghost" size="iconSm" onClick={dismissDisposition}>
                <X />
              </Button>
            </div>
            <Textarea
              value={callNote}
              onChange={(event) => setCallNote(event.target.value)}
              placeholder="What happened? Saved with the outcome."
              rows={2}
              className="mb-2 text-[11px]"
            />
            <DispositionBar size="sm" onSelect={handleDisposition} />
          </div>
        )}

        <div className="border-t border-line-soft pt-2.5">
          <MicPicker compact />
        </div>
      </div>
    </div>
    </>
  )
}
