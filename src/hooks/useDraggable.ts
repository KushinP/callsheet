import { useCallback, useEffect, useRef, useState } from 'react'

export interface Point { x: number; y: number }

/**
 * Drag-to-move for a fixed-position panel, with the position remembered.
 *
 * The dialer rendered a grip icon from the start but had no drag behaviour
 * behind it, so the one control that looked movable was the one that wasn't —
 * and the panel sat over the disposition bar on shorter screens with no way to
 * shift it.
 *
 * Position is stored as a top-left offset in viewport pixels. `null` means
 * "wherever CSS puts it", which keeps the default bottom-right anchor and the
 * responsive behaviour that comes with it.
 */
export function useDraggable(storageKey: string) {
  const [position, setPosition] = useState<Point | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<Point>
      return typeof parsed?.x === 'number' && typeof parsed?.y === 'number'
        ? { x: parsed.x, y: parsed.y }
        : null
    } catch {
      // Private windows and blocked site data both throw here. A forgotten
      // position is not worth failing a render over.
      return null
    }
  })

  const nodeRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  /** Keeps the panel reachable: never let it be dragged off the viewport. */
  const clamp = useCallback((p: Point): Point => {
    const el = nodeRef.current
    const w = el?.offsetWidth ?? 0
    const h = el?.offsetHeight ?? 0
    return {
      x: Math.min(Math.max(p.x, 0), Math.max(window.innerWidth - w, 0)),
      y: Math.min(Math.max(p.y, 0), Math.max(window.innerHeight - h, 0)),
    }
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    // Let buttons inside the drag handle keep working.
    if ((event.target as HTMLElement).closest('button')) return
    const el = nodeRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    setDragging(true)
    event.preventDefault()
  }, [])

  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      setPosition(clamp({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }))
    }
    const onUp = () => {
      dragRef.current = null
      setDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, clamp])

  // Persist only once the drag ends, so a drag is one write rather than one
  // per pointer event.
  useEffect(() => {
    if (dragging || !position) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(position))
    } catch { /* storage unavailable — the position simply won't be remembered */ }
  }, [dragging, position, storageKey])

  // A window that shrinks below the panel's saved position would otherwise
  // strand it off screen.
  useEffect(() => {
    const onResize = () => setPosition((p) => (p ? clamp(p) : null))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const reset = useCallback(() => {
    setPosition(null)
    try { localStorage.removeItem(storageKey) } catch { /* nothing to clean up */ }
  }, [storageKey])

  return { position, dragging, nodeRef, onPointerDown, reset }
}
