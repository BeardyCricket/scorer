import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  let body: any
  try { body = await req.json() } catch { return new Response('Invalid JSON', { status: 400 }) }

  const { name, email } = body
  if (!name || !email) return new Response('name and email required', { status: 400 })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Create Supabase Auth account (random password — player uses forgot password to set their own)
  const { error: authErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    password: crypto.randomUUID(),
  })
  if (authErr && !authErr.message.toLowerCase().includes('already registered')) {
    return new Response(JSON.stringify({ error: authErr.message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  // Create player_access entry
  const { error: dbErr } = await supabase
    .from('player_access')
    .insert({ player_name: name, email, is_active: true })
  if (dbErr && dbErr.code !== '23505') {
    return new Response(JSON.stringify({ error: dbErr.message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
