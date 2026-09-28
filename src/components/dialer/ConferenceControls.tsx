/**
 * Who is on the call, and how to change that.
 *
 * Lives in one place because it belongs on two surfaces — the floating widget
 * and the lead panel, which is where calls are actually placed from now. A
 * second copy of "drop this participant" is the kind of duplication that ends
 * with the two disagreeing about whether the prospect is still on the line.
 */
import { Phone, UserMinus, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDialer } from '@/hooks/useDialer'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, errorMessage, formatPhone } from '@/lib/utils'

export function ConferenceControls({ compact = false }: { compact?: boolean }) {
  const { participants, dropParticipant, addAgent, addToConference, activeCall } = useDialer()
  const { workspace } = useWorkspace()
  const [showOther, setShowOther] = useState(false)
  const [other, setOther] = useState('')
  const [busy, setBusy] = useState(false)

  const agentNumber = workspace?.voice_agent_number ?? null

  // Already a conference? Then this is just another guest for the existing
  // room. Routing it through addAgent would re-escalate a call that has
  // already been escalated, redirecting legs that are sitting in the room
  // quite happily.
  const inConference = activeCall?.mode === 'conference' && Boolean(activeCall.conferenceName)

  const bring = (phone?: string) => {
    const target = phone ?? agentNumber
    if (inConference && !target) return

    setBusy(true)
    const work = inConference && target
      ? addToConference(target)
      : addAgent(phone)

    work
      .then(() => {
        setOther('')
        setShowOther(false)
      })
      // Without this the rejection floats: no toast, no error, the input just
      // sits there looking like nothing happened.
      .catch((error: Error) => toast.error(errorMessage(error, 'Could not add that number')))
      .finally(() => setBusy(false))
  }

  return (
    <div className="space-y-1.5">
      {participants.length > 0 && (
        <div className="space-y-1 rounded-[5px] border border-line bg-surface-2 p-1.5">
          {participants.map((person) => (
            <div key={person.callSid} className="flex items-center gap-2 px-1">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  person.onHold ? 'bg-warn' : person.muted ? 'bg-ink-faint' : 'bg-accent',
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                {person.label}
                {person.number && (
                  <span className="ml-1 text-ink-faint">{formatPhone(person.number)}</span>
                )}
              </span>
              {person.role === 'you' ? (
                <span className="shrink-0 text-[10px] text-ink-faint">you</span>
              ) : (
                <Button
                  variant="ghost"
                  size="iconSm"
                  title={`Drop ${person.label} without ending the call`}
                  onClick={() => {
                    dropParticipant(person.callSid)
                      .then(() => toast.success(`Dropped ${person.label}`))
                      .catch((error: Error) =>
                        toast.error(errorMessage(error, 'Could not drop that participant')),
                      )
                  }}
                >
                  <UserMinus />
                </Button>
              )}
            </div>
          ))}

          {/* The room outlives any single guest, so this is a real state and
              not an error — worth saying rather than showing a list of one. */}
          {participants.length === 1 && participants[0].role === 'you' && (
            <p className="px-1 pt-0.5 text-[10px] text-warn">
              Everyone else has left. End the call when you're done.
            </p>
          )}
        </div>
      )}

      <div className={cn('grid gap-1.5', agentNumber ? 'grid-cols-2' : 'grid-cols-1')}>
        {/* One click, using the number saved in Settings. The widget already
            had this; the lead panel — where calls are actually placed from —
            had no way to bring anyone in at all. */}
        {agentNumber && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => bring()}
            title={`Bring in ${formatPhone(agentNumber)}`}
          >
            <UserPlus />
            {compact ? 'Agent' : 'Add agent'}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => setShowOther((open) => !open)}
          title="Bring another number onto this call"
        >
          <UserPlus />
          {agentNumber ? 'Someone else' : 'Add someone'}
        </Button>
      </div>

      {showOther && (
        <div className="flex gap-1.5">
          <Input
            value={other}
            onChange={(event) => setOther(event.target.value)}
            placeholder="Number to add"
            className="tabular h-8"
            inputMode="tel"
            autoFocus
          />
          <Button
            variant="primary"
            size="icon"
            disabled={!other.trim() || busy}
            onClick={() => bring(other)}
          >
            <Phone />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setShowOther(false)}>
            <X />
          </Button>
        </div>
      )}
    </div>
  )
}
