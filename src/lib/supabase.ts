import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Surfaces a missing .env.local immediately instead of letting every query
 * fail with an opaque network error.
 */
export const isSupabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient(
  url ?? 'http://localhost:54321',
  anonKey ?? 'missing-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
)

export const functionsUrl = `${url ?? ''}/functions/v1`

/** Call an edge function with the current user's access token attached. */
export async function callFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body })

  if (error) {
    // Edge functions return { error: "..." }; surface that rather than the
    // generic "Edge Function returned a non-2xx status code".
    let detail: string | null = null
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      try {
        const payload = await context.json() as { error?: string }
        detail = payload?.error ?? null
      } catch { /* body was not JSON */ }
    }
    throw new Error(detail ?? error.message)
  }

  return data as T
}
