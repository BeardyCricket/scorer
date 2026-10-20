import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Month lookup ──────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
}

// ── Parse "TD010 - Friday 4th December 5:50-7pm (Esher...)" ──────────────────
function parseProductName(raw: string): { matchDate: string | null; venueCode: string | null } {
  // Venue code = leading letters before the sequence number (TD, WM, etc.)
  const venueMatch = raw.match(/^([A-Z]+)\d+/i)
  const venueCode = venueMatch ? venueMatch[1].toUpperCase() : null

  // Day number — strip ordinal suffix
  const dayMatch = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i)
  const day = dayMatch ? parseInt(dayMatch[1], 10) : null

  // Month name
  const monthMatch = raw.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  )
  const month = monthMatch ? MONTHS[monthMatch[1].toLowerCase()] : null

  if (!day || !month) return { matchDate: null, venueCode }

  // Year inference: if the date is more than 2 weeks in the past, assume next year
  const now = new Date()
  let year = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  if (candidate.getTime() < now.getTime() - 14 * 24 * 60 * 60 * 1000) year++

  const matchDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { matchDate, venueCode }
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
    // ── Path: Make.com — parse raw email HTML here ──────────────────────────
    const html: string = body.html ?? ''
    const subject: string = body.subject ?? ''

    // Customer email — mailto link first, then plain email address pattern
    const emailMatch = html.match(/href="mailto:([^"]+)"/i)
                    || html.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/)
    email = emailMatch ? emailMatch[1].toLowerCase().trim() : ''

    // Customer name — from timestamp line e.g. "2026/10/18 21:27:07 Ankur Patel"
    const nameMatch = html.match(/\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+([^<\n\r]+)/)
    rawName = nameMatch ? nameMatch[1].trim() : ''

    // Product name — venue code pattern e.g. "WM006 - Wednesday 21st October..."
    const productMatch = html.match(/([A-Z]{2,}\d+\s*-\s*[A-Za-z]+ \d{1,2}(?:st|nd|rd|th) [A-Za-z]+[^<]{0,80})/)
    productName = productMatch ? productMatch[1].trim() : ''

    // Order ID from subject line e.g. "New order #703"
    const orderMatch = subject.match(/#(\d+)/)
    orderId = orderMatch ? orderMatch[1] : ''
  } else {
    // ── Path: SumUp webhook (future use) ────────────────────────────────────
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
    // Still store the row so we do not lose the signup — match_date will be null
  }

  // ── Supabase ──────────────────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Look up canonical player name by email
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
    console.log(`No stats account for ${email} — using name as typed: ${rawName}`)
  }

  // Upsert so retried webhooks don't create duplicate rows
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
  return new Response('OK', { status: 200 })
})
