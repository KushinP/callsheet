# Cost model — recording and transcription

Verified prices, US, September 2026. Sources at the bottom.

Baseline for every figure below: **50 connected calls/day × 22 days = 1,100
connected calls/month**, 3 minutes average, a 30% connect rate (so ~3,667 dials,
of which ~2,567 are voicemail or no answer). That works out to **~4,378 recorded
minutes a month.**

---

## The finding that matters most

Everyone optimises the transcription model. That is the wrong thing to optimise.

| | Month 1 | Month 6 | Month 12 | Month 24 |
| --- | --- | --- | --- | --- |
| Recordings kept on Twilio | $0.00 | $8.13 | **$21.27** | **$47.54** |
| Same library on Cloudflare R2 | $0.00 | $0.03 | $0.21 | $0.57 |

Twilio bills recording storage **per minute, per month, for the entire retained
library** — $0.0005/min/mo after a 10,000-minute free allowance. It is not a
one-off. Every month you keep dialling, the bill for last month's recordings is
charged again on top of this month's.

By month 12 that is **~100× more than the same audio on R2**, and the gap keeps
widening. Meanwhile the difference between the cheapest and most expensive
*sensible* transcription provider is about $12/month, flat.

**Download each recording and delete it from Twilio.** Twilio's own docs
recommend exactly this: the recording status callback fires when the file is
ready, and that is the moment to fetch the bytes and issue a delete.

Twilio also supports pushing recordings straight to an **AWS S3 bucket**, which
removes their storage charge entirely and skips the download step. Worth using
if you are on AWS; note the docs specify S3 rather than S3-compatible, so
whether Cloudflare R2 works as a target needs testing before relying on it.

---

## Costs that are fixed, and costs that are choices

### Fixed — the price of making calls at all

| Item | Rate | Monthly |
| --- | --- | --- |
| Outbound PSTN | $0.0140/min | $46.20 |
| Twilio Client (browser leg) | $0.0040/min | $13.20 |
| Recording (one-off, per recorded minute) | $0.0025/min | $10.95 |

**~$70/month** and there is no lever on it short of calling less. Unanswered
dials are free — `record-from-answer-dual` starts recording only once someone
picks up, so the ~2,567 no-answers cost nothing to record.

### The expensive choice: real-time transcription

| Approach | Rate | Monthly (3,300 connected min) |
| --- | --- | --- |
| Twilio managed `<Transcription>` | $0.0270/min | **$89.10** |
| Media Streams + Deepgram streaming | $0.0092/min | $30.36 |
| Post-call only | — | see below |

Real-time is the single largest avoidable cost in the system — **more than the
phone calls themselves**. It is only needed to drive the live prompter, which is
why the prompter is opt-in per session rather than always on.

The DIY relay (Twilio Media Streams at $0.0044 + Deepgram streaming at $0.0048)
is a third of the managed price, but it puts our WebSocket in the live audio
path where a crash degrades or drops a call. Not worth building until sustained
prompter use passes roughly 2,800 min/month — below that, the ~$0.018/min saving
does not cover an always-on host plus the added failure surface.

### The cheap choice: post-call transcription

Monthly figures are for **1,600 talk-minutes** — the volume this install
actually runs at.

| Provider | Rate | Monthly | Diarisation | Notes |
| --- | --- | --- | --- | --- |
| Groq Whisper V3 Turbo | $0.00067/min | **$1.07** | none | Fastest and cheapest, but Whisper does not label speakers |
| **Gemini Flash-Lite (audio in)** | ~$0.0013/min | **$2.02** | model-inferred | Transcript and speaker labels in one request; structured JSON out |
| Deepgram Nova-3 batch | $0.0043/min | $6.88 | exact, via `multichannel=true` | True channel separation, no guessing |
| Twilio real-time | $0.027/min | $43.20 | by track | Only if you need it live |

The spread between the top three is **under $6/month**. Not worth contorting the
architecture over — pick on quality and simplicity, not price. Which is why
`STT_PROVIDER` is an env var: all three are implemented, and switching costs one
redeploy and no code.

**Gemini Flash-Lite is the default**, because it returns a speaker-labelled
transcript as structured JSON in a single request — no separate diarisation
step, no second model to parse the output. Its weakness is exactly that
diarisation: it downmixes multi-channel audio to mono, so speaker attribution is
inferred rather than read off the channels. On a two-party sales call with clean
turn-taking that is usually fine, and the prompt carries a strong prior (the
agent speaks first and asks the questions). Every transcript is stored with a
`speaker_confidence` of `high` or `low`, so a bad one is flagged rather than
silently wrong.

If speaker labels turn out unreliable, **Deepgram with `multichannel=true`** is
the escape hatch: it transcribes each channel of the dual-channel recording
independently, so agent and lead are separated exactly rather than guessed. It
costs 3× more — still under $7/month.

Groq is tempting on price but transcript-only and speaker-blind. Splitting the
stereo file and transcribing each channel separately would give perfect
separation, but doubles the billed audio and needs timestamp interleaving —
landing at about Gemini's price with more moving parts.

---

## Three rules worth enforcing in code

**1. Never keep recordings on Twilio.** Download on the recording callback,
store in R2, delete from Twilio. This is the only decision here that compounds.

**2. Transcribe connected calls; skip the rest.** Voicemail greetings are ~25
seconds of a recorded message. Transcribing all ~2,567 of them adds ~1,078
minutes — a 33% increase in transcription volume for material nobody will read.
Gate on `is_connected_outcome(outcome) OR duration_seconds >= 20`.

**3. Put a ceiling on a single transcription.** A Supabase edge function gets
150 seconds of wall clock on the free plan, and one invocation has to download
the audio, push it to R2, *and* transcribe it. `process-recording` aborts the
transcription at 100s and refuses outright above 45 minutes of audio, so a
freak call fails with a readable `transcription_error` instead of being killed
mid-write and left in a state that is neither done nor failed. The recording is
still stored and still playable — only the transcript is skipped.

Size is not the constraint people expect it to be: Gemini accepts inline audio
up to 100 MB, and base64-encoding a 30-minute call takes ~200 ms, well inside
the 2-second CPU budget. Time and memory run out first.

---

## Turn on Gemini billing, and not for the reason you'd think

The free tier is generous enough that it's tempting to leave billing off. Don't
— and the argument is about data, not quota.

Google's [API terms](https://ai.google.dev/gemini-api/terms) draw a hard line
between the two tiers. On the **unpaid** tier, "Google uses the content you
submit to the Services and any generated responses to provide, improve, and
develop Google products and services," and "human reviewers may read, annotate,
and process your API input and output." On the **paid** tier, "Google doesn't
use your prompts ... or responses to improve our products."

What gets submitted here is the recorded audio of real phone calls with named
people at named businesses — the people on the other end consented (at most) to
being recorded by *you*, not to a third party's reviewers reading it. That
asymmetry is the whole argument.

Enabling billing does not change the price of anything below. At 1,600
talk-minutes it moves roughly **$2.70/month** of transcription from free to
paid, which buys a materially different data position for about the cost of a
coffee per quarter.

The secondary reason is quota. Free-tier requests-per-day caps have been cut
repeatedly and are not published in a stable place — check your own limits in
AI Studio. A day of heavy dialling that silently stops producing transcripts
because a daily cap was hit is worse than a $3 bill.

---

## Where the money actually goes

Twilio bills answered minutes, so the honest unit is a talk-minute. Both legs of
a browser call bill: $0.014/min outbound PSTN plus $0.004/min for the WebRTC
client leg.

| Per talk-minute | |
| --- | --- |
| PSTN + client leg | $0.0180 |
| Recording | $0.0025 |
| Transcription (Gemini Flash-Lite, in + out) | $0.0013 |
| Storage (R2) | ~$0.00003 |
| **Total** | **~$0.022** |

At **1,600 talk-minutes a month** — 160 connected calls if they average ten
minutes — that is **about $35/month**, or **$0.22 per connected call**. Dial
attempts that ring out cost nothing; ones that hit voicemail bill for the few
seconds they last, which rounds to a rounding error next to ten-minute
conversations.

**The transcription layer is about 6% of the bill.** Recording and transcribing
every call costs less than the last forty minutes of talking. Two decisions
already made are worth more than any provider choice:

- **No real-time transcription.** Streaming every call would add ~$0.027/min —
  more than doubling the bill — for auto-advancing a script the agent can
  advance with the space bar.
- **No recordings left on Twilio.** Twilio storage bills per-minute *per month*,
  forever. Offloading to R2 is worth ~$13/month by month twelve and keeps
  growing; the R2 line above stays flat.

---

## Sources

- [Twilio Voice pricing](https://www.twilio.com/en-us/voice/pricing/us) — call, recording, storage, Media Streams, real-time transcription rates
- [How Much Does It Cost to Record a Call?](https://support.twilio.com/hc/en-us/articles/223132527-How-Much-Does-It-Cost-to-Record-a-Call) — 10,000 free storage minutes, per-minute-per-month billing
- [Downloading and Deleting Twilio Call Recordings](https://help.twilio.com/articles/360002588893-Downloading-and-Deleting-Twilio-Call-Recordings) — the callback-triggered download-and-delete pattern
- [External Call Recording Storage in AWS S3](https://www.twilio.com/en-us/changelog/external-storage-for-call-recording-is-now-available) — removes Twilio storage charges
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) — $0.015/GB-month, free egress, 10 GB free
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) — Flash-Lite $0.50/1M audio input, $1.50/1M output
- [Gemini audio docs](https://ai.google.dev/gemini-api/docs/audio) — 32 tokens/sec, mp3 supported, structured output alongside transcription
- [Deepgram pricing](https://deepgram.com/pricing) — Nova-3 $0.0043/min batch, $0.0048/min streaming
- [Groq models](https://console.groq.com/docs/models) — Whisper V3 Turbo $0.04/hour
