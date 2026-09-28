import type { CallQuality } from './types'

/**
 * Whether an audio device is a Bluetooth headset, going by its label.
 *
 * Browsers expose no transport field, so the label is all there is — and on a
 * Mac, Chrome helpfully appends "(Bluetooth)". It matters because a Bluetooth
 * headset whose microphone is open drops into its call profile: narrowband in
 * both directions. That is exactly "muffled, and they can't hear me either",
 * and the 7 Sep test call said as much — "you also sound very buzzy and
 * muffled".
 *
 * Deliberately narrow. "Headset" alone would also match good wired ones.
 */
export function isBluetoothLabel(label: string | null | undefined): boolean {
  return Boolean(
    label && /airpods|bluetooth|beats|\bbuds\b|hands-?free|\bbose\b|sony w[hf]-/i.test(label),
  )
}

/** "Default - AirPods Pro (Bluetooth)" → "AirPods Pro". */
export function cleanDeviceLabel(label: string | null | undefined): string {
  if (!label) return 'Unknown device'
  const cleaned = label
    .replace(/^(default|communications)\s*-\s*/i, '')
    .replace(/\s*\((bluetooth|built-in|[0-9a-f]{4}:[0-9a-f]{4})\)\s*$/i, '')
    .trim()
  return cleaned || label
}

/** A built-in mic sorts first when offering an alternative to a Bluetooth one. */
export function preferBuiltIn(a: { label: string }, b: { label: string }): number {
  const builtIn = (label: string) => Number(/macbook|built-?in/i.test(label))
  return builtIn(b.label) - builtIn(a.label)
}

/**
 * The SDK's quality warnings, in words.
 *
 * `live` is said while the call is still happening, when something can still be
 * done about it; `short` is what the call log shows afterwards.
 */
export const QUALITY_WARNINGS: Record<string, { live: string; short: string }> = {
  'high-packet-loss': {
    live: 'Your connection is dropping audio — they may hear you break up.',
    short: 'packet loss',
  },
  'high-jitter': {
    live: 'Your connection is unsteady — they may hear you break up.',
    short: 'jitter',
  },
  'low-mos': {
    live: 'Call quality has dropped — they may be struggling to hear you.',
    short: 'low quality score',
  },
  'high-rtt': {
    live: 'Your connection has a long delay — expect to talk over each other.',
    short: 'delay',
  },
  'constant-audio-input-level': {
    live: 'Your microphone is not picking anything up — check it is not muted.',
    short: 'mic silent',
  },
  'constant-audio-output-level': {
    live: 'No audio is coming through from their side.',
    short: 'no incoming audio',
  },
  'low-bytes-received': {
    live: 'Audio from their side has stalled.',
    short: 'incoming audio stalled',
  },
  'low-bytes-sent': {
    live: 'Your audio is not reaching them.',
    short: 'outgoing audio stalled',
  },
  'ice-connectivity-lost': {
    live: 'The connection dropped — trying to reconnect.',
    short: 'connection lost',
  },
}

/** One line for the call log: which mic, which codec, how it held up. */
export function describeQuality(quality: CallQuality | null | undefined): string {
  if (!quality) return '—'

  const parts: string[] = []
  if (quality.input) {
    parts.push(
      `${cleanDeviceLabel(quality.input)} mic${quality.bluetooth_input ? ' (Bluetooth)' : ''}`,
    )
  }
  if (quality.codec) {
    const codec = quality.codec.toLowerCase()
    parts.push(codec === 'opus' ? 'Opus' : codec === 'pcmu' ? 'G.711' : quality.codec)
  }
  if (quality.mos_avg !== null) parts.push(`MOS ${quality.mos_avg.toFixed(1)}`)
  if ((quality.packet_loss_max ?? 0) >= 1) {
    parts.push(`up to ${Math.round(quality.packet_loss_max ?? 0)}% loss`)
  }
  const warnings = quality.warnings.map((name) => QUALITY_WARNINGS[name]?.short ?? name)
  if (warnings.length) parts.push(warnings.join(', '))

  return parts.join(' · ') || '—'
}
