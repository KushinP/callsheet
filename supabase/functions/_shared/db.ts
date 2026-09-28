import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

declare const Deno: { env: { get(key: string): string | undefined } }

export function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

/** Bypasses RLS. Only ever used for work the caller has already been authorized for. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Acts as the caller, so RLS and triggers see exactly what a browser request would. */
export function userClient(req: Request): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Public base URL of this project's edge functions. */
export function functionsBaseUrl(): string {
  return `${env('SUPABASE_URL')}/functions/v1`
}

export interface TwilioConfig {
  workspaceId: string
  accountSid: string
  authToken: string
  apiKeySid: string | null
  apiKeySecret: string | null
  twimlAppSid: string | null
  phoneNumber: string | null
}

/** Join the readable settings row with the service-role-only secrets row. */
export async function loadTwilioConfig(
  db: SupabaseClient,
  workspaceId: string,
): Promise<TwilioConfig | null> {
  const [{ data: settings }, { data: secrets }] = await Promise.all([
    db.from('workspace_twilio_settings').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    db.from('workspace_twilio_secrets').select('*').eq('workspace_id', workspaceId).maybeSingle(),
  ])

  if (!settings?.account_sid || !secrets?.auth_token) return null

  return {
    workspaceId,
    accountSid: settings.account_sid,
    authToken: secrets.auth_token,
    apiKeySid: settings.api_key_sid ?? null,
    apiKeySecret: secrets.api_key_secret ?? null,
    twimlAppSid: settings.twiml_app_sid ?? null,
    phoneNumber: settings.phone_number ?? null,
  }
}

/**
 * Resolve the caller from their Authorization header and confirm they belong
 * to the workspace they are asking about.
 */
export async function requireMember(
  req: Request,
  workspaceId: string,
  opts: { adminOnly?: boolean } = {},
): Promise<{ userId: string; role: string }> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw new HttpError('Missing Authorization header', 401)

  const anon = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: userData, error: userError } = await anon.auth.getUser()
  if (userError || !userData.user) throw new HttpError('Invalid session', 401)

  const db = serviceClient()
  const { data: membership } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userData.user.id)
    .maybeSingle()

  if (!membership) throw new HttpError('Not a member of this workspace', 403)
  if (opts.adminOnly && !['owner', 'admin'].includes(membership.role)) {
    throw new HttpError('Requires workspace admin', 403)
  }

  return { userId: userData.user.id, role: membership.role }
}

export class HttpError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}
