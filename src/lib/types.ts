// ---------------------------------------------------------------------------
// Database enums and their human labels.
//
// Everything stored is snake_case; every label shown to a rep lives here so the
// two never drift apart.
// ---------------------------------------------------------------------------


export type CallOutcome =
  | 'connected_dm'
  | 'connected_gk'
  | 'connected_other'
  | 'voicemail'
  | 'phone_tree'
  | 'ai_competitor'
  | 'busy'
  | 'no_answer'
  | 'bad_number'
  | 'not_interested'
  | 'do_not_call'
  | 'callback_requested'
  | 'appointment_set'
  | 'dialed'

export type SessionStatus = 'pending' | 'active' | 'paused' | 'completed'
export type SessionLeadStatus = 'queued' | 'dialing' | 'done' | 'skipped'
export type WorkspaceRole = 'owner' | 'admin' | 'agent'

export type CallStatus =
  | 'initiated' | 'ringing' | 'in_progress' | 'completed'
  | 'busy' | 'failed' | 'no_answer' | 'canceled'

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info'

export const OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected_dm: 'Connected – DM',
  connected_gk: 'Connected – Gatekeeper',
  connected_other: 'Connected – Other',
  voicemail: 'Voicemail',
  phone_tree: 'Phone Tree',
  ai_competitor: 'AI Competitor',
  busy: 'Busy',
  no_answer: 'No Answer',
  bad_number: 'Bad Number',
  not_interested: 'Not Interested',
  do_not_call: 'Do Not Call',
  callback_requested: 'Callback Requested',
  appointment_set: 'Appointment Set',
  dialed: 'Dialed',
}

export const OUTCOME_TONES: Record<CallOutcome, Tone> = {
  connected_dm: 'good',
  connected_gk: 'info',
  connected_other: 'info',
  voicemail: 'neutral',
  // Neutral, like voicemail: a machine answered. Nothing was learned and
  // nothing was lost, and it must never read as a conversation.
  phone_tree: 'neutral',
  // Not neutral, though: a machine answered AND somebody else already sold
  // them. That is the one machine-answered call worth looking at twice.
  ai_competitor: 'warn',
  busy: 'warn',
  no_answer: 'neutral',
  bad_number: 'bad',
  not_interested: 'warn',
  do_not_call: 'bad',
  callback_requested: 'info',
  appointment_set: 'good',
  dialed: 'neutral',
}

/**
 * The one-tap disposition bar, in the order a rep reaches for them. The first
 * six cover the overwhelming majority of calls; the rest live behind "More".
 */
export const QUICK_DISPOSITIONS: CallOutcome[] = [
  'connected_dm',
  'connected_gk',
  'voicemail',
  'no_answer',
  'not_interested',
  'appointment_set',
]

/**
 * Outcomes a playbook may fire on.
 *
 * Not every outcome: do_not_call and bad_number are barred in SQL because a
 * closed lead does not need work scheduling, and the rest are left out here
 * because a playbook for "Dialed" is a playbook for nothing. These are the ones
 * where hanging up leaves you owing somebody something.
 */
export const PLAYBOOK_OUTCOMES: CallOutcome[] = [
  'callback_requested',
  'connected_dm',
  'connected_gk',
  'voicemail',
  'phone_tree',
  'ai_competitor',
  'not_interested',
]

export const SECONDARY_DISPOSITIONS: CallOutcome[] = [
  'connected_other',
  'phone_tree',
  'ai_competitor',
  'busy',
  'bad_number',
  'callback_requested',
  'do_not_call',
]

export const ALL_OUTCOMES = Object.keys(OUTCOME_LABELS) as CallOutcome[]

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface Profile {
  id: string
  email: string | null
  full_name: string | null
}

export interface Workspace {
  id: string
  name: string
  created_by: string | null
  created_at: string
  /** Default for new calls; a session may override it. */
  recording_enabled: boolean
  /** Scheduling link opened when a call is dispositioned as an appointment. */
  calendly_url: string | null
  /** Connected talk-minutes to budget for in a month; null = no ceiling. */
  monthly_minute_budget: number | null
  /** Rung in parallel with the browser on an inbound call. */
  forward_to_number: string | null
  /** Separate from recording_enabled: an inbound caller was told nothing. */
  record_inbound: boolean
  /** Opt-in: whether Callsheet takes over the number's incoming calls. */
  answer_inbound: boolean
  /** Pulled onto a live call by the "Add agent" button. */
  voice_agent_number: string | null
  /** Drives playbook due dates: "+3d at 09:00" has to mean 9am where the rep is. */
  timezone: string
  /** Smallest property worth calling. Null means no floor. */
  min_rooms: number | null
}

export interface Lead {
  id: string
  workspace_id: string
  business_name: string
  /** The human you ask for. Free text — a first name is usually all anyone has. */
  contact_name: string | null
  /**
   * How many rooms. Null means unknown — a property that cannot be reduced to
   * one number keeps its nuance in metadata_json instead.
   */
  room_count: number | null
  phone: string
  phone_normalized: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  website: string | null
  email: string | null
  notes: string | null
  outcome: CallOutcome | null
  do_not_call: boolean
  last_called_at: string | null
  call_count: number
  metadata_json: Record<string, unknown>
  /** Where the deal is — the only field you manage. */
  pipeline_stage: PipelineStage
  stage_changed_at: string
  /**
   * The next appointment — the demo, usually. Playbook steps anchored to
   * "scheduled" count from this, so moving it moves their reminders.
   */
  scheduled_at: string | null
  /** When they asked to be rung back. Separate from scheduled_at, which is the demo. */
  callback_at: string | null
  /** Claude's proposal, with the reason it gave. */
  tier_suggested: LeadTier | null
  tier_suggested_reason: string | null
  /** A known room count under the workspace's size floor. Caps `tier` at c; tier_suggested is kept. */
  below_size_floor: boolean
  /** A human's decision. Wins, always. */
  tier_override: LeadTier | null
  /** Generated by the database as coalesce(override, suggested) — never written. */
  tier: LeadTier | null
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CallingSession {
  id: string
  workspace_id: string
  name: string
  status: SessionStatus
  filters_json: LeadFilters
  total_leads: number
  completed_leads: number
  created_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  script_id: string | null
  /** null = inherit the workspace default; true/false = an explicit choice. */
  record_calls: boolean | null
}

export interface SessionLead {
  id: string
  session_id: string
  lead_id: string
  workspace_id: string
  phone_normalized: string
  queue_order: number
  status: SessionLeadStatus
  outcome: CallOutcome | null
  completed_at: string | null
  leads?: Lead | null
}

// ---------------------------------------------------------------------------
// Call scripts
// ---------------------------------------------------------------------------

export type ScriptBlockKind =
  | 'opening' | 'question' | 'pitch' | 'objection' | 'close' | 'voicemail' | 'note'

export const SCRIPT_BLOCK_KINDS: ScriptBlockKind[] =
  ['opening', 'question', 'pitch', 'objection', 'close', 'voicemail', 'note']

export const SCRIPT_BLOCK_LABELS: Record<ScriptBlockKind, string> = {
  opening: 'Opening',
  question: 'Question',
  pitch: 'Pitch',
  objection: 'Objection',
  close: 'Close',
  voicemail: 'Voicemail',
  note: 'Note',
}

export const SCRIPT_BLOCK_TONES: Record<ScriptBlockKind, 'good' | 'info' | 'warn' | 'bad' | 'neutral' | 'violet'> = {
  opening: 'good',
  question: 'info',
  pitch: 'violet',
  objection: 'warn',
  close: 'good',
  voicemail: 'neutral',
  note: 'neutral',
}

export interface ScriptBranch {
  /** Phrases that route here when heard. Also the label on the manual button. */
  trigger: string[]
  goto: string
  label?: string
}

export interface ScriptBlock {
  id: string
  kind: ScriptBlockKind
  label?: string
  /** Spoken words and delivery cues. Quoted lines are read aloud. */
  text: string
  /**
   * Why this block is worded the way it is. Never shown mid-call — rationale
   * displayed at the moment it cannot be read is worse than useless, and the
   * alternative is keeping it outside the product where it drifts from the
   * script it explains.
   */
  notes?: string
  /**
   * The primary action, in the prospect's voice. Four branch chips read as
   * things a prospect says and the fifth read "Next", so the rep had to
   * translate mid-call — and "Next" is not something anyone can say.
   */
  advance_label?: string
  /** Phrases that mean "this block worked, move on". */
  advance_on?: string[]
  branches?: ScriptBranch[]
  next?: string
}

export interface CallScript {
  id: string
  workspace_id: string
  name: string
  description: string | null
  blocks: ScriptBlock[]
  entry_block_id: string
  variables: string[]
  is_default: boolean
  version: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * What a call sounded like from the browser's side, recorded when it ends.
 * Written by the dialer; nothing server-side can see the rep's microphone.
 */
export interface CallQuality {
  input: string | null
  output: string | null
  /** The open mic was a Bluetooth headset — the usual cause of "muffled both ways". */
  bluetooth_input: boolean
  codec: string | null
  /** SDK warning names raised during the call, e.g. 'high-packet-loss'. */
  warnings: string[]
  mos_avg: number | null
  mos_min: number | null
  /** Milliseconds. */
  jitter_max: number | null
  /** Percent, 0–100. */
  packet_loss_max: number | null
}

export interface DialCallLog {
  id: string
  workspace_id: string
  lead_id: string | null
  session_id: string | null
  user_id: string | null
  business_name: string | null
  phone: string
  phone_normalized: string
  direction: string
  mode: string
  twilio_call_sid: string | null
  parent_call_sid: string | null
  conference_name: string | null
  call_status: CallStatus
  outcome: CallOutcome | null
  duration_seconds: number
  recording_sid: string | null
  recording_url: string | null
  recording_duration: number | null
  notes: string | null
  called_at: string
  ended_at: string | null
  script_id: string | null
  /** What actually happened, not what the settings say now. */
  recorded: boolean
  /**
   * Generated: an inbound call that ended without anyone picking up. Never
   * true while a call is still ringing — a call in flight is not one you
   * failed to take.
   */
  missed: boolean
  /*
   * PostgREST returns this as an OBJECT, not an array: call_transcripts has a
   * unique constraint on call_id, so the relationship is detected as
   * one-to-one. It was typed as an array and read with [0], which is undefined
   * on an object — so the Call Log never displayed a transcript, ever.
   *
   * Typed as both because that detection follows the constraint: if the unique
   * on call_id were ever dropped, this silently becomes an array again, and
   * transcriptOf() below handles either without anyone having to notice.
   */
  call_transcripts?:
    | { transcript_text: string; speaker_confidence?: string | null }
    | { transcript_text: string; speaker_confidence?: string | null }[]
    | null
  /** Browser-side audio diagnostics. Null for calls placed before it was recorded. */
  quality: CallQuality | null
}

// ---------------------------------------------------------------------------
// Playbooks — the follow-up templates that fire on a stage change
// ---------------------------------------------------------------------------

export type PlaybookStepKind = 'email' | 'call' | 'research' | 'prep' | 'admin' | 'other'

export const PLAYBOOK_STEP_KINDS: PlaybookStepKind[] =
  ['call', 'email', 'research', 'prep', 'admin', 'other']

export interface PlaybookStep {
  id: string
  title: string
  kind: PlaybookStepKind
  /**
   * What offset_days counts from. 'stage' counts forward from the stage change;
   * 'scheduled' counts from the lead's appointment and is the only way to
   * express a reminder BEFORE a demo.
   */
  anchor?: 'stage' | 'scheduled'
  /** Stored as a string because that is the shape validate_playbook_steps reads. */
  offset_days: string
  due_time?: string
  body_md?: string
}

export interface Playbook {
  id: string
  workspace_id: string
  /** Exactly one of these two is set; the database enforces it. */
  trigger_stage: PipelineStage | null
  trigger_outcome: CallOutcome | null
  name: string
  steps: PlaybookStep[]
  is_active: boolean
  created_at: string
  updated_at: string
}

/** One row of workspace_missed_calls(). */
export interface MissedCall {
  id: string
  lead_id: string | null
  business_name: string | null
  phone: string
  called_at: string
  has_voicemail: boolean
  /** True once any outbound call went to that number afterwards. */
  called_back: boolean
}

export interface TwilioSettings {
  workspace_id: string
  account_sid: string | null
  phone_number: string | null
  api_key_sid: string | null
  twiml_app_sid: string | null
  is_configured: boolean
  last_verified_at: string | null
}

// ── Pipeline ───────────────────────────────────────────────────────────────
// The one thing you manage about a lead. It used to sit beside `status`, which
// claimed to be the different question "have we worked this row" — but 145 of
// 152 leads paired the two exactly, the remaining 7 were drift, and one status
// value was never used at all. Stage said all of it, and said it right.
export type PipelineStage =
  | 'new' | 'called' | 'demo_booked' | 'demo_no_show' | 'demo_completed'
  | 'pilot' | 'paying' | 'lost' | 'not_a_fit'

/** Forward motion. Lost and Not a Fit are exits, not steps — see EXIT_STAGES. */
export const PIPELINE_STAGES: PipelineStage[] =
  ['new', 'called', 'demo_booked', 'demo_completed', 'pilot', 'paying']

/**
 * Went backwards but is not over. Kept out of the forward chain because
 * booked → no-show → completed is not a sequence anyone walks, and putting it
 * there would make every adjacent-stage ratio in the funnel meaningless.
 */
export const SETBACK_STAGES: PipelineStage[] = ['demo_no_show']

export const EXIT_STAGES: PipelineStage[] = ['lost', 'not_a_fit']
/**
 * Every stage, in the order the database declares them — which is also the
 * order they happen in. Built from the groups above it would put No-show after
 * Paying, and a rep marking one looks for it beside Demo booked, not at the
 * far end of a picker.
 */
export const ALL_STAGES: PipelineStage[] = [
  'new', 'called', 'demo_booked', 'demo_no_show', 'demo_completed',
  'pilot', 'paying', 'lost', 'not_a_fit',
]

export const STAGE_LABELS: Record<PipelineStage, string> = {
  new: 'New',
  called: 'Called',
  demo_booked: 'Demo booked',
  demo_no_show: 'No-show',
  demo_completed: 'Demo done',
  pilot: 'Pilot',
  paying: 'Paying',
  lost: 'Lost',
  not_a_fit: 'Not a fit',
}

export const STAGE_TONES:
  Record<PipelineStage, 'good' | 'info' | 'warn' | 'bad' | 'neutral' | 'violet'> = {
  new: 'neutral',
  called: 'info',
  // Booked is a promise and completed is a delivery, so they must not read as
  // the same colour at a glance — that is the whole point of splitting them.
  demo_booked: 'warn',
  // Amber, not red: nothing has been lost yet, it just needs rebooking.
  demo_no_show: 'warn',
  demo_completed: 'violet',
  pilot: 'good',
  paying: 'good',
  lost: 'bad',
  not_a_fit: 'bad',
}

/** Three values, not a 0-100 score: a model asked for a score returns 73 and
 *  means nothing by it. A = call today, B = worth a call, C = if the list dries up. */
export type LeadTier = 'a' | 'b' | 'c'
export const ALL_TIERS: LeadTier[] = ['a', 'b', 'c']

export type TaskStatus = 'open' | 'done' | 'cancelled'
export type TaskKind = 'email' | 'call' | 'research' | 'prep' | 'admin' | 'other'

export interface Task {
  id: string
  workspace_id: string
  lead_id: string | null
  title: string
  body_md: string | null
  kind: TaskKind
  status: TaskStatus
  due_at: string
  playbook_id: string | null
  playbook_step_id: string | null
  source: 'playbook' | 'human' | 'claude'
  closed_at: string | null
  closed_by: 'human' | 'claude' | 'system' | null
  outcome_note: string | null
  result_json: Record<string, unknown>
  snooze_count: number
  created_at: string
  updated_at: string
  leads?: { id: string; business_name: string; phone: string } | null
}

export interface FunnelRow {
  stage: PipelineStage
  leads: number
  oldest_days: number
}

export interface LeadFilters {
  search?: string
  stages?: PipelineStage[]
  tiers?: LeadTier[]
  tags?: string[]
  outcomes?: CallOutcome[]
  city?: string
  state?: string
  /** Inclusive room-count bounds. Leads with no count are excluded by either. */
  rooms_min?: number
  rooms_max?: number
  /**
   * Whether anything is queued for the lead — an open task.
   *
   * The pipeline flow's amber "No next step" node is a worklist, so it has to
   * open one. Backed by leads.open_task_count rather than a join, because
   * "has no open task" is a NOT EXISTS that a lead list cannot express.
   */
  has_next_step?: boolean
  never_called?: boolean
  not_called_since?: string
}

export interface CallStats {
  calls_today: number
  calls_week: number
  calls_month: number
  leads_today: number
  leads_week: number
  leads_month: number
  calls_total: number
  talk_seconds_today: number
  connected_month: number
  dispositioned_month: number
  connection_rate: number
}

export interface DailyCallPoint {
  day: string
  calls: number
  connects: number
}

export interface ImportResult {
  received: number
  inserted: number
  updated: number
  skipped: number
}

/** Lead fields a CSV column can be mapped onto. */
export const IMPORT_FIELDS = [
  { key: 'business_name', label: 'Business Name', required: true },
  { key: 'contact_name', label: 'Contact Name', required: false },
  { key: 'room_count', label: 'Rooms', required: false },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'address', label: 'Address', required: false },
  { key: 'city', label: 'City', required: false },
  { key: 'state', label: 'State', required: false },
  { key: 'zip', label: 'ZIP', required: false },
  { key: 'website', label: 'Website', required: false },
  { key: 'email', label: 'Email', required: false },
  { key: 'notes', label: 'Notes', required: false },
] as const

export type ImportField = (typeof IMPORT_FIELDS)[number]['key']

/** Reads the transcript whichever shape PostgREST decided to send. */
export function transcriptOf(call: DialCallLog): string | null {
  return transcriptRow(call)?.transcript_text?.trim() || null
}

/** The whole embedded row, for callers that also want how it was produced. */
export function transcriptRow(
  call: DialCallLog,
): { transcript_text: string; speaker_confidence?: string | null } | null {
  const embed = call.call_transcripts
  if (!embed) return null
  return (Array.isArray(embed) ? embed[0] : embed) ?? null
}
