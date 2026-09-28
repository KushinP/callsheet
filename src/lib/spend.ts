/**
 * What a call costs.
 *
 * These are Twilio and Gemini list prices, kept in one visible place because
 * they change and because a number buried in SQL is a number nobody audits.
 * Everything here is an ESTIMATE — Twilio's actual invoice is the truth, and
 * this exists to stop a month drifting to double the expected bill unnoticed,
 * not to replace the bill.
 *
 * Verified against twilio.com/en-us/voice/pricing/us, September 2026.
 */
export const RATES = {
  /** Outbound PSTN leg, US local. */
  outboundPerMin: 0.014,
  /** Inbound to a local US number. */
  inboundPerMin: 0.0085,
  /** The browser leg, either direction. */
  clientPerMin: 0.004,
  recordingPerMin: 0.0025,
  /** The number itself. */
  numberPerMonth: 1.15,
} as const

export interface MonthUsage {
  month_start: string
  calls: number
  inbound_calls: number
  billed_minutes: number
  talk_seconds: number
  recorded_minutes: number
  transcribed_calls: number
  transcription_usd: number
  documents_usd: number
}

export interface SpendEstimate {
  telephony: number
  recording: number
  ai: number
  fixed: number
  total: number
  /** Fraction of the budget used, or null when no budget is set. */
  usedFraction: number | null
  projectedTotal: number
}

/**
 * Projects month-end spend by straight-lining what has happened so far.
 *
 * Crude on purpose: a solo operator dials on weekdays, so any cleverer model
 * would need a working-days calendar to be less wrong, and being roughly right
 * early in the month is the entire point.
 */
export function estimateSpend(usage: MonthUsage | null | undefined, budgetMinutes: number | null): SpendEstimate {
  const u = usage
  const billed = Number(u?.billed_minutes ?? 0)
  const inbound = Number(u?.inbound_calls ?? 0)
  const calls = Number(u?.calls ?? 0)

  // Split billed minutes by direction proportionally; per-call minutes are not
  // stored by direction, and the two rates are close enough that the error is
  // smaller than the rounding Twilio already applies.
  const inboundShare = calls > 0 ? inbound / calls : 0
  const inboundMin = billed * inboundShare
  const outboundMin = billed - inboundMin

  const telephony =
    outboundMin * RATES.outboundPerMin +
    inboundMin * RATES.inboundPerMin +
    billed * RATES.clientPerMin

  const recording = Number(u?.recorded_minutes ?? 0) * RATES.recordingPerMin
  const ai = Number(u?.transcription_usd ?? 0) + Number(u?.documents_usd ?? 0)
  const fixed = RATES.numberPerMonth
  const total = telephony + recording + ai + fixed

  const now = new Date()
  const dayOfMonth = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const projectedTotal = dayOfMonth > 0 ? (total - fixed) * (daysInMonth / dayOfMonth) + fixed : total

  const talkMinutes = Number(u?.talk_seconds ?? 0) / 60

  return {
    telephony,
    recording,
    ai,
    fixed,
    total,
    usedFraction: budgetMinutes && budgetMinutes > 0 ? talkMinutes / budgetMinutes : null,
    projectedTotal,
  }
}
