import { FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Select } from '@/components/ui/select'
import { useScripts, useSetSessionScript } from '@/hooks/useScripts'

/** Sentinel for "no explicit script — fall back to the workspace default". */
const INHERIT = '__default__'

/**
 * Attaches a script to a session.
 *
 * This exists because `calling_sessions.script_id` had no way to be set: the
 * column and its hook were written, but nothing in the UI called them, so the
 * prompter could only ever show whichever script happened to be the workspace
 * default — and silently showed nothing when none was.
 */
export function ScriptPicker({
  sessionId,
  scriptId,
}: {
  sessionId: string
  scriptId: string | null | undefined
}) {
  const scripts = useScripts()
  const setSessionScript = useSetSessionScript()

  const available = scripts.data ?? []
  const defaultScript = available.find((s) => s.is_default)
  // Pinned to something other than the current default: a new default will not
  // reach this session. That was invisible, which is how a pending session kept
  // serving v6 forty minutes after the default moved to v8.
  const pinnedOffDefault = Boolean(
    scriptId && !available.find((s) => s.id === scriptId)?.is_default,
  )
  if (available.length === 0) {
    return (
      <p className="text-[11px] text-ink-faint">
        No scripts yet.{' '}
        <Link to="/scripts" className="text-accent hover:underline">
          Write one
        </Link>{' '}
        and it will appear here.
      </p>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <FileText className="size-3.5 shrink-0 text-ink-faint" />
      <Select
        value={scriptId ?? INHERIT}
        onValueChange={(value) =>
          setSessionScript.mutate({
            sessionId,
            scriptId: value === INHERIT ? null : value,
          })
        }
        options={[
          {
            value: INHERIT,
            label: defaultScript ? `Workspace default — ${defaultScript.name}` : 'Workspace default',
          },
          ...available.map((s) => ({
            value: s.id,
            label: s.is_default ? `${s.name} (default)` : s.name,
          })),
        ]}
      />
      {pinnedOffDefault && (
        <span
          className="shrink-0 text-[10px] text-warn"
          title="Pinned to this script — a new workspace default will not reach this session."
        >
          pinned
        </span>
      )}
    </div>
  )
}
