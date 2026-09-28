/**
 * Playbooks — the follow-up templates that fire when a lead changes stage.
 *
 * This existed only through the connector, which meant the machinery that
 * generates the rep's daily task list could not be read, edited or switched off
 * without asking Claude what was in it. That is an uncomfortable place for
 * automation to live: you find out what a playbook does by watching it happen.
 *
 * The form is deliberately thin. Every rule — at most eight steps, unique ids,
 * a known kind, offsets in range, negative only against a real appointment —
 * is a CHECK constraint calling validate_playbook_steps(), so this page saves
 * and lets the database refuse. Restating the rules here would just create a
 * second copy to drift.
 */
import { ChevronDown, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { ErrorState } from '@/components/ui/error-state'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/misc'
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from '@/components/ui/dropdown'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/table'
import {
  useActivatePlaybook, useDeletePlaybook, usePlaybooks, useSavePlaybook,
} from '@/hooks/usePlaybooks'
import {
  OUTCOME_LABELS, PIPELINE_STAGES, PLAYBOOK_OUTCOMES, PLAYBOOK_STEP_KINDS, STAGE_LABELS,
  type CallOutcome, type Playbook, type PlaybookStep, type PlaybookStepKind,
  type PipelineStage,
} from '@/lib/types'

/**
 * One trigger and whatever fires on it.
 *
 * Shared by the stage grid and the outcome grid. It was inline in the stage
 * grid, and the outcome section would have made it the second copy of the
 * activate-vs-deactivate switch and the step preview.
 */
function TriggerPanel({
  title, fires, empty, playbooks, onNew, onEdit, onToggle,
}: {
  title: string
  fires: string
  empty: string
  playbooks: Playbook[]
  onNew: () => void
  onEdit: (playbook: Playbook) => void
  onToggle: (playbook: Playbook, next: boolean) => void
}) {
  return (
    <Panel>
      <PanelHeader
        title={title}
        description={
          playbooks.some((p) => p.is_active) ? `Fires ${fires}.` : `Nothing fires ${fires}.`
        }
        actions={
          <Button variant="outline" size="sm" onClick={onNew}>
            <Plus />
            New
          </Button>
        }
      />

      {playbooks.length === 0 ? (
        <EmptyState title="No playbook" description={empty} />
      ) : (
        <div className="divide-y divide-line-soft">
          {playbooks.map((playbook) => (
            <div key={playbook.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEdit(playbook)}
                  className="min-w-0 flex-1 text-left text-[13px] font-medium text-ink hover:text-accent"
                >
                  {playbook.name}
                </button>
                <span className="shrink-0 text-[10px] text-ink-faint">
                  {playbook.steps.length} {playbook.steps.length === 1 ? 'step' : 'steps'}
                </span>
                <Switch
                  checked={playbook.is_active}
                  onCheckedChange={(next) => onToggle(playbook, next)}
                />
              </div>

              {/* What it will do, before it does it — the thing you could not
                  see without asking Claude. */}
              <ol className="mt-2 space-y-1">
                {playbook.steps.map((step) => (
                  <li key={step.id} className="flex gap-2 text-[11px]">
                    <span className="w-28 shrink-0 text-ink-faint">{describeTiming(step)}</span>
                    <span className="text-ink-dim">
                      {step.title}
                      <span className="ml-1.5 text-ink-faint">({step.kind})</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

/** Stages a playbook may fire on. Terminal stages cancel work, never create it. */
const TRIGGER_STAGES = PIPELINE_STAGES

const EMPTY_STEP = (n: number): PlaybookStep => ({
  id: `step_${n}`,
  title: '',
  kind: 'call',
  anchor: 'stage',
  offset_days: '1',
})

/** "+3 days after the stage change" / "1 day before the appointment", in words. */
function describeTiming(step: PlaybookStep): string {
  const days = Number.parseInt(step.offset_days, 10)
  const at = step.due_time ? ` at ${step.due_time}` : ' at 09:00'

  if ((step.anchor ?? 'stage') === 'scheduled') {
    if (days === 0) return `On the day of the appointment${at}`
    return days < 0
      ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} before the appointment${at}`
      : `${days} day${days === 1 ? '' : 's'} after the appointment${at}`
  }
  if (days === 0) return `Same day${at}`
  return `${days} day${days === 1 ? '' : 's'} later${at}`
}

export function PlaybooksPage() {
  const playbooks = usePlaybooks()
  const save = useSavePlaybook()
  const activate = useActivatePlaybook()
  const remove = useDeletePlaybook()

  const [editing, setEditing] = useState<Partial<Playbook> | null>(null)
  const rows = playbooks.data ?? []

  const openNewStage = (stage: PipelineStage) =>
    setEditing({
      trigger_stage: stage,
      trigger_outcome: null,
      name: `${STAGE_LABELS[stage]} follow-up`,
      steps: [EMPTY_STEP(1)],
      is_active: true,
    })

  const openNewOutcome = (outcome: CallOutcome) =>
    setEditing({
      trigger_stage: null,
      trigger_outcome: outcome,
      name: `${OUTCOME_LABELS[outcome]} follow-up`,
      steps: [EMPTY_STEP(1)],
      is_active: true,
    })

  const toggle = (playbook: Playbook, next: boolean) => {
    if (next) activate.mutate(playbook.id)
    else save.mutate({ id: playbook.id, is_active: false })
  }

  // Only outcomes that already have one get a panel. Rendering all seven empty
  // would bury the stage playbooks under a page of nothing.
  const outcomesInUse = PLAYBOOK_OUTCOMES.filter((o) =>
    rows.some((p) => p.trigger_outcome === o),
  )

  return (
    <>
      <PageHeader
        title="Playbooks"
        badge={rows.length ? <Badge tone="neutral">{rows.length}</Badge> : undefined}
      />

      <PageBody className="space-y-4">
        <p className="text-xs leading-relaxed text-ink-faint">
          A playbook creates the follow-ups on your dashboard — either when a lead moves into a
          stage, or the moment a call gets an outcome. Moving a lead to Lost or Not a fit cancels
          whatever is still open, which is why neither can have one.
        </p>

        {playbooks.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : playbooks.isError ? (
          <ErrorState
            what="playbooks"
            error={playbooks.error}
            onRetry={() => void playbooks.refetch()}
          />
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-2">
              {TRIGGER_STAGES.map((stage) => (
                <TriggerPanel
                  key={stage}
                  title={STAGE_LABELS[stage]}
                  fires="when a lead enters this stage"
                  empty="Leads reaching this stage create no follow-ups."
                  playbooks={rows.filter((p) => p.trigger_stage === stage)}
                  onNew={() => openNewStage(stage)}
                  onEdit={setEditing}
                  onToggle={toggle}
                />
              ))}
            </div>

            {/* A stage is something you decide; an outcome is something that
                happened to you. "Callback requested" is a promise to a person
                and it created nothing, because there was no stage to hang it
                on. */}
            <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
              <div>
                <h2 className="text-[13px] font-semibold text-ink">When a call gets an outcome</h2>
                <p className="mt-0.5 text-xs text-ink-faint">
                  Fires the moment you disposition a call, before anyone has decided what the
                  lead is.
                </p>
              </div>
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Plus />
                    New outcome playbook
                    <ChevronDown />
                  </Button>
                </DropdownTrigger>
                <DropdownContent align="end">
                  {PLAYBOOK_OUTCOMES.map((outcome) => (
                    <DropdownItem key={outcome} onSelect={() => openNewOutcome(outcome)}>
                      {OUTCOME_LABELS[outcome]}
                    </DropdownItem>
                  ))}
                </DropdownContent>
              </Dropdown>
            </div>

            {outcomesInUse.length === 0 ? (
              <EmptyState
                title="Nothing fires on an outcome"
                description="A lead dispositioned Callback Requested or Voicemail gets no follow-up until one of these exists."
              />
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {outcomesInUse.map((outcome) => (
                  <TriggerPanel
                    key={outcome}
                    title={OUTCOME_LABELS[outcome]}
                    fires="when a call is dispositioned this way"
                    empty="No follow-ups."
                    playbooks={rows.filter((p) => p.trigger_outcome === outcome)}
                    onNew={() => openNewOutcome(outcome)}
                    onEdit={setEditing}
                    onToggle={toggle}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </PageBody>

      {editing && (
        <PlaybookEditor
          playbook={editing}
          onClose={() => setEditing(null)}
          onSave={(next) =>
            save.mutate(next, {
              onSuccess: () => {
                toast.success('Playbook saved')
                setEditing(null)
              },
            })
          }
          onDelete={
            editing.id
              ? () => {
                  if (!window.confirm(`Delete "${editing.name}"? Tasks it already created stay.`)) return
                  remove.mutate(editing.id!, { onSuccess: () => setEditing(null) })
                }
              : undefined
          }
          saving={save.isPending}
        />
      )}
    </>
  )
}

function PlaybookEditor({
  playbook,
  onClose,
  onSave,
  onDelete,
  saving,
}: {
  playbook: Partial<Playbook>
  onClose: () => void
  onSave: (playbook: Partial<Playbook>) => void
  onDelete?: () => void
  saving: boolean
}) {
  const [name, setName] = useState(playbook.name ?? '')
  const [steps, setSteps] = useState<PlaybookStep[]>(playbook.steps ?? [EMPTY_STEP(1)])

  const patch = (index: number, changes: Partial<PlaybookStep>) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...changes } : s)))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={playbook.id ? 'Edit playbook' : 'New playbook'}
        description={
          playbook.trigger_outcome
            ? `Fires when a call is dispositioned ${OUTCOME_LABELS[playbook.trigger_outcome]}.`
            : `Fires when a lead enters ${STAGE_LABELS[playbook.trigger_stage as PipelineStage]}.`
        }
        size="lg"
      >
        <DialogBody className="space-y-4">
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          {steps.map((step, index) => (
            <div key={index} className="space-y-3 rounded-[6px] border border-line p-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  Step {index + 1}
                </span>
                <span className="ml-auto text-[10px] text-ink-faint">
                  {describeTiming(step)}
                </span>
                {steps.length > 1 && (
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <X />
                  </Button>
                )}
              </div>

              <Field label="What to do">
                <Input
                  value={step.title}
                  onChange={(event) => patch(index, { title: event.target.value })}
                  placeholder="Send the demo recap"
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Kind">
                  <Select
                    value={step.kind}
                    onValueChange={(value) => patch(index, { kind: value as PlaybookStepKind })}
                    options={PLAYBOOK_STEP_KINDS.map((k) => ({ value: k, label: k }))}
                  />
                </Field>
                <Field label="Counts from">
                  <Select
                    value={step.anchor ?? 'stage'}
                    onValueChange={(value) =>
                      patch(index, { anchor: value as 'stage' | 'scheduled' })
                    }
                    options={[
                      { value: 'stage', label: 'Stage change' },
                      { value: 'scheduled', label: 'Appointment' },
                    ]}
                  />
                </Field>
                <Field
                  label="Days"
                  hint={
                    (step.anchor ?? 'stage') === 'scheduled'
                      ? 'Negative for before, e.g. -1.'
                      : undefined
                  }
                >
                  <Input
                    type="number"
                    className="tabular"
                    min={(step.anchor ?? 'stage') === 'scheduled' ? -30 : 0}
                    max={90}
                    value={step.offset_days}
                    onChange={(event) => patch(index, { offset_days: event.target.value })}
                  />
                </Field>
                <Field label="At">
                  <Input
                    type="time"
                    value={step.due_time ?? '09:00'}
                    onChange={(event) => patch(index, { due_time: event.target.value })}
                  />
                </Field>
              </div>

              <Field label="Notes" hint="Optional. Shown on the task, and read by Claude.">
                <Textarea
                  rows={2}
                  value={step.body_md ?? ''}
                  onChange={(event) => patch(index, { body_md: event.target.value })}
                />
              </Field>
            </div>
          ))}

          {/* Eight is the database's ceiling, not this page's opinion. */}
          {steps.length < 8 && (
            <Button
              variant="outline"
              onClick={() => setSteps((prev) => [...prev, EMPTY_STEP(prev.length + 1)])}
            >
              <Plus />
              Add step
            </Button>
          )}
        </DialogBody>

        <DialogFooter>
          {onDelete && (
            <Button variant="dangerGhost" onClick={onDelete} className="mr-auto">
              <Trash2 />
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || !name.trim() || steps.some((s) => !s.title.trim())}
            onClick={() =>
              onSave({
                ...playbook,
                name: name.trim(),
                steps: steps.map((s) => ({
                  ...s,
                  title: s.title.trim(),
                  body_md: s.body_md?.trim() || undefined,
                })),
              })
            }
          >
            {saving ? 'Saving…' : 'Save playbook'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
