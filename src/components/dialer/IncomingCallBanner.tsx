import { Phone, PhoneOff, User } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useDialer } from '@/hooks/useDialer'
import { formatPhone } from '@/lib/utils'

/**
 * Somebody is calling the number back, right now.
 *
 * Rendered by the provider rather than by the dialer widget, for the same
 * reason the booking sheet is: the widget spends most of its life collapsed to
 * a pill, and a call you have twenty seconds to answer cannot be behind a
 * click. It sits above everything and on every page.
 *
 * The name comes from the <Parameter>s twilio-voice attaches to the client leg,
 * so a callback from a lead arrives as that lead — which is the entire point of
 * answering the phone inside the CRM rather than on a mobile.
 */
export function IncomingCallBanner() {
  const { incomingCall, answerCall, declineCall } = useDialer()

  if (!incomingCall) return null

  const known = Boolean(incomingCall.businessName)

  return (
    <div
      role="alertdialog"
      aria-label="Incoming call"
      className="fixed inset-x-0 top-4 z-[70] mx-auto w-[min(24rem,calc(100vw-2rem))]"
    >
      <div className="animate-pulse-ring overflow-hidden rounded-lg border border-accent/40 bg-surface shadow-2xl shadow-black/60">
        <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">
            Incoming call
          </span>
        </div>

        <div className="space-y-3 p-3">
          <div>
            <p className="truncate text-sm font-medium text-ink">
              {incomingCall.businessName ?? 'Unknown caller'}
            </p>
            <p className="tabular mt-0.5 text-xs text-ink-dim">
              {formatPhone(incomingCall.from)}
            </p>
            {/* Said plainly: an unrecognised number on an outbound-only line is
                usually a callback from someone whose number you do not have,
                and that is worth knowing before you pick up. */}
            {!known && (
              <p className="mt-1 text-[11px] text-ink-faint">
                Not matched to any lead.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="primary" onClick={answerCall}>
              <Phone />
              Answer
            </Button>
            <Button variant="danger" onClick={declineCall}>
              <PhoneOff />
              Decline
            </Button>
          </div>

          {incomingCall.leadId && (
            <Link
              to={`/leads?lead=${incomingCall.leadId}`}
              className="flex items-center gap-1.5 text-[11px] text-ink-dim hover:text-accent"
            >
              <User className="size-3" />
              Open the lead while it rings
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
