import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import md5 from 'https://esm.sh/md5@2.3.0'

const MC_LIST_ID = '11bfd4e8ec'
const MC_DC      = 'us1'

async function tagInMailchimp(email: string, name: string, tag: string): Promise<boolean> {
  const apiKey = Deno.env.get('MAILCHIMP_API_KEY')
  if (!apiKey) { console.log('No MAILCHIMP_API_KEY'); return false }

  const hash    = md5(email.toLowerCase())
  const base    = `https://${MC_DC}.api.mailchimp.com/3.0/lists/${MC_LIST_ID}`
  const auth    = 'Basic ' + btoa(`anystring:${apiKey}`)
  const headers = { 'Authorization': auth, 'Content-Type': 'application/json' }

  const parts = name.trim().split(/\s+/)
  const fname = parts[0] ?? ''
  const lname = parts.slice(1).join(' ')

  const subRes = await fetch(`${base}/members/${hash}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      email_address: email,
      status_if_new: 'subscribed',
      merge_fields: { FNAME: fname, LNAME: lname },
    }),
  })
  if (!subRes.ok) { console.error('Mailchimp upsert failed:', await subRes.text()); return false }

  const tagRes = await fetch(`${base}/members/${hash}/tags`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tags: [{ name: tag, status: 'active' }] }),
  })
  if (!tagRes.ok) { console.error('Mailchimp tag failed:', await tagRes.text()); return false }

  console.log(`Mailchimp: ${email} tagged "${tag}"`)
  return true
}

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  let body: any
  try { body = await req.json() } catch { return new Response('Invalid JSON', { status: 400 }) }

  const { match_date, venue_code, tag_override } = body
  if (!match_date || !venue_code) {
    return new Response('match_date and venue_code required', { status: 400 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: signups, error } = await supabase
    .from('match_signups')
    .select('canonical_name, email, product_name')
    .eq('match_date', match_date)
    .eq('venue_code', venue_code)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
  if (!signups?.length) {
    return new Response(JSON.stringify({ ok: true, tagged: 0, skipped: 0, tag: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  // Use manual override if provided, else derive from SumUp product names, else fall back to venue_code
  const productCode = (tag_override as string)?.toUpperCase() ||
    signups
      .map((s: any) => (s.product_name as string)?.match(/^([A-Z]{2,}\d+)/i)?.[1]?.toUpperCase())
      .find(Boolean) ||
    venue_code.toUpperCase()

  let tagged = 0
  let skipped = 0
  for (const s of signups as any[]) {
    if (!s.email) { skipped++; continue }
    const ok = await tagInMailchimp(s.email, s.canonical_name, productCode)
    if (ok) tagged++; else skipped++
  }

  return new Response(
    JSON.stringify({ ok: true, tagged, skipped, tag: productCode }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
