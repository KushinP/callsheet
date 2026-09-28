/**
 * Where a call actually went, against the script it was supposed to follow.
 *
 * `advance_on` and `trigger` have sat inert since scripts were built — phrase
 * lists nothing consumed. Matching them against the transcript after the call
 * turns "which script connected" into "where calls fall off the script", which
 * is the question worth asking of an opener.
 *
 * Two things make this harder than a substring search.
 *
 * First, advance_on phrases are deliberately tiny — "okay", "sure", "yeah" —
 * because that is genuinely what a prospect says to move things along. The rep
 * says them just as often. Matching across every turn would race the pointer to
 * the end of the script on the rep's own filler.
 *
 * Second, speaker labels are unreliable (see llm.ts): with Gemini they are
 * inferred from mono audio and can invert mid-call. So we cannot simply trust
 * "Lead" to mean the prospect.
 *
 * The way out is that the REP reads the script aloud. Whichever speaker's turns
 * look most like the script's own text is the rep — that is a measurement, not
 * a guess — and the other one is the prospect. Matching then runs only against
 * the prospect, and the script repairs the labels rather than depending on them.
 */

export interface ScriptBlock {
  id: string
  text?: string
  advance_on?: string[]
  branches?: { trigger: string[]; goto: string }[] | null
  next?: string | null
}

export interface ScriptStep {
  block_id: string
  /** How the call left this block: forward, down a branch, or not at all. */
  via: 'advance_on' | 'branch' | 'end'
  /** The phrase that matched, so a human can check the inference. */
  phrase?: string
  goto?: string | null
  /** Index of the transcript turn that moved it, for ordering. */
  turn?: number
}

export interface ScriptPathResult {
  steps: ScriptStep[]
  /** Where the call stopped following the script. */
  ended_at: string | null
  /** Which speaker label the script says is the rep, whatever it was called. */
  rep_label: string | null
  /** Turns attributed to the prospect that matched nothing. */
  unmatched_turns: number
  /** How the responder was identified, so a reader knows how much to trust it. */
  attribution: 'speaker_channels' | 'content'
}

interface Turn {
  speaker: string
  text: string
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

/** Word-boundary containment, so "yes" does not match "yesterday". */
function says(haystack: string, phrase: string): boolean {
  const p = norm(phrase)
  if (!p) return false
  return new RegExp(`(^|\\s)${p.replace(/\s+/g, '\\s+')}(\\s|$)`).test(haystack)
}

export function parseTurns(transcript: string): Turn[] {
  const turns: Turn[] = []
  for (const line of transcript.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = /^([A-Za-z][A-Za-z0-9 _-]{0,24}):\s*(.*)$/.exec(t)
    if (m) turns.push({ speaker: m[1].trim().toLowerCase(), text: m[2].trim() })
    else if (turns.length) turns[turns.length - 1].text += ` ${t}`
  }
  return turns
}

/**
 * Which speaker label the script says is the rep.
 *
 * Reported, not relied on. It is genuinely useful — it tells a reader which way
 * round a mislabelled transcript is — but it cannot drive the matching, because
 * the labels are not merely swapped: they are unstable WITHIN a speaker, so
 * filtering on them drops real answers. "we'll just let it ring to voicemail"
 * came back tagged as the rep on the one real call there is.
 *
 * Scored on distinctive words only — anything under five characters is filler
 * both sides use, and counting it would just measure who talked more.
 */
function findRep(turns: Turn[], blocks: ScriptBlock[]): string | null {
  const scriptWords = new Set(
    norm(blocks.map((b) => b.text ?? '').join(' '))
      .split(' ')
      .filter((w) => w.length >= 5),
  )
  if (scriptWords.size === 0) return null

  const scores = new Map<string, number>()
  for (const turn of turns) {
    const hits = norm(turn.text).split(' ').filter((w) => scriptWords.has(w)).length
    scores.set(turn.speaker, (scores.get(turn.speaker) ?? 0) + hits)
  }

  let best: string | null = null
  let bestScore = 0
  for (const [speaker, score] of scores) {
    if (score > bestScore) { best = speaker; bestScore = score }
  }
  // A tie, or nobody reading the script, means we cannot tell — and guessing
  // would silently attribute the rep's filler to the prospect.
  return bestScore > 0 ? best : null
}

export function traceScriptPath(
  transcript: string,
  blocks: ScriptBlock[],
  entryBlockId: string,
  /**
   * 'high' only when the labels were read off separate channels rather than
   * inferred. Then, and only then, is it safe to match a prospect's answers by
   * speaker — which is strictly better than guessing from content, and removes
   * the one class of error this has: matching the rep's own words back at the
   * script. On the sample call "most of them just go to voicemail" was the rep
   * recapping, and it counted as the prospect answering.
   */
  speakerConfidence: 'high' | 'low' = 'low',
): ScriptPathResult {
  const turns = parseTurns(transcript)
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const repLabel = findRep(turns, blocks)

  /*
   * A turn is the rep DELIVERING the script when it echoes the block's own
   * distinctive words. Classifying turns by content rather than by speaker
   * label is what makes this survive a transcript whose labels are wrong —
   * and the rep reading "who picks up when you're not at the desk" must not be
   * mistaken for the prospect answering it.
   */
  const blockWords = new Map<string, Set<string>>()
  for (const b of blocks) {
    blockWords.set(
      b.id,
      new Set(norm(b.text ?? '').split(' ').filter((w) => w.length >= 5)),
    )
  }

  const trustLabels = speakerConfidence === 'high' && repLabel !== null

  const isDelivery = (turnText: string, blockId: string): boolean => {
    const words = blockWords.get(blockId)
    if (!words || words.size === 0) return false
    const spoken = norm(turnText).split(' ').filter((w) => w.length >= 5)
    if (spoken.length === 0) return false
    const hits = spoken.filter((w) => words.has(w)).length
    // A third of the long words in common is a paraphrase of the block, not an
    // answer to it. Reps do not read scripts verbatim, so this cannot be exact.
    return hits >= 2 && hits / spoken.length >= 0.25
  }

  const steps: ScriptStep[] = []
  const seen = new Set<string>()
  let current: string | null = entryBlockId
  let cursor = 0
  let unmatched = 0

  while (current && byId.has(current)) {
    // A script can legitimately route back; visiting the same block twice in one
    // trace means the phrases are ambiguous, not that the call looped.
    if (seen.has(current)) break
    seen.add(current)

    const block: ScriptBlock = byId.get(current)!
    let moved: ScriptStep | null = null

    for (let i = cursor; i < turns.length && !moved; i++) {
      // With exact labels, anything the rep said is skipped outright. With
      // inferred ones, fall back to asking whether the turn reads as the rep
      // delivering this block.
      if (trustLabels && turns[i].speaker === repLabel) continue
      if (!trustLabels && isDelivery(turns[i].text, block.id)) continue
      const text = norm(turns[i].text)

      // Branches before advance_on: a specific objection in the same breath as
      // "okay" is the more informative of the two, and the one the rep acted on.
      for (const branch of block.branches ?? []) {
        const hit = branch.trigger.find((p) => says(text, p))
        if (hit) {
          moved = { block_id: block.id, via: 'branch', phrase: hit, goto: branch.goto, turn: i }
          break
        }
      }
      if (moved) { cursor = i + 1; break }

      const advance = (block.advance_on ?? []).find((p) => says(text, p))
      if (advance) {
        moved = {
          block_id: block.id, via: 'advance_on', phrase: advance,
          goto: block.next ?? null, turn: i,
        }
        cursor = i + 1
        break
      }
      unmatched++
    }

    if (!moved) {
      steps.push({ block_id: block.id, via: 'end' })
      return {
        steps,
        ended_at: block.id,
        rep_label: repLabel,
        unmatched_turns: unmatched,
        attribution: trustLabels ? 'speaker_channels' : 'content',
      }
    }

    steps.push(moved)
    current = moved.goto ?? null
  }

  return {
    steps,
    // Running off the end of the script is reaching a close, not falling off it.
    ended_at: steps.length ? (steps[steps.length - 1].goto ?? null) : null,
    rep_label: repLabel,
    unmatched_turns: unmatched,
    attribution: trustLabels ? 'speaker_channels' : 'content',
  }
}
