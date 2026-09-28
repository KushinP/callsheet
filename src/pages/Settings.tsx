import {
  CheckCircle2, ExternalLink, Loader2, Mic, ShieldCheck, Users, ShieldAlert,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { MicPicker } from '@/components/dialer/MicPicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { useAuth } from '@/hooks/useAuth'
import { useDialer } from '@/hooks/useDialer'
import { useWorkspace } from '@/hooks/useWorkspace'
import { callFunction, supabase } from '@/lib/supabase'
import { errorMessage, formatDateTime } from '@/lib/utils'

export function SettingsPage() {
  const { user } = useAuth()
  const {
    workspace, workspaceId, isAdmin, twilio, refreshTwilio, refreshWorkspaces,
  } = useWorkspace()
  const { refreshInputDevices, deviceError } = useDialer()

  // Prefilled from what is already stored: the SID is not a secret, and making
  // someone re-find it in the Twilio console to re-save is friction for nothing.
  // The auth token is deliberately NOT prefilled — it lives in a table only the
  // service role can read and never comes back to the browser.
  const [accountSid, setAccountSid] = useState(twilio?.account_sid ?? '')
  const [authToken, setAuthToken] = useState('')
  const [phoneNumber, setPhoneNumber] = useState(twilio?.phone_number ?? '')
  const [saving, setSaving] = useState(false)
  const [savingRecording, setSavingRecording] = useState(false)
  const [calendlyUrl, setCalendlyUrl] = useState(workspace?.calendly_url ?? '')
  const [forwardTo, setForwardTo] = useState(workspace?.forward_to_number ?? '')
  const [agentNumber, setAgentNumber] = useState(workspace?.voice_agent_number ?? '')
  const [budgetMinutes, setBudgetMinutes] = useState(
    workspace?.monthly_minute_budget ? String(workspace.monthly_minute_budget) : '',
  )

  const [fullName, setFullName] = useState(
    (user?.user_metadata?.full_name as string | undefined) ?? '',
  )
  const [workspaceName, setWorkspaceName] = useState(workspace?.name ?? '')
  const [minRooms, setMinRooms] = useState(
    workspace?.min_rooms ? String(workspace.min_rooms) : '',
  )

  // Both fields are seeded from queries that have not resolved at mount, so
  // without this they stay empty forever. Worse for the workspace name: '' is
  // not equal to the real name, so Save became enabled against a blank field
  // and one click would wipe it.
  useEffect(() => {
    if (workspace?.name) setWorkspaceName(workspace.name)
  }, [workspace?.name])

  useEffect(() => {
    setCalendlyUrl(workspace?.calendly_url ?? '')
  }, [workspace?.calendly_url])

  useEffect(() => {
    setForwardTo(workspace?.forward_to_number ?? '')
  }, [workspace?.forward_to_number])

  useEffect(() => {
    setAgentNumber(workspace?.voice_agent_number ?? '')
  }, [workspace?.voice_agent_number])

  useEffect(() => {
    setMinRooms(workspace?.min_rooms ? String(workspace.min_rooms) : '')
    setBudgetMinutes(
      workspace?.monthly_minute_budget ? String(workspace.monthly_minute_budget) : '',
    )
  }, [workspace?.monthly_minute_budget])

  useEffect(() => {
    if (twilio?.phone_number) setPhoneNumber(twilio.phone_number)
  }, [twilio?.phone_number])

  useEffect(() => {
    if (twilio?.account_sid) setAccountSid(twilio.account_sid)
  }, [twilio?.account_sid])

  const saveTwilio = async () => {
    setSaving(true)
    try {
      const result = await callFunction<{ claimedFrom?: string | null }>(
        'twilio-provision',
        {
          workspaceId,
          accountSid: accountSid.trim(),
          authToken: authToken.trim(),
          phoneNumber: phoneNumber.trim(),
        },
      )

      // Callsheet now takes over the number's incoming calls. If that number
      // was already answering somewhere else, that just stopped — better a
      // warning here than discovering it when a customer calls.
      if (result?.claimedFrom) {
        toast.warning(
          `Incoming calls to ${phoneNumber.trim()} now go to Callsheet. They previously went to ${result.claimedFrom}.`,
          { duration: 12000 },
        )
      } else {
        toast.success('Twilio connected. Reload if a call is already open.')
      }
      setAccountSid('')
      setAuthToken('')
      refreshTwilio()
    } catch (error) {
      toast.error(errorMessage(error, 'Could not verify those credentials'))
    } finally {
      setSaving(false)
    }
  }

  const saveInbound = async (patch: Record<string, unknown>) => {
    try {
      const { error } = await supabase.from('workspaces').update(patch).eq('id', workspaceId!)
      if (error) throw error
      await refreshWorkspaces()
      // Taking over a number only happens on the next credential save, because
      // that is the call that talks to Twilio. Say so rather than letting the
      // toggle imply it already took effect.
      if ('answer_inbound' in patch) {
        toast.success(
          patch.answer_inbound
            ? 'Saved. Hit "Verify & save" on the Twilio panel to point the number at Callsheet.'
            : 'Saved. The number keeps its current routing until you re-save Twilio.',
          { duration: 9000 },
        )
      } else {
        toast.success('Incoming call settings saved')
      }
    } catch (error) {
      toast.error(errorMessage(error, 'Could not save that'))
    }
  }

  const saveCalendly = async () => {
    const trimmed = calendlyUrl.trim()
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({ calendly_url: trimmed || null })
        .eq('id', workspaceId!)

      // The database rejects anything that is not a calendly.com link, so a
      // typo surfaces here rather than as an empty iframe later.
      if (error) throw error
      await refreshWorkspaces()
      toast.success(trimmed ? 'Booking link saved' : 'Booking link cleared')
    } catch (error) {
      toast.error(errorMessage(error, 'That does not look like a Calendly link'))
    }
  }

  const saveRecording = async (next: boolean) => {
    setSavingRecording(true)
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({ recording_enabled: next })
        .eq('id', workspaceId!)

      if (error) throw error
      await refreshWorkspaces()
      toast.success(next ? 'Calls will be recorded' : 'Recording turned off')
    } catch (error) {
      toast.error(errorMessage(error, 'Could not change the recording setting'))
    } finally {
      setSavingRecording(false)
    }
  }

  const saveProfile = async () => {
    const { error } = await supabase.auth.updateUser({ data: { full_name: fullName } })
    if (error) {
      toast.error(error.message)
      return
    }
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', user!.id)

    // Do not claim success for a write whose result was never looked at.
    if (profileError) {
      toast.error(profileError.message)
      return
    }
    toast.success('Profile updated')
  }

  const saveWorkspace = async () => {
    const parsedBudget = Number.parseInt(budgetMinutes, 10)
    const parsedRooms = Number.parseInt(minRooms, 10)
    const { error } = await supabase
      .from('workspaces')
      .update({
        name: workspaceName,
        monthly_minute_budget:
          Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : null,
        min_rooms: Number.isFinite(parsedRooms) && parsedRooms > 0 ? parsedRooms : null,
      })
      .eq('id', workspaceId!)

    if (error) {
      toast.error(error.message)
      return
    }
    await refreshWorkspaces()
    toast.success('Workspace saved')
  }

  return (
    <>
      <PageHeader title="Settings" description={workspace?.name} />

      <PageBody className="mx-auto max-w-3xl space-y-4">
        {/* Twilio */}
        <Panel>
          <PanelHeader
            title="Twilio configuration"
            description="Per workspace, not a hidden deploy config."
            actions={
              twilio?.is_configured ? (
                <Badge tone="good">
                  <CheckCircle2 className="size-2.5" />
                  Connected
                </Badge>
              ) : (
                <Badge tone="warn">Not configured</Badge>
              )
            }
          />

          <div className="space-y-4 p-4">
            {twilio?.is_configured && (
              <dl className="grid gap-3 sm:grid-cols-3">
                {[
                  ['Phone number', twilio.phone_number],
                  ['Account SID', twilio.account_sid ? `${twilio.account_sid.slice(0, 10)}…` : '—'],
                  ['Verified', formatDateTime(twilio.last_verified_at)],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <dt className="text-[10px] uppercase tracking-wider text-ink-faint">
                      {label}
                    </dt>
                    <dd className="tabular mt-0.5 truncate text-xs text-ink-dim">
                      {value || '—'}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {!isAdmin && (
              <p className="rounded-[5px] border border-line bg-base px-3 py-2 text-[11px] text-ink-faint">
                Only a workspace owner or admin can change these credentials.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Account SID"
                hint="Starts with AC. Twilio Console dashboard."
                className="sm:col-span-2"
              >
                <Input
                  value={accountSid}
                  onChange={(event) => setAccountSid(event.target.value)}
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="tabular"
                  disabled={!isAdmin}
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Auth Token"
                hint="Stored server-side only. It is never sent back to the browser."
                className="sm:col-span-2"
              >
                <Input
                  type="password"
                  value={authToken}
                  onChange={(event) => setAuthToken(event.target.value)}
                  placeholder="••••••••••••••••••••••••••••••••"
                  className="tabular"
                  disabled={!isAdmin}
                  autoComplete="off"
                />
              </Field>

              <Field label="Twilio phone number" hint="The number your dialer calls FROM.">
                <Input
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  placeholder="+15550109999"
                  className="tabular"
                  disabled={!isAdmin}
                />
              </Field>
            </div>

            <div className="rounded-[6px] border border-line bg-base p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-dim">
                <ShieldCheck className="size-3.5 text-accent" />
                What happens when you save
              </p>
              <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[11px] leading-relaxed text-ink-faint">
                <li>Your credentials are verified against the Twilio API.</li>
                <li>The number is checked for Voice capability on your account.</li>
                <li>
                  An API key and a TwiML app are created for you and pointed at this
                  project's voice webhook — browser calling needs both, and this saves
                  you finding them in the Twilio console.
                </li>
                <li>
                  The Auth Token and API key secret go into a table only the edge
                  functions can read.
                </li>
              </ol>
            </div>

            <div className="flex items-center justify-between gap-3">
              <a
                href="https://console.twilio.com"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-accent"
              >
                Open Twilio Console
                <ExternalLink className="size-3" />
              </a>
              <Button
                variant="primary"
                onClick={() => void saveTwilio()}
                disabled={!isAdmin || saving || !accountSid.trim() || !authToken.trim()}
              >
                {saving && <Loader2 className="animate-spin" />}
                Verify & save
              </Button>
            </div>
          </div>
        </Panel>

        {/* Microphone */}
        <Panel>
          <PanelHeader
            title="Microphone"
            description="Twilio captures whatever the default input was at page load."
          />
          <div className="space-y-3 p-4">
            {deviceError && (
              <p className="rounded-[5px] border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                {deviceError}
              </p>
            )}
            <MicPicker />
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Paired a Bluetooth headset after this page loaded? Hit rescan — the
              Twilio device will keep using the old input until you pick the new one
              explicitly.
            </p>
            <Button variant="outline" size="sm" onClick={() => void refreshInputDevices()}>
              <Mic />
              Grant mic access & rescan
            </Button>
          </div>
        </Panel>

        {/* Call recording */}
        <Panel>
          <PanelHeader
            title="Call recording"
            description="Applies to every call unless a session overrides it."
          />
          <div className="space-y-3 p-4">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-xs font-medium text-ink">Record calls by default</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">
                  Recordings are pulled off Twilio into your own storage, then transcribed if
                  a transcription key is set. Turning this off stops the recording, the
                  transcript, and everything downstream of them.
                </span>
              </span>
              <Switch
                checked={workspace?.recording_enabled ?? true}
                disabled={!isAdmin || savingRecording}
                onCheckedChange={(next) => void saveRecording(next)}
              />
            </label>

            <p className="rounded-[5px] border border-warn/25 bg-warn/[0.06] px-3 py-2 text-[11px] leading-relaxed text-ink-dim">
              <ShieldAlert className="mr-1 inline size-3.5 text-warn" />
              Recording law differs by state. In roughly a dozen US states every party on the
              call must consent before it is recorded, and Callsheet does not know where you
              or the person you are calling are sitting. If you record, say so at the start of
              the call — the prompter shows a reminder when recording is on. This toggle is a
              control, not legal advice.
            </p>

            {!isAdmin && (
              <p className="text-[11px] text-ink-faint">Only workspace admins can change this.</p>
            )}
          </div>
        </Panel>

        {/* Incoming calls */}
        <Panel>
          <PanelHeader
            title="Incoming calls"
            description="What happens when someone calls your number back."
          />
          <div className="space-y-3 p-4">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-xs font-medium text-ink">
                  Answer incoming calls in Callsheet
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">
                  Points {twilio?.phone_number ?? 'your number'} at this app. If that number
                  is already answering somewhere else — a voice agent, an IVR, a demo — this
                  replaces it. Everything below only applies once this is on.
                </span>
              </span>
              <Switch
                checked={workspace?.answer_inbound ?? false}
                disabled={!isAdmin}
                onCheckedChange={(next) => void saveInbound({ answer_inbound: next })}
              />
            </label>

            <Field
              label="Voice agent number"
              hint="One button pulls this onto a live call — no typing while someone is talking."
            >
              <Input
                value={agentNumber}
                onChange={(event) => setAgentNumber(event.target.value)}
                placeholder="+1 555 010 0000"
                inputMode="tel"
                disabled={!isAdmin}
              />
            </Field>

            <Field
              label="Also ring this number"
              hint="Rings in parallel with the browser. Whoever picks up first gets the call."
            >
              <Input
                value={forwardTo}
                onChange={(event) => setForwardTo(event.target.value)}
                placeholder="+1 555 010 9999"
                inputMode="tel"
                disabled={!isAdmin}
              />
            </Field>

            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-xs font-medium text-ink">Record incoming calls</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">
                  Separate from the outbound setting, and off by default. Someone calling you
                  back has been told nothing and did not choose to be on a recorded line.
                </span>
              </span>
              <Switch
                checked={workspace?.record_inbound ?? false}
                disabled={!isAdmin}
                onCheckedChange={(next) => void saveInbound({ record_inbound: next })}
              />
            </label>

            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Unanswered calls go to voicemail, which is recorded and transcribed like any
                other call so you can search it later.
              </p>
              <Button
                variant="secondary"
                onClick={() =>
                  void saveInbound({
                    forward_to_number: forwardTo.trim() || null,
                    voice_agent_number: agentNumber.trim() || null,
                  })
                }
                disabled={
                  !isAdmin ||
                  (forwardTo === (workspace?.forward_to_number ?? '') &&
                    agentNumber === (workspace?.voice_agent_number ?? ''))
                }
              >
                Save
              </Button>
            </div>
          </div>
        </Panel>

        {/* Booking */}
        <Panel>
          <PanelHeader
            title="Booking"
            description="Opens automatically when you log a call as an appointment."
          />
          <div className="space-y-3 p-4">
            <Field
              label="Calendly link"
              hint="Your public scheduling link, e.g. https://calendly.com/you/discovery-call"
            >
              <Input
                value={calendlyUrl}
                onChange={(event) => setCalendlyUrl(event.target.value)}
                placeholder="https://calendly.com/…"
                disabled={!isAdmin}
              />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] leading-relaxed text-ink-faint">
                The booking panel prefills the lead's name and email. Callsheet does not
                read your calendar back — the call log records that an appointment was
                set, and Calendly holds when.
              </p>
              <Button
                variant="secondary"
                onClick={() => void saveCalendly()}
                disabled={!isAdmin || calendlyUrl === (workspace?.calendly_url ?? '')}
              >
                Save
              </Button>
            </div>
          </div>
        </Panel>

        {/* Workspace */}
        <Panel>
          <PanelHeader title="Workspace" description="Shared by everyone on your team." />
          <div className="space-y-3 p-4">
            <Field
              label="Monthly talk-time budget"
              hint="Connected minutes, the only thing that really drives the bill. Blank means no ceiling."
            >
              <Input
                type="number"
                min={1}
                value={budgetMinutes}
                onChange={(event) => setBudgetMinutes(event.target.value)}
                placeholder="1900"
                className="tabular"
                disabled={!isAdmin}
              />
            </Field>
            {/* The cheapest qualifier there is, and it was not a setting: three
                of the first eight real conversations died on room count while
                2-room B&Bs sat at tier A. */}
            <Field
              label="Smallest property worth calling"
              hint="In rooms. A lead with a known room count under this is capped at tier C. The brief's own tier is kept, and comes back if you lower this. Blank means no floor."
            >
              <Input
                type="number"
                min={1}
                value={minRooms}
                onChange={(event) => setMinRooms(event.target.value)}
                placeholder="6"
                className="tabular"
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Workspace name">
              <Input
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                <Users className="size-3.5" />
                Your role: {workspace?.role ?? '—'}
              </span>
              <Button
                variant="secondary"
                onClick={() => void saveWorkspace()}
                disabled={
                  !isAdmin ||
                  (workspaceName === workspace?.name &&
                    budgetMinutes ===
                      (workspace?.monthly_minute_budget
                        ? String(workspace.monthly_minute_budget)
                        : '') &&
                    minRooms === (workspace?.min_rooms ? String(workspace.min_rooms) : ''))
                }
              >
                Save
              </Button>
            </div>
          </div>
        </Panel>

        {/* Profile */}
        <Panel>
          <PanelHeader title="Your profile" />
          <div className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name">
                <Input
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                />
              </Field>
              <Field label="Email">
                <Input value={user?.email ?? ''} readOnly className="text-ink-dim" />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => void saveProfile()}>
                Save
              </Button>
            </div>
          </div>
        </Panel>
      </PageBody>
    </>
  )
}
