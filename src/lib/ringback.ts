/**
 * Locally generated US ringback tone: 440 Hz + 480 Hz, two seconds on, four
 * seconds off.
 *
 * The agent's leg stays unanswered until the lead picks up (answerOnBridge),
 * so without this the rep hears dead silence while the call connects and has
 * no idea whether anything is happening.
 */
export class RingbackTone {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private oscillators: OscillatorNode[] = []
  private cycle: ReturnType<typeof setInterval> | null = null

  private static readonly ON_SECONDS = 2
  private static readonly OFF_SECONDS = 4
  private static readonly LEVEL = 0.09

  get isPlaying(): boolean {
    return this.cycle !== null
  }

  start(): void {
    if (this.cycle) return

    try {
      const Ctor = window.AudioContext ?? (window as unknown as {
        webkitAudioContext?: typeof AudioContext
      }).webkitAudioContext

      if (!Ctor) return

      const ctx = new Ctor()
      // Autoplay policy: the click that started the call unlocks this.
      void ctx.resume()

      const gain = ctx.createGain()
      gain.gain.value = 0
      gain.connect(ctx.destination)

      this.oscillators = [440, 480].map((freq) => {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq
        osc.connect(gain)
        osc.start()
        return osc
      })

      this.ctx = ctx
      this.gain = gain

      this.pulse()
      this.cycle = setInterval(
        () => this.pulse(),
        (RingbackTone.ON_SECONDS + RingbackTone.OFF_SECONDS) * 1000,
      )
    } catch (error) {
      console.warn('Could not start ringback tone:', error)
      this.stop()
    }
  }

  /** One on/off burst, ramped at both ends so it does not click. */
  private pulse(): void {
    if (!this.ctx || !this.gain) return

    const now = this.ctx.currentTime
    const g = this.gain.gain

    g.cancelScheduledValues(now)
    g.setValueAtTime(0, now)
    g.linearRampToValueAtTime(RingbackTone.LEVEL, now + 0.04)
    g.setValueAtTime(RingbackTone.LEVEL, now + RingbackTone.ON_SECONDS - 0.04)
    g.linearRampToValueAtTime(0, now + RingbackTone.ON_SECONDS)
  }

  stop(): void {
    if (this.cycle) {
      clearInterval(this.cycle)
      this.cycle = null
    }

    if (this.gain && this.ctx) {
      const now = this.ctx.currentTime
      this.gain.gain.cancelScheduledValues(now)
      this.gain.gain.linearRampToValueAtTime(0, now + 0.03)
    }

    const oscillators = this.oscillators
    const ctx = this.ctx
    this.oscillators = []
    this.ctx = null
    this.gain = null

    // Let the fade-out finish before tearing the graph down.
    setTimeout(() => {
      for (const osc of oscillators) {
        try {
          osc.stop()
          osc.disconnect()
        } catch { /* already stopped */ }
      }
      void ctx?.close().catch(() => undefined)
    }, 60)
  }
}

/** Short confirmation blip for DTMF key presses. */
export function playDtmfFeedback(digit: string): void {
  const DTMF: Record<string, [number, number]> = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
  }

  const pair = DTMF[digit]
  if (!pair) return

  try {
    const Ctor = window.AudioContext ?? (window as unknown as {
      webkitAudioContext?: typeof AudioContext
    }).webkitAudioContext
    if (!Ctor) return

    const ctx = new Ctor()
    const gain = ctx.createGain()
    gain.gain.value = 0.06
    gain.connect(ctx.destination)

    for (const freq of pair) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start()
      osc.stop(ctx.currentTime + 0.12)
    }

    gain.gain.setValueAtTime(0.06, ctx.currentTime + 0.09)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12)
    setTimeout(() => void ctx.close().catch(() => undefined), 250)
  } catch { /* audio is a nicety here, never fatal */ }
}
