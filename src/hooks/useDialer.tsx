import { Call, Device } from '@twilio/voice-sdk'
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { RingbackTone, playDtmfFeedback } from '@/lib/ringback'
import { QUALITY_WARNINGS, cleanDeviceLabel, isBluetoothLabel, preferBuiltIn } from '@/lib/callQuality'
import { callFunction, supabase } from '@/lib/supabase'
import type { CallOutcome, CallQuality } from '@/lib/types'
import { errorMessage, toE164, formatPhone } from '@/lib/utils'
import { toast } from 'sonner'
import { BookingSheet } from '@/components/calls/BookingSheet'
import { IncomingCallBanner } from '@/components/dialer/IncomingCallBanner'
import { useLead } from './useLeads'
import { useAuth } from './useAuth'
import { useWorkspace } from './useWorkspace'

/**
 * Twilio's SDK errors, said in words a person dialling a phone would use.
 *
 * 31005 is the one that matters: it is what the SDK reports when the far end's
 * carrier hangs up, which for a cold-calling list is a busy signal or a
 * rejected call several times a day. Passed through raw it reads
 * "ConnectionError (31005): Error sent from gateway in HANGUP", which sounds
 * like the app is broken — and the row it just wrote already said "busy".
 */
const CALL_ERRORS: Record<number, string> = {
  31005: 'The call did not connect — the line was busy, or they rejected it.',
  31003: 'Could not reach Twilio — check your connection and try again.',
  31009: 'The call dropped on the way out. Try again.',
  31201: 'No microphone. Plug one in, or pick a different input below.',
  31208: 'Microphone blocked. Allow it in your browser settings to place calls.',
  31401: 'Your browser would not hand over the microphone.',
  31402: 'No microphone found.',
  20101: 'Your calling session expired. Reload the page.',
  20104: 'Your calling session expired. Reload the page.',
  53000: 'The audio connection failed. Usually a network problem.',
  53405: 'No audio path could be opened — often a VPN or firewall.',
}

function callErrorMessage(error: { message?: string; code?: number }): string {
  if (error?.code && CALL_ERRORS[error.code]) return CALL_ERRORS[error.code]
  return error?.message ?? 'The call failed for an unknown reason.'
}

/*
 * No line clears in 83 seconds. One inn was dialled four times in that long,
 * all busy — which burns an impression on a small-town innkeeper and tells you
 * nothing the first attempt did not.
 */
const REDIAL_COOLDOWN_MS = 5 * 60 * 1000
const COOLDOWN_STATUSES = new Set(['busy', 'no_answer'])

function sinceLabel(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`
}

export type CallState =
  | 'idle'
  | 'connecting'
  | 'ringing'
  | 'live'
  | 'conferencing'
  | 'ending'

/** States in which a call exists and the keypad must stay on screen. */
export const ACTIVE_STATES: CallState[] = ['connecting', 'ringing', 'live', 'conferencing']

export interface ActiveCall {
  logId: string
  phone: string
  businessName: string | null
  leadId: string | null
  sessionId: string | null
  mode: 'direct' | 'conference'
  conferenceName: string | null
  startedAt: number
  /** Set once the far end actually answers; duration counts from here. */
  answeredAt: number | null
  /** Who called whom. Every surface labelled calls "Outbound" before inbound
   *  ones could be answered here, which stopped being true. */
  direction: 'outbound' | 'inbound'
}

/**
 * Someone ringing us, before it is answered or refused.
 *
 * Deliberately not a CallState. An unanswered inbound call is not "a call in
 * progress" — the rep may be mid-call, mid-sentence, or about to decline it —
 * and folding it into that enum would put the keypad, the hang-up button and
 * the disposition bar on screen for a call that does not exist yet.
 */
export interface IncomingCall {
  /** The row twilio-voice already logged, handed over as a <Parameter>. */
  logId: string
  from: string
  businessName: string | null
  leadId: string | null
}

/** One leg of a live conference, as Twilio currently sees it. */
export interface Participant {
  callSid: string
  role: 'you' | 'lead' | 'added'
  label: string
  number: string | null
  muted: boolean
  onHold: boolean
}

export interface StartCallOptions {
  phone: string
  businessName?: string | null
  leadId?: string | null
  sessionId?: string | null
  /** The script being read on this call, so its performance is measurable later. */
  scriptId?: string | null
  mode?: 'direct' | 'conference'
  /** Dial even though this number was busy or unanswered a moment ago. */
  force?: boolean
}

export interface AudioInput {
  deviceId: string
  label: string
}

interface DialerContextValue {
  state: CallState
  isBusy: boolean
  deviceReady: boolean
  deviceError: string | null
  activeCall: ActiveCall | null
  /** Ringing, unanswered. Null unless someone is calling in right now. */
  incomingCall: IncomingCall | null
  /** The just-ended call, held so the disposition bar has something to act on. */
  pendingDisposition: ActiveCall | null
  duration: number
  muted: boolean
  digits: string
  inputDevices: AudioInput[]
  selectedInput: string | null
  /** Speakers and headsets the call can play through. */
  outputDevices: AudioInput[]
  selectedOutput: string | null
  /** Chrome and Edge can route call audio to a chosen device; Safari cannot. */
  outputSelectionSupported: boolean
  widgetOpen: boolean
  widgetDraft: string

  startCall: (options: StartCallOptions) => Promise<string | null>
  /** Picks up the call that is ringing. */
  answerCall: () => void
  /** Refuses it here. Any parallel forward number keeps ringing. */
  declineCall: () => void
  hangUp: () => void
  toggleMute: () => void
  sendDigit: (digit: string) => void
  addToConference: (phone: string) => Promise<void>
  /** Escalates a live call into a conference and dials someone in. */
  addAgent: (phone?: string) => Promise<void>
  /** Open the booking sheet deliberately, rather than only on a disposition. */
  openBooking: (lead: { id?: string | null; businessName?: string | null }) => void
  participants: Participant[]
  dropParticipant: (callSid: string) => Promise<void>
  setInputDevice: (deviceId: string) => Promise<void>
  setOutputDevice: (deviceId: string) => Promise<void>
  refreshInputDevices: () => Promise<void>
  disposition: (outcome: CallOutcome, notes?: string, callbackAt?: string | null) => Promise<void>
  dismissDisposition: () => void
  openWidget: (prefill?: string) => void
  closeWidget: () => void
  setWidgetDraft: (value: string) => void
}

const DialerContext = createContext<DialerContextValue | null>(null)

export function DialerProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { workspaceId, twilioReady, workspace } = useWorkspace()
  const queryClient = useQueryClient()

  const [state, setState] = useState<CallState>('idle')
  const [deviceReady, setDeviceReady] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [pendingDisposition, setPendingDisposition] = useState<ActiveCall | null>(null)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [digits, setDigits] = useState('')
  const [inputDevices, setInputDevices] = useState<AudioInput[]>([])
  const [outputDevices, setOutputDevices] = useState<AudioInput[]>([])
  const [selectedOutput, setSelectedOutput] = useState<string | null>(
    () => localStorage.getItem('cs.output_device'),
  )
  const [outputSelectionSupported, setOutputSelectionSupported] = useState(false)
  const [selectedInput, setSelectedInput] = useState<string | null>(
    () => localStorage.getItem('cs.input_device'),
  )
  const [participants, setParticipants] = useState<Participant[]>([])
  /*
   * The lead an appointment was just set for.
   *
   * Owned here rather than by whichever surface happened to take the
   * disposition. Three of them hand-wired "on appointment_set, open Calendly"
   * separately, and the newest — the lead panel, which is where calls are
   * actually placed from — simply never got the wiring. A booking prompt whose
   * whole purpose is to stop you forgetting cannot itself depend on remembering
   * to add it to a fourth place.
   */
  const [bookingLeadId, setBookingLeadId] = useState<string | null>(null)
  const [bookingName, setBookingName] = useState<string | null>(null)
  const bookingLead = useLead(bookingLeadId)
  const [widgetOpen, setWidgetOpen] = useState(false)
  const [widgetDraft, setWidgetDraft] = useState('')

  const deviceRef = useRef<Device | null>(null)
  const callRef = useRef<Call | null>(null)
  const incomingRef = useRef<Call | null>(null)
  // The redial prompt's "Dial anyway" runs after the render that raised it, so
  // it reads the current startCall rather than the one it closed over.
  const startCallRef = useRef<((options: StartCallOptions) => Promise<string | null>) | null>(null)
  const ringbackRef = useRef<RingbackTone>(new RingbackTone())
  const activeCallRef = useRef<ActiveCall | null>(null)
  const tokenExpiryRef = useRef<number>(0)

  // Effects read the live call without re-subscribing every render.
  useEffect(() => {
    activeCallRef.current = activeCall
  }, [activeCall])

  // -------------------------------------------------------------------------
  // Audio input devices
  // -------------------------------------------------------------------------
  const readInputDevices = useCallback(() => {
    const device = deviceRef.current
    if (!device) return

    const available: AudioInput[] = []
    device.audio?.availableInputDevices?.forEach((info, id) => {
      available.push({ deviceId: id, label: info.label || 'Default microphone' })
    })
    setInputDevices(available)

    const outputs: AudioInput[] = []
    device.audio?.availableOutputDevices?.forEach((info, id) => {
      outputs.push({ deviceId: id, label: info.label || 'Default speaker' })
    })
    setOutputDevices(outputs)
    setOutputSelectionSupported(Boolean(device.audio?.isOutputSelectionSupported))
  }, [])

  const refreshInputDevices = useCallback(async () => {
    try {
      // Labels stay blank until the page holds a mic permission, so ask for
      // one first. A Bluetooth headset paired after page load only shows up
      // after this re-enumeration.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
    } catch {
      setDeviceError('Microphone access is blocked. Allow it in your browser settings to place calls.')
    }
    readInputDevices()
  }, [readInputDevices])

  const setInputDevice = useCallback(async (deviceId: string) => {
    const device = deviceRef.current
    if (!device?.audio) return

    try {
      await device.audio.setInputDevice(deviceId)
      setSelectedInput(deviceId)
      localStorage.setItem('cs.input_device', deviceId)
    } catch (error) {
      toast.error(`Could not switch microphone: ${errorMessage(error)}`)
    }
  }, [])

  const setOutputDevice = useCallback(async (deviceId: string) => {
    const device = deviceRef.current
    if (!device?.audio?.isOutputSelectionSupported) return

    try {
      // The ringtone follows the call audio: an incoming call ringing in the
      // laptop speakers while you wear a headset is a call you do not hear.
      await device.audio.speakerDevices.set(deviceId)
      await device.audio.ringtoneDevices.set(deviceId)
      setSelectedOutput(deviceId)
      localStorage.setItem('cs.output_device', deviceId)
    } catch (error) {
      toast.error(`Could not switch speaker: ${errorMessage(error)}`)
    }
  }, [])

  // -------------------------------------------------------------------------
  // Call audio quality
  // -------------------------------------------------------------------------
  /*
   * "Calls are muffled and hard to hear" arrived with nothing behind it but a
   * transcript in which the other end said "you also sound very buzzy and
   * muffled". The browser knew which mic was open, which codec carried the
   * call and whether packets were being lost, and kept none of it.
   *
   * So a call is watched from the moment it connects. It speaks up while the
   * call is still happening, when something can still be done, and hands what
   * it saw to the log when the call ends.
   */
  const qualityRef = useRef<{
    quality: CallQuality
    mosSum: number
    mosCount: number
    warned: Set<string>
  } | null>(null)

  const watchQuality = useCallback((call: Call) => {
    const audio = deviceRef.current?.audio
    const input = audio?.inputDevice?.label
      || audio?.availableInputDevices.get('default')?.label
      || null
    const output = [...(audio?.speakerDevices.get() ?? [])][0]?.label
      || audio?.availableOutputDevices.get('default')?.label
      || null
    const bluetooth = isBluetoothLabel(input)

    qualityRef.current = {
      quality: {
        input, output, bluetooth_input: bluetooth, codec: call.codec || null,
        warnings: [], mos_avg: null, mos_min: null, jitter_max: null, packet_loss_max: null,
      },
      mosSum: 0,
      mosCount: 0,
      warned: new Set(),
    }

    // The likeliest cause of muffled audio, caught while it is costing the
    // conversation — and fixable mid-call, because the SDK swaps the input on
    // a live call without dropping it.
    if (bluetooth && audio) {
      const alternative = [...audio.availableInputDevices.values()]
        .filter((info) => info.deviceId !== 'default' && info.deviceId !== 'communications')
        .filter((info) => !isBluetoothLabel(info.label))
        .sort(preferBuiltIn)[0]
      toast.warning(
        `Your mic is ${cleanDeviceLabel(input)}. A Bluetooth headset drops into call mode ` +
          'when its mic is open, so you will both sound muffled.',
        {
          duration: 15000,
          ...(alternative
            ? {
                action: {
                  label: `Use ${cleanDeviceLabel(alternative.label)}`,
                  onClick: () => void setInputDevice(alternative.deviceId),
                },
              }
            : {}),
        },
      )
    }

    call.on('sample', (sample: {
      mos: number | null
      jitter: number
      packetsLost: number
      packetsReceived: number
      codecName?: string
    }) => {
      const tracker = qualityRef.current
      if (!tracker) return
      const q = tracker.quality
      if (!q.codec && sample.codecName) q.codec = sample.codecName
      if (typeof sample.mos === 'number' && sample.mos > 0) {
        tracker.mosSum += sample.mos
        tracker.mosCount += 1
        q.mos_avg = Math.round((tracker.mosSum / tracker.mosCount) * 100) / 100
        q.mos_min = q.mos_min === null ? sample.mos : Math.min(q.mos_min, sample.mos)
      }
      q.jitter_max = Math.max(q.jitter_max ?? 0, sample.jitter ?? 0)
      // From the counts, not packetsLostFraction: the SDK's typings call that
      // a ratio while its own warning thresholds treat it as a percentage.
      const seen = (sample.packetsReceived ?? 0) + (sample.packetsLost ?? 0)
      const lossPct = seen > 0 ? ((sample.packetsLost ?? 0) / seen) * 100 : 0
      q.packet_loss_max = Math.round(Math.max(q.packet_loss_max ?? 0, lossPct) * 10) / 10
    })

    call.on('warning', (name: string) => {
      const tracker = qualityRef.current
      if (!tracker) return
      if (!tracker.quality.warnings.includes(name)) tracker.quality.warnings.push(name)
      // A silent mic while deliberately muted is the mute working.
      if (name === 'constant-audio-input-level' && call.isMuted()) return
      if (tracker.warned.has(name)) return
      tracker.warned.add(name)
      toast.warning(QUALITY_WARNINGS[name]?.live ?? `Call quality warning: ${name}`)
    })
  }, [setInputDevice])

  // -------------------------------------------------------------------------
  // Ending a call
  // -------------------------------------------------------------------------
  const finalizeCall = useCallback(
    async (call: ActiveCall, twilioDuration: number, quality?: CallQuality | null) => {
      // The webhook is the source of truth for duration, but it can lag or be
      // blocked; writing what the browser saw means the log is never empty.
      await supabase
        .from('dial_call_logs')
        .update({
          call_status: 'completed',
          ended_at: new Date().toISOString(),
          ...(twilioDuration > 0 ? { duration_seconds: twilioDuration } : {}),
        })
        .eq('id', call.logId)
        .is('ended_at', null)

      // Its own write, not folded into the one above. That one only lands while
      // ended_at is still empty, and the status webhook usually gets there
      // first — so quality written with it would be silently dropped on most
      // calls.
      if (quality) {
        await supabase.from('dial_call_logs').update({ quality }).eq('id', call.logId)
      }

      void queryClient.invalidateQueries({ queryKey: ['call-log'] })
      void queryClient.invalidateQueries({ queryKey: ['call-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['daily-calls'] })
      // ['leads'] does NOT prefix-match ['lead', id]: react-query compares the
      // first element for equality, not as a string prefix. Without these two
      // the lead sheet you just called from keeps showing the previous
      // outcome and a call history missing the call you are looking at.
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-calls'] })
      // An answered callback stops being a missed one.
      void queryClient.invalidateQueries({ queryKey: ['missed-calls'] })
    },
    [queryClient],
  )

  /**
   * Every way a call can stop, in one place.
   *
   * Answered or not, dialled or received: the widget returns to idle and the
   * call is handed to the disposition bar. That last part is not tidiness — a
   * call left un-dispositioned keeps its session queue entry at 'queued', which
   * is what made the auto-dialer redial a number that could never connect.
   */
  const endActiveCall = useCallback(() => {
    ringbackRef.current.stop()
    const finished = activeCallRef.current
    const quality = qualityRef.current?.quality ?? null
    qualityRef.current = null
    callRef.current = null
    setState('idle')
    setActiveCall(null)
    activeCallRef.current = null

    if (finished) {
      setPendingDisposition(finished)
      const elapsed = finished.answeredAt
        ? Math.floor((Date.now() - finished.answeredAt) / 1000)
        : 0
      void finalizeCall(finished, elapsed, quality)
    }
  }, [finalizeCall])

  // -------------------------------------------------------------------------
  // Device lifecycle
  // -------------------------------------------------------------------------
  const fetchToken = useCallback(async (): Promise<string> => {
    if (!workspaceId) throw new Error('No active workspace')
    const result = await callFunction<{ token: string; expiresAt: number }>(
      'twilio-token',
      { workspaceId },
    )
    tokenExpiryRef.current = result.expiresAt
    return result.token
  }, [workspaceId])

  const teardownDevice = useCallback(() => {
    callRef.current?.disconnect()
    callRef.current = null
    incomingRef.current?.reject()
    incomingRef.current = null
    setIncomingCall(null)
    deviceRef.current?.destroy()
    deviceRef.current = null
    setDeviceReady(false)
    setInputDevices([])
    setOutputDevices([])
  }, [])

  /** Created on demand, so a rep who never dials never gets a mic prompt. */
  const ensureDevice = useCallback(async (): Promise<Device> => {
    if (deviceRef.current && deviceReady) return deviceRef.current

    const token = await fetchToken()
    const device = new Device(token, {
      codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      logLevel: 'error',
    })

    device.on('error', (error: { message?: string; code?: number }) => {
      console.error('Twilio device error:', error)
      setDeviceError(error?.message ?? 'Twilio device error')
    })

    device.on('tokenWillExpire', () => {
      fetchToken()
        .then((next) => device.updateToken(next))
        .catch((error) => console.error('Token refresh failed:', error))
    })

    device.audio?.on('deviceChange', readInputDevices)

    /*
     * Someone calling the number back.
     *
     * The SDK has always played its incoming ringtone the moment this arrives,
     * which is why the app appeared to ring — but with no listener there was
     * nothing to accept it with, and the only way to take a callback was the
     * forwarded mobile.
     */
    device.on('incoming', (call: Call) => {
      const param = (name: string) => call.customParameters.get(name) || null
      const from = call.parameters.From ?? ''
      const businessName = param('businessName')
      const leadId = param('leadId')
      const logId = param('logId') ?? ''

      incomingRef.current = call
      setIncomingCall({ logId, from, businessName, leadId })

      let accepted = false
      const dismiss = () => {
        if (incomingRef.current === call) incomingRef.current = null
        setIncomingCall(null)
      }

      call.on('accept', () => {
        accepted = true
        dismiss()
        watchQuality(call)
        const record: ActiveCall = {
          logId,
          phone: from,
          businessName,
          leadId,
          sessionId: null,
          mode: 'direct',
          conferenceName: null,
          startedAt: Date.now(),
          // Answered is the same instant as started for a call we picked up,
          // so the timer counts talk time rather than including the ring.
          answeredAt: Date.now(),
          direction: 'inbound',
        }
        callRef.current = call
        setActiveCall(record)
        activeCallRef.current = record
        setPendingDisposition(null)
        setMuted(false)
        setDigits('')
        setState('live')
      })

      // 'cancel' is both "they gave up" and "it was answered on the forwarded
      // number" — Twilio ends the losing leg of a parallel dial the same way.
      call.on('cancel', () => { dismiss(); if (accepted) endActiveCall() })
      call.on('reject', dismiss)
      call.on('disconnect', () => { dismiss(); if (accepted) endActiveCall() })
      call.on('error', (error: { message?: string; code?: number }) => {
        dismiss()
        if (accepted) {
          toast.error(callErrorMessage(error))
          endActiveCall()
        }
      })
    })

    await device.register()
    deviceRef.current = device
    setDeviceReady(true)
    setDeviceError(null)

    readInputDevices()

    // Reapply the rep's saved microphone choice across page loads.
    const saved = localStorage.getItem('cs.input_device')
    if (saved && device.audio) {
      await device.audio.setInputDevice(saved).catch(() => undefined)
    }
    const savedOutput = localStorage.getItem('cs.output_device')
    if (savedOutput && device.audio?.isOutputSelectionSupported) {
      await device.audio.speakerDevices.set(savedOutput).catch(() => undefined)
      await device.audio.ringtoneDevices.set(savedOutput).catch(() => undefined)
    }

    return device
  }, [deviceReady, fetchToken, readInputDevices, endActiveCall, watchQuality])

  /*
   * Register up front when the workspace answers its own number.
   *
   * The device used to be built on demand inside startCall, so the browser was
   * only reachable in a tab that had already dialled out. Every callback into a
   * freshly loaded app therefore rang nothing but the forwarded number — the
   * <Client> leg had no client to reach. Registering costs a websocket and no
   * microphone prompt; the mic is only claimed when a call is actually
   * answered, which is why this stays behind the opt-in rather than running
   * for everyone.
   */
  useEffect(() => {
    if (!workspaceId || !twilioReady || !workspace?.answer_inbound) return
    if (deviceRef.current) return
    void ensureDevice().catch((error) => {
      // No toast: this runs on page load, and a workspace that cannot register
      // should not greet every navigation with the same red banner. The dialer
      // renders deviceError where it is relevant.
      console.error('Could not register for incoming calls:', error)
    })
  }, [workspaceId, twilioReady, workspace?.answer_inbound, ensureDevice])

  // Switching workspace or signing out must not leave a live device behind.
  useEffect(() => {
    return () => teardownDevice()
  }, [workspaceId, user?.id, teardownDevice])

  // -------------------------------------------------------------------------
  // Duration ticker
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!ACTIVE_STATES.includes(state)) {
      setDuration(0)
      return
    }

    const tick = () => {
      const call = activeCallRef.current
      if (!call) return
      const from = call.answeredAt ?? call.startedAt
      setDuration(Math.max(0, Math.floor((Date.now() - from) / 1000)))
    }

    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [state, activeCall?.answeredAt])

  // -------------------------------------------------------------------------
  // Placing a call
  // -------------------------------------------------------------------------
  const startCall = useCallback(
    async (options: StartCallOptions): Promise<string | null> => {
      if (!workspaceId) {
        toast.error('No active workspace')
        return null
      }
      if (!twilioReady) {
        toast.error('Add your Twilio credentials in Settings before placing a call.')
        return null
      }
      if (ACTIVE_STATES.includes(state)) {
        toast.error('There is already a call in progress.')
        return null
      }

      const e164 = toE164(options.phone)
      if (!e164) {
        toast.error(`"${options.phone}" is not a valid phone number.`)
        return null
      }

      const normalized = e164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')

      // Refuse a redial into a line that was just busy or rang out, and say
      // when it is worth trying again. Overridable, because a rep who knows
      // they misdialled should not be argued with.
      if (!options.force) {
        const { data: last } = await supabase
          .from('dial_call_logs')
          .select('call_status, called_at')
          .eq('workspace_id', workspaceId)
          .eq('phone_normalized', normalized)
          .eq('direction', 'outbound')
          .order('called_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (last && COOLDOWN_STATUSES.has(last.call_status)) {
          const ago = Date.now() - new Date(last.called_at).getTime()
          if (ago < REDIAL_COOLDOWN_MS) {
            const wait = Math.max(1, Math.ceil((REDIAL_COOLDOWN_MS - ago) / 60000))
            toast(
              `${last.call_status === 'busy' ? 'Busy' : 'No answer'} ${sinceLabel(ago)} — ` +
                `worth another try in about ${wait} min.`,
              {
                duration: 8000,
                action: {
                  label: 'Dial anyway',
                  onClick: () => void startCallRef.current?.({ ...options, force: true }),
                },
              },
            )
            return null
          }
        }
      }

      const mode = options.mode ?? 'direct'
      setPendingDisposition(null)
      setDigits('')
      setMuted(false)
      setState('connecting')

      let logId: string | null = null

      try {
        // 1. Log first. The DNC trigger rejects flagged leads here, before a
        //    single Twilio request goes out.
        const { data: log, error: logError } = await supabase
          .from('dial_call_logs')
          .insert({
            workspace_id: workspaceId,
            lead_id: options.leadId ?? null,
            session_id: options.sessionId ?? null,
            user_id: user?.id ?? null,
            business_name: options.businessName ?? null,
            phone: options.phone,
            phone_normalized: normalized,
            script_id: options.scriptId ?? null,
            mode,
            call_status: 'initiated',
            conference_name: mode === 'conference' ? `cs-${crypto.randomUUID().slice(0, 12)}` : null,
          })
          .select('id, conference_name')
          .single()

        if (logError) throw logError
        logId = log.id

        const record: ActiveCall = {
          logId: log.id,
          phone: options.phone,
          businessName: options.businessName ?? null,
          leadId: options.leadId ?? null,
          sessionId: options.sessionId ?? null,
          mode,
          conferenceName: log.conference_name,
          startedAt: Date.now(),
          answeredAt: null,
          direction: 'outbound',
        }

        setActiveCall(record)
        activeCallRef.current = record

        // 2. Ringback starts immediately — the rep should never wonder whether
        //    the click registered.
        ringbackRef.current.start()

        const device = await ensureDevice()

        const call = await device.connect({
          params: {
            To: e164,
            logId: log.id,
            mode,
            ...(record.conferenceName ? { conferenceName: record.conferenceName } : {}),
          },
        })

        callRef.current = call

        call.on('ringing', () => setState('ringing'))

        call.on('accept', () => {
          ringbackRef.current.stop()
          watchQuality(call)
          const answered = { ...record, answeredAt: Date.now() }
          setActiveCall(answered)
          activeCallRef.current = answered
          setState(mode === 'conference' ? 'conferencing' : 'live')
        })

        call.on('disconnect', endActiveCall)

        // A call that rang out or failed still happened, and still needs an
        // outcome — which is also what stops the auto-dialer redialling it.
        call.on('cancel', endActiveCall)

        call.on('error', (error: { message?: string; code?: number }) => {
          /*
           * Not toast.error for a busy line. The call reaching a busy signal is
           * a normal result of dialling strangers, not a fault, and a red
           * banner for it trains you to ignore the red banners that matter.
           * The outcome is already on the row and the disposition bar is about
           * to ask about it.
           */
          const message = callErrorMessage(error)
          if (error?.code === 31005) toast(message)
          else toast.error(message)
          endActiveCall()
        })

        // 3. In conference mode the agent lands in an empty room; this brings
        //    the lead in.
        if (mode === 'conference' && record.conferenceName) {
          await callFunction('twilio-conference', {
            workspaceId,
            logId: log.id,
            to: e164,
            conferenceName: record.conferenceName,
          })
        }

        return log.id
      } catch (error) {
        ringbackRef.current.stop()
        setState('idle')
        setActiveCall(null)
        activeCallRef.current = null

        const message = errorMessage(error)
        toast.error(
          message.includes('do_not_call')
            ? 'This number is flagged Do Not Call and cannot be dialed.'
            : message,
        )

        if (logId) {
          await supabase
            .from('dial_call_logs')
            .update({ call_status: 'failed', ended_at: new Date().toISOString() })
            .eq('id', logId)
        }

        return null
      }
    },
    [workspaceId, twilioReady, state, user?.id, ensureDevice, endActiveCall, watchQuality],
  )

  useEffect(() => {
    startCallRef.current = startCall
  }, [startCall])

  const answerCall = useCallback(() => {
    const call = incomingRef.current
    if (!call) return
    // 'live' before Twilio confirms: the ring stops the instant the button is
    // pressed, and the accept handler above corrects the record either way.
    setState('connecting')
    call.accept()
  }, [])

  const declineCall = useCallback(() => {
    const call = incomingRef.current
    incomingRef.current = null
    setIncomingCall(null)
    // Only this leg. A forward number dialled in parallel keeps ringing, and
    // the caller still reaches voicemail — declining here is not hanging up on
    // them.
    call?.reject()
  }, [])

  const hangUp = useCallback(() => {
    // callRef is only set after device.connect() resolves. Hanging up while
    // still connecting therefore has nothing to disconnect, and no 'disconnect'
    // event will ever arrive to move us off 'ending' — the widget stays stuck
    // in call mode until a reload.
    if (!callRef.current) {
      ringbackRef.current.stop()
      setState('idle')
      setActiveCall(null)
      activeCallRef.current = null
      return
    }
    setState('ending')
    callRef.current.disconnect()
    ringbackRef.current.stop()
  }, [])

  const toggleMute = useCallback(() => {
    const call = callRef.current
    if (!call) return
    const next = !call.isMuted()
    call.mute(next)
    setMuted(next)
  }, [])

  const sendDigit = useCallback((digit: string) => {
    playDtmfFeedback(digit)
    setDigits((prev) => (prev + digit).slice(-24))
    callRef.current?.sendDigits(digit)
  }, [])

  const addToConference = useCallback(
    async (phone: string) => {
      const call = activeCallRef.current
      if (!workspaceId || !call?.conferenceName) {
        toast.error('Start a conference call before adding a participant.')
        return
      }

      const e164 = toE164(phone)
      if (!e164) {
        toast.error(`"${phone}" is not a valid phone number.`)
        return
      }

      await callFunction('twilio-conference', {
        workspaceId,
        logId: call.logId,
        to: e164,
        conferenceName: call.conferenceName,
      })
      toast.success(`Dialing ${phone} into the conference`)
    },
    [workspaceId],
  )

  /**
   * Pulls a third party onto the call that is already up.
   *
   * A plain <Dial> cannot gain a participant, so the server moves both existing
   * legs into a conference and dials the addition into the same room. Unlike
   * addToConference this works on ANY live call — the old flow required having
   * chosen conference mode before dialling, which is not a decision anyone can
   * make before they know how the call is going.
   */
  const addAgent = useCallback(
    async (phone?: string) => {
      const call = activeCallRef.current
      if (!workspaceId || !call) {
        toast.error('Start a call first.')
        return
      }

      const result = await callFunction<{ added: string; conferenceName: string }>(
        'twilio-conference',
        {
          action: 'escalate',
          workspaceId,
          logId: call.logId,
          ...(phone ? { to: phone } : {}),
        },
      )

      setState('conferencing')
      setActiveCall((prev) =>
        prev ? { ...prev, mode: 'conference', conferenceName: result.conferenceName } : prev,
      )
      toast.success(`Bringing ${formatPhone(result.added)} onto the call`)
    },
    [workspaceId],
  )

  /*
   * Twilio is the only thing that knows who is actually in the room, so ask it
   * rather than tracking joins and leaves ourselves. Polling is the honest
   * shape here: a participant can leave without the browser being told —
   * a prospect hanging up is exactly that — and a roster that only updates
   * when WE do something would keep showing someone who has already gone.
   */
  const refreshParticipants = useCallback(async () => {
    const call = activeCallRef.current
    if (!workspaceId || !call || call.mode !== 'conference') {
      setParticipants([])
      return
    }
    try {
      const result = await callFunction<{ participants: Participant[] }>(
        'twilio-conference',
        { action: 'participants', workspaceId, logId: call.logId },
      )
      setParticipants(result.participants ?? [])
    } catch {
      // A failed poll is not worth a toast every three seconds; the roster
      // simply holds its last known state.
    }
  }, [workspaceId])

  useEffect(() => {
    if (state !== 'conferencing') {
      setParticipants([])
      return
    }
    void refreshParticipants()
    const timer = setInterval(() => void refreshParticipants(), 3000)
    return () => clearInterval(timer)
  }, [state, refreshParticipants])

  const dropParticipant = useCallback(
    async (callSid: string) => {
      const call = activeCallRef.current
      if (!workspaceId || !call) return

      await callFunction('twilio-conference', {
        action: 'remove', workspaceId, logId: call.logId, callSid,
      })
      // Reflect it immediately rather than waiting up to three seconds for the
      // next poll to agree with what the rep just did.
      setParticipants((prev) => prev.filter((p) => p.callSid !== callSid))
      void refreshParticipants()
    },
    [workspaceId, refreshParticipants],
  )

  // -------------------------------------------------------------------------
  // Disposition
  // -------------------------------------------------------------------------
  const disposition = useCallback(
    async (outcome: CallOutcome, notes?: string, callbackAt?: string | null) => {
      const target = pendingDisposition ?? activeCallRef.current
      if (!target) return

      /*
       * The callback time first, because the playbook trigger fires on the
       * lead's outcome and reads callback_at in the same breath. Written after,
       * the task would be created at the fallback hour and then moved by the
       * re-anchor trigger — which lands in the right place but through two
       * writes and a moment of showing the wrong time.
       */
      if (target.leadId && callbackAt !== undefined) {
        await supabase
          .from('leads')
          .update({ callback_at: callbackAt })
          .eq('id', target.leadId)
      }

      const { error } = await supabase
        .from('dial_call_logs')
        .update({ outcome, ...(notes ? { notes } : {}) })
        .eq('id', target.logId)

      // Throw rather than toast-and-return. Callers advance a queue and fire a
      // success toast on a normal resolve, so swallowing the failure here put a
      // green "Logged" toast beside the red error and marked the lead done as
      // though the outcome had saved.
      if (error) throw new Error(`Could not save outcome: ${error.message}`)

      /*
       * The lead's outcome is NOT written here. It means "how the last call
       * went", and a client that stamps it with whichever call it happens to be
       * editing gets that wrong the moment you re-disposition an older one. A
       * trigger on dial_call_logs derives it from the newest call instead.
       */

      if (outcome === 'appointment_set') {
        setBookingLeadId(target.leadId)
        setBookingName(target.businessName)
      }

      setPendingDisposition(null)
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
      void queryClient.invalidateQueries({ queryKey: ['lead'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-calls'] })
      void queryClient.invalidateQueries({ queryKey: ['call-log'] })
      void queryClient.invalidateQueries({ queryKey: ['call-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['daily-calls'] })
      // An outcome is exactly what un-misses an inbound call.
      void queryClient.invalidateQueries({ queryKey: ['missed-calls'] })
    },
    [pendingDisposition, queryClient],
  )

  const value = useMemo<DialerContextValue>(
    () => ({
      state,
      isBusy: ACTIVE_STATES.includes(state) || state === 'ending',
      deviceReady,
      deviceError,
      activeCall,
      incomingCall,
      pendingDisposition,
      duration,
      muted,
      digits,
      inputDevices,
      selectedInput,
      outputDevices,
      selectedOutput,
      outputSelectionSupported,
      widgetOpen,
      widgetDraft,
      startCall,
      answerCall,
      declineCall,
      hangUp,
      toggleMute,
      sendDigit,
      addToConference,
      addAgent,
      setInputDevice,
      setOutputDevice,
      refreshInputDevices,
      disposition,
      participants,
      dropParticipant,
      openBooking: ({ id, businessName }) => {
        setBookingLeadId(id ?? null)
        setBookingName(businessName ?? null)
      },
      dismissDisposition: () => setPendingDisposition(null),
      openWidget: (prefill?: string) => {
        if (prefill !== undefined) setWidgetDraft(prefill)
        setWidgetOpen(true)
      },
      closeWidget: () => setWidgetOpen(false),
      setWidgetDraft,
    }),
    // addAgent was already missing here, which is a stale-closure waiting to
    // happen; participants is worse, because a roster that never re-publishes
    // shows a prospect still on the call after they have hung up.
    [
      state, deviceReady, deviceError, activeCall, incomingCall, pendingDisposition,
      duration, muted, digits, inputDevices, selectedInput, outputDevices, selectedOutput,
      outputSelectionSupported, widgetOpen, widgetDraft,
      startCall, answerCall, declineCall, hangUp, toggleMute, sendDigit,
      addToConference, addAgent,
      setInputDevice, setOutputDevice, refreshInputDevices, disposition,
      participants, dropParticipant,
    ],
  )

  return (
    <DialerContext.Provider value={value}>
      {children}
      {/* Above every page and independent of the widget, which is collapsed
          most of the time. A ringing phone cannot be behind a click. */}
      <IncomingCallBanner />
      {/* One instance for the whole app, so it opens no matter which surface
          took the disposition — widget, session dialer or lead panel. */}
      <BookingSheet
        lead={bookingLead.data ?? (bookingName ? { business_name: bookingName } : null)}
        calendlyUrl={workspace?.calendly_url}
        open={Boolean(bookingLeadId || bookingName)}
        onScheduled={(startsAt) => {
          /*
           * Booking and remembering the date were two separate acts, and the
           * second one kept not happening: both demos sat on demo_booked with
           * scheduled_at null and half a playbook silently not running. When
           * Calendly tells us the time, the T-1 reminder now schedules itself.
           */
          if (!bookingLeadId) {
            toast.success('Booked. Set the date on the lead so its reminders fire.')
            return
          }
          if (!startsAt) {
            toast.success('Booked. Add the date to the lead so its reminders fire.')
            return
          }
          void supabase
            .from('leads')
            .update({ scheduled_at: new Date(startsAt).toISOString() })
            .eq('id', bookingLeadId)
            .then(() => {
              void queryClient.invalidateQueries({ queryKey: ['lead'] })
              void queryClient.invalidateQueries({ queryKey: ['leads'] })
              void queryClient.invalidateQueries({ queryKey: ['tasks'] })
              toast.success('Booked — the appointment and its reminders are set.')
            })
        }}
        onClose={() => {
          setBookingLeadId(null)
          setBookingName(null)
        }}
      />
    </DialerContext.Provider>
  )
}

export function useDialer(): DialerContextValue {
  const ctx = useContext(DialerContext)
  if (!ctx) throw new Error('useDialer must be used inside <DialerProvider>')
  return ctx
}
