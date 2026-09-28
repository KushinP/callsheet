/**
 * Keeps the Supabase project out of the free plan's 7-day inactivity pause.
 *
 * Supabase counts user database queries — dashboard visits do not qualify — so
 * this makes one real RPC call a day against public.heartbeat(), which touches
 * a table and returns a bare true.
 *
 * Deliberately dumber than the alternative. A scheduled Claude task would also
 * work, but it depends on a schedule firing, an agent running, and an OAuth
 * token still being valid; when that chain breaks it breaks silently and you
 * find out because the project is already paused. This is an HTTP request that
 * either succeeds or shows up as a failed cron in Cloudflare's dashboard.
 *
 * The key here is the publishable anon key, and heartbeat() exposes nothing —
 * RLS returns an empty set to anon on every table.
 */
async function ping(env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/heartbeat`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })

  const body = await res.text()
  if (!res.ok) {
    // Throwing marks the cron run failed, which is the whole point — a silent
    // no-op would be indistinguishable from success until the project pauses.
    throw new Error(`heartbeat failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return body.trim()
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      ping(env).then(
        (r) => console.log(`heartbeat ok: ${r}`),
        (e) => { console.error(e.message); throw e },
      ),
    )
  },

  /** Same check on demand, so it can be verified without waiting for the cron. */
  async fetch(request, env) {
    try {
      const result = await ping(env)
      return new Response(`ok ${result}\n`, { status: 200 })
    } catch (e) {
      return new Response(`${e.message}\n`, { status: 502 })
    }
  },
}
