/**
 * Speech-to-text behind one interface.
 *
 * Every AI feature calls this module; nothing imports a vendor SDK directly, so
 * re-shopping providers is an env var rather than a rewrite. That matters here
 * because the price spread is real but the quality tradeoff is subtle:
 *
 *   gemini    ~$0.0014/min  transcript + structured fields in ONE request,
 *                           but multi-channel audio is downmixed to mono so
 *                           speaker labels are inferred, not read off channels.
 *   deepgram  ~$0.0043/min  multichannel=true gives EXACT speaker separation
 *                           from the dual-channel recording. No guessing.
 *   groq      ~$0.0007/min  cheapest by far, but Whisper cannot label speakers
 *                           at all. Only sensible when who-said-what is moot.
 *
 * Default is gemini. If speaker attribution proves unreliable on real calls,
 * STT_PROVIDER=deepgram is the whole fix.
 */

declare const Deno: { env: { get(key: string): string | undefined } }

export type SttProvider = 'gemini' | 'deepgram' | 'groq'

export interface TranscriptTurn {
  speaker: 'agent' | 'lead' | 'unknown'
  text: string
  start_seconds?: number
}

export interface TranscribeResult {
  /** Speaker-labelled plain text, the canonical stored form. */
  transcript: string
  turns: TranscriptTurn[]
  /** How sure we are the speaker labels are right. */
  speakerConfidence: 'high' | 'low'
  engine: string
  provider: SttProvider
  costUsd: number | null
}

export class SttUnavailableError extends Error {}
export class SttError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SttError'
    this.status = status
  }
}

function env(key: string): string | undefined {
  const v = Deno.env.get(key)
  return v && v.trim() ? v.trim() : undefined
}

export function sttProvider(): SttProvider {
  const p = (env('STT_PROVIDER') ?? env('LLM_PROVIDER') ?? 'gemini').toLowerCase()
  return (['gemini', 'deepgram', 'groq'].includes(p) ? p : 'gemini') as SttProvider
}

function apiKey(): string | undefined {
  return env('STT_API_KEY') ?? env('LLM_API_KEY')
}

/**
 * The single degradation gate. Callers check this FIRST and return a 200 with
 * `{ available: false }` rather than an error — a non-2xx would surface to the
 * user as a toast, and "no API key configured" is not something to shout about.
 */
export function sttAvailable(): boolean {
  return Boolean(apiKey())
}

// Per-minute prices used only to record what a transcript cost. Rough by
// design: the point is a visible running total, not billing-grade accounting.
const RATE_PER_MIN: Record<SttProvider, number> = {
  gemini: 0.0014,
  deepgram: 0.0043,
  groq: 0.00067,
}

/*
 * "The rep speaks first" was false, and it was the premise the model reasoned
 * from. On an outbound call the BUSINESS answers the phone — "Hello, Maple
 * Hill Lodge" — and the rep replies. Telling the model the opposite invited exactly
 * the failure we got: labels that invert at the point the pitch begins.
 *
 * What is reliably true of an outbound call is stated instead, along with the
 * behavioural tells, which survive a roleplay or a warm transfer where turn
 * order does not.
 */
const SPEAKER_PROMPT =
  'This is a recording of an outbound cold call placed BY a sales rep TO a ' +
  'local business. There are exactly two speakers.\n' +
  'The rep placed the call: they introduce themselves and their reason for ' +
  'calling, ask the discovery questions, and pitch. Label them "agent".\n' +
  'The business answered the phone: they greet, describe how their own ' +
  'operation works, and respond. Label them "lead".\n' +
  'Note that the party who speaks FIRST is usually the business answering, ' +
  'not the rep — do not use turn order to decide.\n' +
  'Keep each speaker consistent for the whole call: if a voice is the rep in ' +
  'one turn it is the rep in every turn.\n' +
  'Transcribe verbatim — do not summarise, correct grammar, or omit filler.'

export async function transcribeAudio(opts: {
  bytes: Uint8Array
  mimeType: string
  durationSeconds?: number | null
  /** Bounds the request so a slow provider fails with a message rather than
   *  being killed by the platform's wall-clock limit mid-flight. */
  signal?: AbortSignal
}): Promise<TranscribeResult> {
  const key = apiKey()
  if (!key) throw new SttUnavailableError('No STT API key configured')

  const provider = sttProvider()
  const minutes = (opts.durationSeconds ?? 0) / 60
  const costUsd = minutes > 0 ? Number((minutes * RATE_PER_MIN[provider]).toFixed(6)) : null

  const result = provider === 'deepgram'
    ? await viaDeepgram(opts.bytes, opts.mimeType, key, opts.signal)
    : provider === 'groq'
    ? await viaGroq(opts.bytes, opts.mimeType, key, opts.signal)
    : await viaGemini(opts.bytes, opts.mimeType, key, opts.signal)

  /*
   * Confidence is a property of HOW the labels were derived, not of the
   * model's opinion of its own work. Gemini downmixes to mono and infers, and
   * it reported "high" on a call whose labels flipped halfway through — so a
   * consumer trusting that field read the whole conversation backwards.
   *
   * Deepgram reads one speaker per channel off a dual-channel recording, which
   * is the only path here that can honestly claim certainty.
   */
  const speakerConfidence = provider === 'deepgram' ? 'high' as const : 'low' as const

  return { ...result, speakerConfidence, provider, costUsd }
}

// ── Gemini ──────────────────────────────────────────────────────────────────
// Audio in, structured JSON out, one request. Tokenises audio at ~32 tokens/sec.
async function viaGemini(bytes: Uint8Array, mimeType: string, key: string, signal?: AbortSignal) {
  const model = env('STT_MODEL') ?? 'gemini-flash-lite-latest'

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: SPEAKER_PROMPT },
            { inline_data: { mime_type: mimeType, data: base64(bytes) } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            required: ['turns', 'speaker_confidence'],
            properties: {
              turns: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  required: ['speaker', 'text'],
                  properties: {
                    speaker: { type: 'STRING', enum: ['agent', 'lead'] },
                    text: { type: 'STRING' },
                    start_seconds: { type: 'NUMBER' },
                  },
                },
              },
              speaker_confidence: { type: 'STRING', enum: ['high', 'low'] },
            },
          },
        },
      }),
    },
  )

  if (!res.ok) throw new SttError(`Gemini: ${(await res.text()).slice(0, 300)}`, res.status)

  const body = await res.json()
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new SttError('Gemini returned no content', 502)

  const parsed = JSON.parse(text) as {
    turns: TranscriptTurn[]
    speaker_confidence: 'high' | 'low'
  }
  const turns = (parsed.turns ?? []).filter((t) => t.text?.trim())

  return {
    transcript: renderTranscript(turns),
    turns,
    speakerConfidence: parsed.speaker_confidence ?? 'low',
    engine: model,
  }
}

// ── Deepgram ────────────────────────────────────────────────────────────────
// multichannel=true, NOT diarize: the recording is already dual-channel
// (record-from-answer-dual), so each channel is one speaker. Exact, not inferred.
async function viaDeepgram(bytes: Uint8Array, mimeType: string, key: string, signal?: AbortSignal) {
  const params = new URLSearchParams({
    model: env('STT_MODEL') ?? 'nova-3',
    multichannel: 'true',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
    language: 'en',
  })

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Token ${key}`, 'Content-Type': mimeType },
    body: bytes as BodyInit,
  })

  if (!res.ok) throw new SttError(`Deepgram: ${(await res.text()).slice(0, 300)}`, res.status)

  const body = await res.json()
  const utterances = (body?.results?.utterances ?? []) as {
    channel: number; transcript: string; start: number
  }[]

  // Channel 0 is the parent (agent) leg, channel 1 the child (lead).
  const turns: TranscriptTurn[] = utterances
    .filter((u) => u.transcript?.trim())
    .sort((a, b) => a.start - b.start)
    .map((u) => ({
      speaker: u.channel === 0 ? 'agent' : 'lead',
      text: u.transcript.trim(),
      start_seconds: u.start,
    }))

  return {
    transcript: renderTranscript(turns),
    turns,
    // Channel-derived, so this is not a guess.
    speakerConfidence: 'high' as const,
    engine: env('STT_MODEL') ?? 'nova-3',
  }
}

// ── Groq (Whisper) ──────────────────────────────────────────────────────────
// Cheapest, but Whisper has no speaker separation — everything comes back as
// one undifferentiated block.
async function viaGroq(bytes: Uint8Array, mimeType: string, key: string, signal?: AbortSignal) {
  const model = env('STT_MODEL') ?? 'whisper-large-v3-turbo'
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart], { type: mimeType }), 'call.mp3')
  form.append('model', model)
  form.append('response_format', 'json')

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })

  if (!res.ok) throw new SttError(`Groq: ${(await res.text()).slice(0, 300)}`, res.status)

  const body = await res.json()
  const text = String(body?.text ?? '').trim()
  const turns: TranscriptTurn[] = text ? [{ speaker: 'unknown', text }] : []

  return {
    transcript: text,
    turns,
    speakerConfidence: 'low' as const,
    engine: model,
  }
}

// ── Shared ──────────────────────────────────────────────────────────────────

/** The stored form: one labelled line per turn, stable across providers. */
function renderTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => `${t.speaker === 'agent' ? 'Agent' : t.speaker === 'lead' ? 'Lead' : 'Speaker'}: ${t.text}`)
    .join('\n')
}

function base64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on a
  // multi-megabyte recording.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// ── Text completion ────────────────────────────────────────────────────────
//
// Deliberately parallel to the speech surface above, and sharing none of its
// code: cost is per-token here rather than per-audio-minute, and conflating the
// two is how you end up with a per-brief figure that is wrong by three orders
// of magnitude.

export type TextProvider = 'gemini' | 'anthropic'

export class TextUnavailableError extends Error {}

export interface CompletionResult<T> {
  value: T
  model: string
  provider: TextProvider
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
}

export function textProvider(): TextProvider {
  const p = (env('TEXT_PROVIDER') ?? env('LLM_PROVIDER') ?? 'gemini').toLowerCase()
  return p === 'anthropic' ? 'anthropic' : 'gemini'
}

/**
 * The single degradation gate for text features.
 *
 * Key precedence mirrors the speech side: an operator who set one LLM_API_KEY
 * gets both features without discovering a second variable.
 */
export function textAvailable(): boolean {
  return Boolean(env('TEXT_API_KEY') ?? env('LLM_API_KEY'))
}

/** Published per-million-token prices. Rough on purpose — this is for a UI line, not billing. */
const TEXT_RATE: Record<TextProvider, { inPer1M: number; outPer1M: number }> = {
  gemini: { inPer1M: 0.25, outPer1M: 1.50 },
  anthropic: { inPer1M: 1.00, outPer1M: 5.00 },
}

/**
 * One structured completion. `schema` is a Gemini responseSchema; passing one
 * makes the model return JSON matching it rather than prose we then have to
 * parse, which is what keeps a thin brief looking thin instead of being padded
 * into confident-sounding filler.
 */
export async function completeText<T>(opts: {
  system?: string
  prompt: string
  schema: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}): Promise<CompletionResult<T>> {
  const key = env('TEXT_API_KEY') ?? env('LLM_API_KEY')
  if (!key) throw new TextUnavailableError('No TEXT_API_KEY or LLM_API_KEY is set')

  const provider = textProvider()
  if (provider !== 'gemini') {
    // Only the Gemini path is implemented; the type and the env var exist so
    // adding another is a new function here and no change anywhere else.
    throw new SttError(`TEXT_PROVIDER=${provider} is not implemented yet`, 501)
  }

  const model = env('TEXT_MODEL') ?? 'gemini-flash-lite-latest'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
        contents: [{ parts: [{ text: opts.prompt }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: opts.maxTokens ?? 900,
          responseMimeType: 'application/json',
          responseSchema: opts.schema,
        },
      }),
    },
  )

  if (!res.ok) {
    throw new SttError(`Gemini text request failed (${res.status}): ${await res.text()}`, res.status)
  }

  const body = await res.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }

  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text
  if (!raw) throw new SttError('Gemini returned no content', 502)

  let value: T
  try {
    value = JSON.parse(raw) as T
  } catch {
    throw new SttError('Gemini returned malformed JSON despite a response schema', 502)
  }

  const inputTokens = body.usageMetadata?.promptTokenCount ?? null
  const outputTokens = body.usageMetadata?.candidatesTokenCount ?? null
  const rate = TEXT_RATE[provider]

  return {
    value,
    model,
    provider,
    inputTokens,
    outputTokens,
    costUsd: inputTokens !== null && outputTokens !== null
      ? Number(((inputTokens / 1e6) * rate.inPer1M + (outputTokens / 1e6) * rate.outPer1M).toFixed(6))
      : null,
  }
}
