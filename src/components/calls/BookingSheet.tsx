import { CalendarPlus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import type { Lead } from '@/lib/types'

const WIDGET_SRC = 'https://assets.calendly.com/assets/external/widget.js'
const WIDGET_CSS = 'https://assets.calendly.com/assets/external/widget.css'

/** Loaded once, on demand — no reason to ship a third-party script to someone
 *  who never books anything. */
let widgetPromise: Promise<void> | null = null
function loadWidget(): Promise<void> {
  if (widgetPromise) return widgetPromise
  widgetPromise = new Promise((resolve, reject) => {
    // The popup needs Calendly's stylesheet; the inline embed did not, which is
    // why this was previously script-only.
    if (!document.querySelector(`link[href="${WIDGET_CSS}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = WIDGET_CSS
      document.head.appendChild(link)
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGET_SRC}"]`)
    if (existing) return resolve()
    const script = document.createElement('script')
    script.src = WIDGET_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Calendly widget failed to load'))
    document.head.appendChild(script)
  })
  return widgetPromise
}

/**
 * Booking, at the moment it is remembered.
 *
 * Calendly's own popup rather than an inline embed in a panel. The inline
 * widget was rendered into a 672px slide-over where it did not self-size — a
 * 150px iframe inside a 600px box, showing a logo and a corner ribbon and none
 * of the calendar. A scheduling grid needs the width of a screen, and Calendly
 * ships an overlay that takes one.
 *
 * Prefill only carries what is already on the lead. Nothing is written back
 * from here; the parent listens for the scheduled event and records the date.
 */
export function BookingSheet({
  lead,
  calendlyUrl,
  open,
  onClose,
  onScheduled,
}: {
  lead: { business_name: string; email?: string | null; phone?: string } | Lead | null
  calendlyUrl: string | null | undefined
  open: boolean
  onClose: () => void
  /** Fires when Calendly says a booking completed. `startsAt` when it tells us. */
  onScheduled?: (startsAt: string | null) => void
}) {
  const opened = useRef(false)

  const src = (() => {
    if (!calendlyUrl) return null
    try {
      const url = new URL(calendlyUrl)
      if (lead?.business_name) url.searchParams.set('name', lead.business_name)
      if (lead?.email) url.searchParams.set('email', lead.email)
      url.searchParams.set('hide_gdpr_banner', '1')
      return url.toString()
    } catch {
      return null
    }
  })()

  /*
   * The listener lives here rather than in the popup, because Calendly's
   * overlay is outside our React tree entirely — it appends itself to <body>
   * and we never see its lifecycle.
   */
  useEffect(() => {
    if (!open) return
    const onMessage = (event: MessageEvent) => {
      if (typeof event.origin !== 'string' || !event.origin.includes('calendly.com')) return
      const data = event.data as { event?: string; payload?: Record<string, unknown> } | null
      if (data?.event !== 'calendly.event_scheduled') return

      const payload = data.payload ?? {}
      const startsAt =
        (payload.event as { start_time?: string } | undefined)?.start_time ??
        (payload as { start_time?: string }).start_time ??
        null

      onScheduled?.(typeof startsAt === 'string' ? startsAt : null)
      onClose()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open, onScheduled, onClose])

  /*
   * Hand straight off to Calendly's overlay when there is somewhere to go. Our
   * own dialog then has nothing to render, so it stays shut — two modals
   * stacked over each other is exactly the "hard to use" this replaces.
   */
  useEffect(() => {
    if (!open || !src) { opened.current = false; return }
    if (opened.current) return
    opened.current = true

    void loadWidget()
      .then(() => {
        const w = (window as unknown as {
          Calendly?: { initPopupWidget(o: { url: string }): void }
        }).Calendly
        if (w) w.initPopupWidget({ url: src })
        else window.open(src, '_blank', 'noopener')
      })
      // Blocked script, offline, ad blocker — the link still works, so degrade
      // to opening it rather than showing an empty panel.
      .catch(() => window.open(src, '_blank', 'noopener'))
  }, [open, src])

  // Only reachable when there is no link to open. Everything else is Calendly's
  // overlay, which owns the whole screen and closes itself.
  if (src) return null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title="Book the appointment"
        description={lead?.business_name ?? undefined}
        size="sm"
      >
        <DialogBody className="space-y-3 py-6 text-center">
          <CalendarPlus className="mx-auto size-8 text-ink-faint" />
          <p className="text-xs text-ink-dim">No scheduling link set up yet.</p>
          <p className="mx-auto max-w-sm text-[11px] leading-relaxed text-ink-faint">
            Paste your Calendly link in Settings and it will open here every time you log an
            appointment, prefilled with the lead's details.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" asChild>
            <Link to="/settings" onClick={onClose}>Go to Settings</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
