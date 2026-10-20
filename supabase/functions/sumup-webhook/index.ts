import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import md5 from 'https://esm.sh/md5@2.3.0'

// ── Month lookup ──────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
}

// ── Parse "TD010 - Friday 4th December 5:50-7pm (Esher...)" ──────────────────
function parseProductName(raw: string): { matchDate: string | null; venueCode: string | null } {
  const venueMatch = raw.match(/^([A-Z]+)\d+/i)
  const venueCode = venueMatch ? venueMatch[1].toUpperCase() : null

  const dayMatch = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i)
  const day = dayMatch ? parseInt(dayMatch[1], 10) : null

  const monthMatch = raw.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  )
  const month = monthMatch ? MONTHS[monthMatch[1].toLowerCase()] : null

  if (!day || !month) return { matchDate: null, venueCode }

  const now = new Date()
  let year = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  if (candidate.getTime() < now.getTime() - 14 * 24 * 60 * 60 * 1000) year++

  const matchDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { matchDate, venueCode }
}

// ── Mailchimp ─────────────────────────────────────────────────────────────────
const MC_LIST_ID = '11bfd4e8ec'
const MC_DC      = 'us1'

async function tagInMailchimp(email: string, name: string, tag: string): Promise<void> {
  const apiKey = Deno.env.get('MAILCHIMP_API_KEY')
  if (!apiKey) { console.log('No MAILCHIMP_API_KEY — skipping'); return }

  const hash   = md5(email.toLowerCase())
  const base   = `https://${MC_DC}.api.mailchimp.com/3.0/lists/${MC_LIST_ID}`
  const auth   = 'Basic ' + btoa(`anystring:${apiKey}`)
  const headers = { 'Authorization': auth, 'Content-Type': 'application/json' }

  const parts  = name.trim().split(/\s+/)
  const fname  = parts[0] ?? ''
  const lname  = parts.slice(1).join(' ')

  // Upsert subscriber (status_if_new keeps existing subscribers as-is)
  const subRes = await fetch(`${base}/members/${hash}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      email_address: email,
      status_if_new: 'subscribed',
      merge_fields: { FNAME: fname, LNAME: lname },
    }),
  })
  if (!subRes.ok) {
    console.error('Mailchimp upsert failed:', await subRes.text())
    return
  }

  // Apply tag
  const tagRes = await fetch(`${base}/members/${hash}/tags`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tags: [{ name: tag, status: 'active' }] }),
  })
  if (!tagRes.ok) {
    console.error('Mailchimp tag failed:', await tagRes.text())
  } else {
    console.log(`Mailchimp: ${email} tagged "${tag}"`)
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  console.log('Webhook received:', JSON.stringify(body))

  let email: string
  let rawName: string
  let productName: string
  let orderId: string

  if (body._source === 'make_email') {
    const html: string = body.html ?? ''
    const subject: string = body.subject ?? ''

    const emailMatch = html.match(/href="mailto:([^"]+)"/i)
                    || html.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/)
    email = emailMatch ? emailMatch[1].toLowerCase().trim() : ''

    const nameMatch = html.match(/\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+([^<\n\r]+)/)
    rawName = nameMatch ? nameMatch[1].trim() : ''

    const productMatch = html.match(/([A-Z]{2,}\d+\s*-\s*[A-Za-z]+ \d{1,2}(?:st|nd|rd|th) [A-Za-z]+[^<]{0,80})/)
    productName = productMatch ? productMatch[1].trim() : ''

    const orderMatch = subject.match(/#(\d+)/)
    orderId = orderMatch ? orderMatch[1] : ''
  } else {
    const status = (body.status || '').toUpperCase()
    if (status !== 'PAID' && status !== 'SUCCESSFUL') {
      console.log('Skipping non-successful status:', status)
      return new Response('Ignored', { status: 200 })
    }

    email = (
      body.personal_details?.email ??
      body.customer?.email ??
      body.buyer_email ??
      ''
    ).toLowerCase().trim()

    rawName = (
      body.personal_details
        ? `${body.personal_details.first_name ?? ''} ${body.personal_details.last_name ?? ''}`.trim()
        : (body.customer?.name ?? body.buyer_name ?? '')
    ).trim()

    const items: any[] = body.products ?? body.items ?? body.line_items ?? []
    productName = (
      items[0]?.name ??
      items[0]?.description ??
      body.description ??
      body.checkout_reference ??
      ''
    ).trim()

    orderId = String(body.id ?? body.transaction_id ?? body.checkout_id ?? '')
  }

  if (!email) {
    console.log('No email in payload — cannot process')
    return new Response('OK', { status: 200 })
  }

  const { matchDate, venueCode } = parseProductName(productName)

  if (!matchDate) {
    console.log('Could not parse match date from:', productName)
  }

  // ── Supabase ──────────────────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let canonicalName = rawName
  const { data: player } = await supabase
    .from('player_access')
    .select('player_name')
    .eq('email', email)
    .eq('is_active', true)
    .maybeSingle()

  if (player?.player_name) {
    canonicalName = player.player_name
    console.log(`Email match: ${email} → ${canonicalName}`)
  } else {
    // Auto-create Auth account (random password — they use "forgot password" to set their own)
    const { error: authErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      password: crypto.randomUUID(),
    })
    if (authErr && !authErr.message.includes('already registered')) {
      console.log(`Could not create auth account for ${email}:`, authErr.message)
    }
    // Auto-create player_access record for name → stats mapping
    const { error: insertErr } = await supabase
      .from('player_access')
      .insert({ player_name: rawName, email, is_active: true })
    if (insertErr) {
      console.log(`Could not auto-create player_access for ${email}:`, insertErr.message)
    } else {
      console.log(`Auto-created stats account: ${rawName} (${email})`)
    }
    canonicalName = rawName
  }

  const { error } = await supabase
    .from('match_signups')
    .upsert(
      {
        order_id:       orderId || null,
        match_date:     matchDate,
        venue_code:     venueCode,
        canonical_name: canonicalName,
        raw_name:       rawName,
        email,
        product_name:   productName,
      },
      { onConflict: 'order_id', ignoreDuplicates: false },
    )

  if (error) {
    console.error('Supabase insert error:', error)
    return new Response('DB error', { status: 500 })
  }

  console.log(`Signup stored: ${canonicalName} → ${matchDate} [${venueCode}]`)

  // ── Mailchimp ─────────────────────────────────────────────────────────────
  const productCode = productName.match(/^([A-Z]{2,}\d+)/i)?.[1]?.toUpperCase()
  if (productCode) {
    await tagInMailchimp(email, rawName, productCode)
  }

  return new Response('OK', { status: 200 })
})
