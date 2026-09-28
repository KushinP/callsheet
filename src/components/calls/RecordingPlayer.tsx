import { AlertCircle, Loader2, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useRecordingUrl } from '@/hooks/useCalls'
import { errorMessage } from '@/lib/utils'

/**
 * Recordings live on Twilio behind account credentials, so the audio is
 * fetched through the recording-proxy edge function and handed to the element
 * as a blob URL — an <audio src> cannot carry an Authorization header.
 */
export function RecordingPlayer({ callId }: { callId: string }) {
  const getRecordingUrl = useRecordingUrl()
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  const load = async () => {
    setLoading(true)
    setError(null)

    try {
      const next = await getRecordingUrl(callId)
      objectUrlRef.current = next
      setUrl(next)
    } catch (err) {
      setError(errorMessage(err, 'Recording unavailable'))
    } finally {
      setLoading(false)
    }
  }

  if (error) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        <AlertCircle className="size-3.5" />
        {error}
      </span>
    )
  }

  if (url) {
    return <audio controls autoPlay src={url} className="h-8 w-full max-w-md" />
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
      {loading ? <Loader2 className="animate-spin" /> : <Play />}
      {loading ? 'Loading' : 'Play recording'}
    </Button>
  )
}
