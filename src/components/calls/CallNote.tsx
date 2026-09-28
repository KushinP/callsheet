import { Check, NotebookPen, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { useUpdateCallNote } from '@/hooks/useCalls'

/**
 * What happened on a call, written down after it.
 *
 * The note used to be writable in exactly one place and one moment: the
 * disposition bar, in the seconds between hanging up and tapping an outcome.
 * Tap the outcome first — which is the whole design of a one-tap disposition —
 * and the bar was gone along with anywhere to put the thought. Past notes then
 * rendered read-only and only when non-empty, so a call without one showed
 * nothing at all, and the feature looked like it did not exist.
 *
 * Always present, then, even when empty: the affordance is the answer to "where
 * do I write this down".
 */
export function CallNote({ callId, notes }: { callId: string; notes: string | null }) {
  const save = useUpdateCallNote()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(notes ?? '')

  // A note edited elsewhere — or the row re-fetched after saving — should win
  // over a stale draft, but never while it is being typed into.
  useEffect(() => {
    if (!editing) setDraft(notes ?? '')
  }, [notes, editing])

  const commit = () => {
    save.mutate({ callId, notes: draft }, { onSuccess: () => setEditing(false) })
  }

  if (!editing) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <p className="text-[10px] uppercase tracking-wider text-ink-faint">Notes</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1 text-[10px]"
            onClick={() => setEditing(true)}
          >
            <NotebookPen className="size-3" />
            {notes ? 'Edit' : 'Add a note'}
          </Button>
        </div>
        {notes ? (
          <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-dim">
            {notes}
          </p>
        ) : (
          <p className="mt-0.5 text-[11px] text-ink-faint">Nothing written down yet.</p>
        )}
      </div>
    )
  }

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-faint">Notes</p>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What happened on this call?"
        rows={3}
        autoFocus
        className="mt-1 text-[11px]"
        // Ctrl/Cmd+Enter saves, because the obvious key is taken by newlines.
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commit()
          if (event.key === 'Escape') { setDraft(notes ?? ''); setEditing(false) }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button variant="primary" size="sm" onClick={commit} disabled={save.isPending}>
          <Check />
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setDraft(notes ?? ''); setEditing(false) }}
        >
          <X />
          Cancel
        </Button>
      </div>
    </div>
  )
}
