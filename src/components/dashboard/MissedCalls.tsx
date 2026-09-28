import { PhoneMissed, Voicemail } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useMissedCalls } from '@/hooks/useCalls'
import { formatPhone, formatRelative } from '@/lib/utils'

/**
 * Someone rang and nobody picked up.
 *
 * Renders nothing when there is nothing to chase — a permanent empty "Missed
 * calls" panel trains you to stop looking at the one place this ever appears.
 * Rows drop off on their own once the number has been called back or the call
 * has been given an outcome by hand, so this is a list of work, not an archive.
 */
export function MissedCalls() {
  const missed = useMissedCalls()
  // useMissedCalls already drops the ones called back.
  const rows = missed.data ?? []

  if (rows.length === 0) return null

  return (
    <div className="rounded-[6px] border border-danger/30 bg-danger/[0.06]">
      <div className="flex items-center gap-2 border-b border-danger/20 px-4 py-2.5">
        <PhoneMissed className="size-3.5 shrink-0 text-danger" />
        <p className="text-[11px] font-semibold uppercase tracking-wider text-danger">
          {rows.length} missed {rows.length === 1 ? 'call' : 'calls'}
        </p>
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to="/calls">Open call log</Link>
        </Button>
      </div>

      <ul className="divide-y divide-danger/15">
        {rows.slice(0, 5).map((row) => (
          <li key={row.id} className="flex items-center gap-3 px-4 py-2">
            <span className="flex-1 truncate text-xs text-ink">
              {row.business_name ?? formatPhone(row.phone)}
            </span>
            {row.has_voicemail && (
              <Badge tone="info">
                <Voicemail className="size-3" />
                Voicemail
              </Badge>
            )}
            <span className="tabular shrink-0 text-[11px] text-ink-faint">
              {formatRelative(row.called_at)}
            </span>
            {/* An unknown number has no lead to open, so send those to the log
                entry instead of a link that goes nowhere. */}
            <Button asChild variant="outline" size="sm">
              <Link to={row.lead_id ? `/leads?lead=${row.lead_id}` : '/calls'}>
                {row.lead_id ? 'Open lead' : 'View'}
              </Link>
            </Button>
          </li>
        ))}
        {rows.length > 5 && (
          <li className="px-4 py-2 text-[11px] text-ink-faint">
            and {rows.length - 5} more in the call log
          </li>
        )}
      </ul>
    </div>
  )
}
