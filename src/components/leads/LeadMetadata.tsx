/**
 * Everything else known about a lead.
 *
 * `metadata_json` is written by two paths — a CSV import stores the entire
 * original row, and Claude's `create_leads` puts anything without a column here
 * — and until now it was rendered by neither. On a real list that meant the
 * booking engine, a second phone number, front-desk hours and the source of the
 * lead were all sitting in the database where nobody could see them, and the
 * only way to read your own research back was to ask Claude for it.
 *
 * Deliberately read-only. These are notes, not fields: giving them an editor
 * would invite a second, competing place to record things that deserve columns.
 */
import { formatPhone } from '@/lib/utils'

/**
 * Keys that duplicate a real column. A CSV import copies every mapped column
 * into the bag as well, so without this the panel would show `business_name`
 * and `city` a second time, and a promoted key would look like a rival value.
 */
const SHADOWED = new Set([
  'business_name', 'contact_name', 'phone', 'phone_normalized', 'address',
  'city', 'state', 'zip', 'website', 'email', 'notes', 'room_count',
  'owner', 'ask_for', 'tier', 'tags',
  'pipeline_stage', 'status', 'outcome', 'do_not_call', 'demo_booked',
])

/*
 * `rooms` is only a duplicate when room_count actually holds the number. On the
 * seventy leads whose room count could not be reduced to an integer — "15 + 2
 * apts", "13 main (closed) + 21 lodge" — the prose is the ONLY thing known, and
 * hiding it would take away the very nuance the column was allowed not to
 * carry.
 */
const ROOM_KEYS = ['rooms', 'approx_rooms']

/** "owner_on_site" reads better as "owner on site". */
const label = (key: string) => key.replace(/[_-]+/g, ' ')

/** Values that look like a phone number are worth reading as one. */
function display(key: string, value: string): string {
  const digits = value.replace(/\D/g, '')
  if (/phone|number|tel/.test(key) && digits.length >= 10) return formatPhone(value)
  return value
}

export function LeadMetadata({
  data,
  roomCount,
}: {
  data: Record<string, unknown>
  roomCount?: number | null
}) {
  const rows = Object.entries(data ?? {})
    .filter(([key, value]) => {
      if (SHADOWED.has(key)) return false
      if (ROOM_KEYS.includes(key) && roomCount != null) return false
      if (value === null || value === undefined) return false
      const text = String(value).trim()
      // "unverified" is Claude honestly recording that it does not know, which
      // is worth nothing on screen and crowds out what it does know.
      return text !== '' && text.toLowerCase() !== 'unverified'
    })
    .map(([key, value]) => [key, String(value).trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b))

  if (rows.length === 0) return null

  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        What else we know
      </p>
      <dl className="divide-y divide-line-soft rounded-[6px] border border-line">
        {rows.map(([key, value]) => (
          <div key={key} className="flex gap-3 px-3 py-1.5">
            <dt className="w-32 shrink-0 truncate text-[11px] capitalize text-ink-faint">
              {label(key)}
            </dt>
            <dd className="flex-1 break-words text-[11px] text-ink-dim">
              {display(key, value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
