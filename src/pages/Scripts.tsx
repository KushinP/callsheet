import {
  ArrowDown, ArrowUp, CornerDownRight, FileText, Play, Plus, Sparkles, Star, Trash2, X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { ScriptPrompter } from '@/components/dialer/ScriptPrompter'
import { useWorkspace } from '@/hooks/useWorkspace'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, Label, Textarea } from '@/components/ui/input'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/table'
import {
  useDeleteScript, useSaveScript, useScripts, useSetDefaultScript,
} from '@/hooks/useScripts'
import { starterScript } from '@/lib/script'
import {
  SCRIPT_BLOCK_KINDS, SCRIPT_BLOCK_LABELS, SCRIPT_BLOCK_TONES,
  type CallScript, type ScriptBlock, type ScriptBlockKind,
} from '@/lib/types'
import { errorMessage, formatRelative } from '@/lib/utils'

export function ScriptsPage() {
  const scripts = useScripts()
  const saveScript = useSaveScript()
  const setDefault = useSetDefaultScript()
  const deleteScript = useDeleteScript()

  const [editing, setEditing] = useState<CallScript | 'new' | null>(null)
  const [previewing, setPreviewing] = useState<CallScript | null>(null)
  const { workspace } = useWorkspace()

  const createStarter = async () => {
    const starter = starterScript()
    try {
      await saveScript.mutateAsync({
        name: starter.name,
        description: starter.description,
        blocks: starter.blocks,
        entry_block_id: starter.entry,
      })
      toast.success('Starter script created — edit it to sound like you')
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <>
      <PageHeader
        title="Scripts"
        description="What you say, on screen while you dial"
        actions={
          <>
            {scripts.data?.length ? null : (
              <Button variant="outline" size="sm" onClick={() => void createStarter()}>
                <Sparkles />
                Start from a template
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
              <Plus />
              New script
            </Button>
          </>
        }
      />

      <PageBody className="space-y-3">
        {scripts.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : scripts.isError ? (
          <Panel>
            <ErrorState
              what="scripts"
              error={scripts.error}
              onRetry={() => void scripts.refetch()}
            />
          </Panel>
        ) : scripts.data?.length ? (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {scripts.data.map((script) => (
              <Panel key={script.id} className="flex flex-col">
                <PanelHeader
                  title={script.name}
                  description={`${script.blocks.length} blocks · edited ${formatRelative(script.updated_at)}`}
                  actions={script.is_default ? <Badge tone="good">Default</Badge> : undefined}
                />
                <div className="flex-1 space-y-2 p-4">
                  {script.description && (
                    <p className="text-xs leading-relaxed text-ink-dim">{script.description}</p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {script.blocks.slice(0, 6).map((b) => (
                      <Badge key={b.id} tone={SCRIPT_BLOCK_TONES[b.kind]}>
                        {b.label || SCRIPT_BLOCK_LABELS[b.kind]}
                      </Badge>
                    ))}
                    {script.blocks.length > 6 && (
                      <Badge tone="neutral">+{script.blocks.length - 6}</Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 border-t border-line px-3 py-2.5">
                  {/* Walk the script the way the rep will, without needing a
                      live call to find out that a branch points at a block that
                      no longer exists. */}
                  <Button variant="secondary" size="sm" onClick={() => setPreviewing(script)}>
                    <Play />
                    Preview
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(script)}>
                    Edit
                  </Button>
                  {!script.is_default && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDefault.mutate(script.id)}
                      title="Sessions with no script pinned will use this one"
                    >
                      <Star />
                      Make default
                    </Button>
                  )}
                  <Button
                    variant="dangerGhost"
                    size="iconSm"
                    className="ml-auto"
                    title="Delete script"
                    onClick={() => {
                      if (!window.confirm(`Delete "${script.name}"?`)) return
                      deleteScript.mutate(script.id)
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </Panel>
            ))}
          </div>
        ) : (
          <Panel>
            <EmptyState
              icon={<FileText />}
              title="No scripts yet"
              description="A script is what shows up beside the dialer while you call — the opening, your questions, and answers to the objections you hear most. Start from a template and rewrite it to sound like you."
              action={
                <Button variant="primary" size="sm" onClick={() => void createStarter()}>
                  <Sparkles />
                  Start from a template
                </Button>
              }
            />
          </Panel>
        )}
      </PageBody>

      <Dialog open={Boolean(previewing)} onOpenChange={(open) => !open && setPreviewing(null)}>
        <DialogContent
          title={previewing?.name ?? 'Preview'}
          description="What the prompter shows, with no lead loaded — highlighted words fill in from the lead on a real call. Nothing here is dialled or saved."
          size="md"
        >
          <DialogBody>
            {previewing && (
              <ScriptPrompter
                script={previewing}
                /* No lead, so {{business_name}} stays visible as a placeholder
                   rather than silently rendering blank — which is the point of
                   a preview: seeing where the gaps are. */
                lead={null}
                resetKey={previewing.id}
                recording={workspace?.recording_enabled ?? true}
                /* Not a call, so the rationale behind each block is worth reading —
                   this is the one place it can be. */
                live={false}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {editing && (
        <ScriptEditor
          script={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

const EMPTY_BLOCK = (index: number): ScriptBlock => ({
  id: `block_${index}_${Math.random().toString(36).slice(2, 6)}`,
  kind: 'question',
  label: '',
  text: '',
})

function ScriptEditor({ script, onClose }: { script: CallScript | null; onClose: () => void }) {
  const saveScript = useSaveScript()

  const [name, setName] = useState(script?.name ?? '')
  const [description, setDescription] = useState(script?.description ?? '')
  const [blocks, setBlocks] = useState<ScriptBlock[]>(
    script?.blocks?.length ? script.blocks : [{ ...EMPTY_BLOCK(0), kind: 'opening', label: 'Opening' }],
  )

  const update = (index: number, patch: Partial<ScriptBlock>) =>
    setBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)))

  const move = (index: number, delta: number) =>
    setBlocks((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  const save = async () => {
    if (!name.trim()) return toast.error('Give the script a name')
    const cleaned = blocks
      .map((b) => ({ ...b, text: b.text.trim(), label: b.label?.trim() || undefined }))
      .filter((b) => b.text)

    if (cleaned.length === 0) return toast.error('A script needs at least one block with text')

    try {
      await saveScript.mutateAsync({
        id: script?.id,
        name,
        description,
        blocks: cleaned,
        entry_block_id: cleaned[0].id,
      })
      toast.success(script ? 'Script saved' : 'Script created')
      onClose()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={script ? `Edit “${script.name}”` : 'New script'}
        description="Blocks run top to bottom. The first one is where every call starts."
        size="xl"
      >
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Local services cold call"
              />
            </Field>
            <Field label="Description" hint="Optional — what this script is for.">
              <Input
                value={description ?? ''}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Opening, qualifying, objections, close"
              />
            </Field>
          </div>

          <div className="rounded-[6px] border border-line bg-base px-3 py-2">
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Anything in quotes is read aloud; anything else renders as a dimmed delivery
              cue on its own line, so a rep skimming mid-call cannot say it by mistake.{' '}
              Use <code className="tabular text-ink-dim">{'{{business_name}}'}</code>,{' '}
              <code className="tabular text-ink-dim">{'{{city}}'}</code> or{' '}
              <code className="tabular text-ink-dim">{'{{state}}'}</code> and the prompter fills
              them in from the lead as you dial.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Blocks</Label>
            {blocks.map((block, index) => (
              <div key={block.id} className="space-y-2 rounded-[6px] border border-line bg-base p-3">
                <div className="flex items-center gap-2">
                  <span className="tabular w-5 text-[11px] text-ink-faint">{index + 1}</span>
                  <Select
                    value={block.kind}
                    onValueChange={(value) => update(index, { kind: value as ScriptBlockKind })}
                    options={SCRIPT_BLOCK_KINDS.map((k) => ({ value: k, label: SCRIPT_BLOCK_LABELS[k] }))}
                    className="w-36"
                  />
                  <Input
                    value={block.label ?? ''}
                    onChange={(event) => update(index, { label: event.target.value })}
                    placeholder="Label (optional)"
                    className="flex-1"
                  />
                  <Button variant="ghost" size="iconSm" onClick={() => move(index, -1)}
                    disabled={index === 0} title="Move up">
                    <ArrowUp />
                  </Button>
                  <Button variant="ghost" size="iconSm" onClick={() => move(index, 1)}
                    disabled={index === blocks.length - 1} title="Move down">
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="dangerGhost"
                    size="iconSm"
                    title="Remove block"
                    disabled={blocks.length === 1}
                    onClick={() => setBlocks((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <X />
                  </Button>
                </div>

                <Textarea
                  value={block.text}
                  onChange={(event) => update(index, { text: event.target.value })}
                  placeholder={'"What you say here…"\nDelivery cues on their own line, unquoted.'}
                />

                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={block.advance_label ?? ''}
                    onChange={(event) => update(index, { advance_label: event.target.value })}
                    placeholder="Button: “They said yes”"
                    title="The primary action, in the prospect's voice. Defaults to a generic one."
                  />
                  <Input
                    value={block.notes ?? ''}
                    onChange={(event) => update(index, { notes: event.target.value })}
                    placeholder="Why it's worded this way (never shown mid-call)"
                  />
                </div>

                {block.branches && block.branches.length > 0 && (
                  <div className="space-y-1 pl-1">
                    {block.branches.map((branch, bi) => (
                      <p key={bi} className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                        <CornerDownRight className="size-3" />
                        “{branch.trigger.join('”, “')}” → {branch.goto}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setBlocks((prev) => [...prev, EMPTY_BLOCK(prev.length)])}
            >
              <Plus />
              Add block
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-ink-faint">
            Objection branches are easiest to write by asking Claude through the Callsheet
            connector — “add a price objection branch to my cold call script”. They render
            here and are clickable during a call.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saveScript.isPending}>
            {script ? 'Save changes' : 'Create script'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
