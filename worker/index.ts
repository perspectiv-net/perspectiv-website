/**
 * Perspectiv website Worker.
 *
 * Two responsibilities:
 *   1. POST /api/contact  → validate form, send email via Resend, redirect.
 *   2. Everything else    → fall through to static assets (Astro build output).
 *
 * Configuration (set via `wrangler secret put` for secrets, [vars] in wrangler.jsonc for the rest):
 *   RESEND_API_KEY      (secret) — Resend API key, e.g. re_xxxxx
 *   CONTACT_FROM_EMAIL  (var)    — verified sender. Default: "Perspectiv Sales <sales@perspectiv.net>"
 *   CONTACT_TO_EMAIL    (var)    — destination inbox. Default: "sales@perspectiv.net"
 *
 * The form posts URL-encoded data (no JS dependency) and we redirect on
 * success/error so the user gets a normal browser navigation back to
 * /contact?status=sent or /contact?status=error.
 */

interface Env {
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  CONTACT_FROM_EMAIL?: string;
  CONTACT_TO_EMAIL?: string;

  // Cloudflare Turnstile secret key. Set with:
  //   wrangler secret put TURNSTILE_SECRET_KEY
  // Matching site key is in the contact.astro template.
  TURNSTILE_SECRET_KEY?: string;

  // Rate limiter binding configured in wrangler.jsonc. Limits contact
  // form submissions per source IP. May be undefined if the binding
  // isn't configured — the handler falls through gracefully in that case
  // so deploys don't break before the binding is set up.
  CONTACT_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };

  // Stripe — for /api/checkout-session and /api/stripe-webhook.
  //   STRIPE_SECRET_KEY        — restricted key (rk_test_... / rk_live_...) with
  //                              "Recurring subscriptions and billing" template
  //   STRIPE_WEBHOOK_SECRET    — whsec_... from Stripe Dashboard → Developers
  //                              → Webhooks → endpoint detail page
  // Set both via wrangler secret put.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;

  // Bearer token for the license-mint service at mint.perspectiv.net.
  // Mirrors /etc/perspectiv-mint/auth_token on the DigitalOcean droplet.
  // Rotate by generating a new token there + updating this secret.
  MINT_AUTH_TOKEN?: string;
}

const TOPIC_LABELS: Record<string, string> = {
  general: 'General inquiry',
  scale:   'Scale tier pricing',
  partner: 'Charter Program (design partner)',
  support: 'Support / installation help',
  other:   'Other',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env);
    }
    if (url.pathname === '/api/checkout-session' && request.method === 'POST') {
      return handleCheckoutSession(request, env);
    }
    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    // Reject other methods on API paths so we don't accidentally
    // serve the static 404 page for a misrouted POST.
    if (url.pathname === '/api/contact'
        || url.pathname === '/api/checkout-session'
        || url.pathname === '/api/stripe-webhook') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { 'Allow': 'POST' },
      });
    }

    // Fall through to Astro's static build for every other route.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;


async function handleContact(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const success = Response.redirect(`${origin}/contact?status=sent`, 303);
  const failure = Response.redirect(`${origin}/contact?status=error`, 303);

  // Form posts as application/x-www-form-urlencoded.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failure;
  }

  const get = (k: string) => (form.get(k)?.toString() ?? '').trim();

  // Honeypot: humans don't see the "website" field; bots fill it.
  // We pretend success so the bot doesn't retry, but send nothing.
  // Kept as defense-in-depth even with Turnstile in place — catches
  // the laziest bots without consuming a Turnstile API call.
  if (get('website') !== '') {
    return success;
  }

  // ── Cloudflare Turnstile verification ─────────────────────────────────────
  // Validates the cf-turnstile-response token the widget posted. If the
  // secret isn't configured (early dev / pre-Turnstile-setup), we skip
  // the check and log a warning — better than blocking deploys before
  // the secret is in place. Once TURNSTILE_SECRET_KEY is set, every
  // submission goes through the check.
  if (env.TURNSTILE_SECRET_KEY) {
    const tsToken = get('cf-turnstile-response');
    if (!tsToken) {
      console.warn('Turnstile token missing from form submission');
      return failure;
    }
    const tsBody = new FormData();
    tsBody.append('secret', env.TURNSTILE_SECRET_KEY);
    tsBody.append('response', tsToken);
    // Pass the client IP through so Turnstile can factor it into the
    // fraud score. CF-Connecting-IP is set automatically by Cloudflare.
    const clientIP = request.headers.get('CF-Connecting-IP');
    if (clientIP) tsBody.append('remoteip', clientIP);

    try {
      const tsRes = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        { method: 'POST', body: tsBody },
      );
      const tsJson = await tsRes.json() as { success: boolean; 'error-codes'?: string[] };
      if (!tsJson.success) {
        console.warn('Turnstile rejected submission', { errors: tsJson['error-codes'] });
        return failure;
      }
    } catch (err) {
      // If Turnstile itself is down, don't fail closed against legitimate
      // users — log and let the submission through. The honeypot + rate
      // limit + gibberish heuristic are still active as fallbacks.
      console.error('Turnstile verify threw, allowing through', err);
    }
  } else {
    console.warn('TURNSTILE_SECRET_KEY not configured — bot protection limited to honeypot');
  }

  // ── Rate limit by client IP ───────────────────────────────────────────────
  // Cloudflare Workers' rate-limiting binding. Configured in wrangler.jsonc
  // (see CONTACT_RATE_LIMITER). Falls through if the binding isn't set up
  // yet so deploys aren't gated on it. Typical config: 3 submissions per
  // 60 seconds per source IP.
  if (env.CONTACT_RATE_LIMITER) {
    const clientIP = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    try {
      const { success: rlOk } = await env.CONTACT_RATE_LIMITER.limit({ key: clientIP });
      if (!rlOk) {
        console.warn('Rate limit hit for', clientIP);
        // Quiet rejection — return success so an attacker can't probe the
        // limit. Real users very rarely hit this on legitimate traffic.
        return success;
      }
    } catch (err) {
      console.error('Rate limiter threw, allowing through', err);
    }
  }

  const name     = get('name');
  const company  = get('company');
  const email    = get('email');
  const phone    = get('phone');
  const topicKey = get('topic');
  const devices  = get('devices');
  const message  = get('message');

  // Required fields + length sanity (defense in depth — the form already enforces these).
  if (!name || !company || !email || !topicKey || !message) return failure;
  if (name.length > 200 || company.length > 200 || email.length > 320) return failure;
  if (message.length < 10 || message.length > 5000) return failure;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failure;

  // ── Gibberish heuristic ───────────────────────────────────────────────────
  // Belt-and-suspenders against bots that solve Turnstile (rare but
  // possible). Two cheap checks tuned to the failure modes already seen
  // in the wild:
  //
  //   1. Very short message with no real word structure — e.g.
  //      "asdfghjklqwertyuiop" (no spaces, looks like keyboard mash).
  //   2. Long message with abnormally low vowel density — random
  //      alphanumeric noise typically has < 25% vowels in the letter
  //      population, while English text averages 38–42%.
  //
  // Thresholds are deliberately loose. Real customers writing "Hi please
  // call me about pricing" still pass. The May 2026 spam ("YyErjcwdkdjwjjwj...")
  // fails on vowel density.
  if (message.length < 25 && message.split(/\s+/).filter((w) => w.length >= 2).length < 3) {
    console.warn('Gibberish heuristic: too short with no word structure');
    return success;  // quiet drop; bots don't see a difference
  }
  const letters = message.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 50) {
    const vowels = (letters.match(/[aeiouAEIOU]/g) ?? []).length;
    const vowelRatio = vowels / letters.length;
    if (vowelRatio < 0.25) {
      console.warn('Gibberish heuristic: vowel ratio', vowelRatio.toFixed(2));
      return success;  // quiet drop
    }
  }

  const topicLabel = TOPIC_LABELS[topicKey] ?? 'General inquiry';
  const subject    = `[Perspectiv] ${topicLabel} — ${company}`;

  const text = [
    `New message from the perspectiv.net contact form.`,
    ``,
    `Topic:    ${topicLabel}`,
    `Name:     ${name}`,
    `Company:  ${company}`,
    `Email:    ${email}`,
    phone   ? `Phone:    ${phone}`   : null,
    devices ? `Devices:  ${devices}` : null,
    ``,
    `Message:`,
    message,
  ].filter((l) => l !== null).join('\n');

  const html = `
    <h2 style="margin:0 0 12px;font-family:system-ui,sans-serif">New contact form submission</h2>
    <table style="font-family:system-ui,sans-serif;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Topic</td><td>${esc(topicLabel)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Name</td><td>${esc(name)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Company</td><td>${esc(company)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Email</td><td>${esc(email)}</td></tr>
      ${phone   ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Phone</td><td>${esc(phone)}</td></tr>`     : ''}
      ${devices ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Devices</td><td>${esc(devices)}</td></tr>` : ''}
    </table>
    <h3 style="margin:20px 0 8px;font-family:system-ui,sans-serif">Message</h3>
    <pre style="font-family:system-ui,sans-serif;font-size:14px;white-space:pre-wrap;margin:0">${esc(message)}</pre>
  `;

  // Send via Resend. Reply-To set to the customer so a Gmail "Reply" goes to them.
  const resendBody = {
    from:     env.CONTACT_FROM_EMAIL ?? 'Perspectiv Sales <sales@perspectiv.net>',
    to:       [env.CONTACT_TO_EMAIL  ?? 'sales@perspectiv.net'],
    reply_to: email,
    subject,
    text,
    html,
  };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(resendBody),
    });

    if (!res.ok) {
      // Resend returns JSON error details. Log to wrangler tail for triage.
      const errBody = await res.text();
      console.error('Resend send failed', { status: res.status, body: errBody });
      return failure;
    }
  } catch (err) {
    console.error('Resend request threw', err);
    return failure;
  }

  return success;
}

// Minimal HTML escape — the email body is a controlled template, but the
// field values come from the user, so escape them before interpolating.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


// ─────────────────────────────────────────────────────────────────────────────
// Stripe Checkout Session creation
//
// Called by the /pricing page's JS when a customer clicks Buy on a tier.
// Body: { price_id, instance_id, customer_email? }
//   - price_id is the Stripe Price ID (price_test_... in sandbox)
//   - instance_id is the customer's Perspectiv install UUID, copied from
//     Settings → License → Instance ID. This becomes session.metadata.instance_id
//     so the webhook handler can mint a license bound to the right install.
// Response: { url, session_id }  — JS redirects browser to `url`
// ─────────────────────────────────────────────────────────────────────────────

async function handleCheckoutSession(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY not configured');
    return jsonResponse({ error: 'Server misconfiguration' }, 500);
  }

  let body: { price_id?: unknown; instance_id?: unknown; customer_email?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const priceId      = typeof body.price_id      === 'string' ? body.price_id      : '';
  const instanceId   = typeof body.instance_id   === 'string' ? body.instance_id   : '';
  const customerEmail = typeof body.customer_email === 'string' ? body.customer_email : '';

  if (!priceId.startsWith('price_')) {
    return jsonResponse({ error: 'Invalid price_id' }, 400);
  }
  // Validate instance_id is a UUID (matches Perspectiv's Instance ID format)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) {
    return jsonResponse({
      error: 'Invalid instance_id — must be a UUID. Find yours at Settings → License in your Perspectiv install.',
    }, 400);
  }

  // Build the URL-encoded body Stripe's API expects
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', 'https://perspectiv.net/checkout/success?session_id={CHECKOUT_SESSION_ID}');
  params.append('cancel_url',  'https://perspectiv.net/pricing?status=cancelled');
  params.append('metadata[instance_id]', instanceId);
  if (customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    params.append('customer_email', customerEmail);
  }
  // Allow customers to enter a promotion code at checkout (annual discount, etc.)
  params.append('allow_promotion_codes', 'true');
  // Collect billing address — useful for tax/invoicing later
  params.append('billing_address_collection', 'required');

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('Stripe checkout session error', { status: res.status, body: errText });
      return jsonResponse({ error: 'Stripe API error' }, 502);
    }
    const session = await res.json() as { id: string; url: string };
    return jsonResponse({ url: session.url, session_id: session.id }, 200);
  } catch (err) {
    console.error('Stripe checkout session threw', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook receiver
//
// Stripe POSTs events to /api/stripe-webhook. We verify the signature,
// then for checkout.session.completed:
//   1. Pull session.metadata.instance_id and customer_email out of the event
//   2. Fetch line items with expand=['data.price.product'] to get the
//      tier and device_cap from product metadata, term_days from price metadata
//   3. Call mint.perspectiv.net/mint to issue a signed license key
//   4. Email the key to the customer via Resend
//
// All other event types: 200 OK, no action. Stripe interprets non-2xx
// as "retry" so we want to return 200 even when we ignore an event.
// 5xx is reserved for genuine "please retry" scenarios (mint service down etc.).
// ─────────────────────────────────────────────────────────────────────────────

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY ||
      !env.MINT_AUTH_TOKEN || !env.RESEND_API_KEY) {
    console.error('Stripe webhook handler missing required secrets');
    return new Response('Server misconfiguration', { status: 500 });
  }

  // Read raw body BEFORE parsing — signature verification needs the
  // exact bytes Stripe sent. Once we await text() we can't read formData()
  // or json() from the same request, so we parse JSON ourselves below.
  const rawBody  = await request.text();
  const sigHdr   = request.headers.get('Stripe-Signature') ?? '';
  const isValid  = await verifyStripeWebhook(rawBody, sigHdr, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    console.warn('Stripe webhook: invalid signature — rejecting');
    return new Response('Invalid signature', { status: 400 });
  }

  let event: { type?: string; data?: { object?: any } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Acknowledge non-target events with 200 so Stripe doesn't retry
  if (event.type !== 'checkout.session.completed') {
    return new Response('OK', { status: 200 });
  }

  const session       = event.data?.object;
  const sessionId     = session?.id;
  const instanceId    = session?.metadata?.instance_id;
  const customerEmail = session?.customer_email
                     ?? session?.customer_details?.email
                     ?? '';

  if (!sessionId)    { console.error('Webhook: missing session id');                  return new Response('OK', { status: 200 }); }
  if (!instanceId)   { console.error('Webhook: missing instance_id metadata', { sessionId }); return new Response('OK', { status: 200 }); }
  if (!customerEmail) { console.error('Webhook: missing customer_email', { sessionId });      return new Response('OK', { status: 200 }); }

  // Fetch line items with product+price expansion — that's where tier,
  // device_cap, and term_days live (in product/price metadata, not on
  // the session itself)
  let tier: string;
  let deviceCap: number;
  let termDays: number;
  try {
    const liUrl = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?expand[]=data.price.product`;
    const liRes = await fetch(liUrl, {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!liRes.ok) {
      throw new Error(`line items API ${liRes.status}: ${await liRes.text()}`);
    }
    const liData = await liRes.json() as { data?: Array<{ price?: any }> };
    const item    = liData.data?.[0];
    const product = item?.price?.product;
    const price   = item?.price;
    if (!product?.metadata?.tier)        throw new Error('product missing tier metadata');
    if (!product.metadata.device_cap)    throw new Error('product missing device_cap metadata');
    if (!price?.metadata?.term_days)     throw new Error('price missing term_days metadata');
    tier      = String(product.metadata.tier).toUpperCase();
    deviceCap = parseInt(product.metadata.device_cap, 10);
    termDays  = parseInt(price.metadata.term_days,    10);
    if (!Number.isFinite(deviceCap) || !Number.isFinite(termDays)) {
      throw new Error('device_cap or term_days metadata not a number');
    }
  } catch (err) {
    console.error('Webhook: failed to extract product/price metadata', err);
    // 500 → Stripe will retry, giving us time to fix metadata
    return new Response('Metadata extraction failed', { status: 500 });
  }

  // Call the mint service over the Cloudflare Tunnel
  let licenseKey:  string;
  let expiresAt:   string;
  try {
    const mintRes = await fetch('https://mint.perspectiv.net/mint', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.MINT_AUTH_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        tier,
        device_cap:  deviceCap,
        instance_id: instanceId,
        term_days:   termDays,
      }),
    });
    if (!mintRes.ok) {
      throw new Error(`mint service ${mintRes.status}: ${await mintRes.text()}`);
    }
    const mintData = await mintRes.json() as { license_key: string; expires_at: string };
    licenseKey = mintData.license_key;
    expiresAt  = mintData.expires_at;
  } catch (err) {
    console.error('Webhook: mint service call failed', err);
    return new Response('Mint failure', { status: 500 });  // Stripe will retry
  }

  // Send the license key to the customer via Resend
  try {
    const tierLabel = tier.charAt(0) + tier.slice(1).toLowerCase();
    const subject   = `Your Perspectiv ${tierLabel} license key`;
    const htmlBody  = renderLicenseEmail(tierLabel, deviceCap, termDays, licenseKey, expiresAt);
    const textBody  = renderLicenseEmailText(tierLabel, deviceCap, termDays, licenseKey, expiresAt);
    const resendRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    env.CONTACT_FROM_EMAIL ?? 'Perspectiv Sales <sales@perspectiv.net>',
        to:      [customerEmail],
        subject,
        html:    htmlBody,
        text:    textBody,
      }),
    });
    if (!resendRes.ok) {
      // License IS minted — don't 500 (Stripe retry would mint a second key).
      // Log loudly so operator can manually email the key.
      console.error('Webhook: Resend email failed AFTER mint', {
        status: resendRes.status, body: await resendRes.text(),
        customer: customerEmail, instanceId, key_prefix: licenseKey.slice(0, 24),
      });
    }
  } catch (err) {
    console.error('Webhook: Resend threw AFTER mint', err, {
      customer: customerEmail, instanceId, key_prefix: licenseKey.slice(0, 24),
    });
  }

  return new Response('OK', { status: 200 });
}


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Verify a Stripe webhook signature. Implements the same algorithm as
 * stripe.webhooks.constructEvent in the Node SDK, but without pulling in
 * the SDK (which has dependencies that don't run cleanly in a Worker).
 *
 * Stripe's signature header format:
 *   Stripe-Signature: t=<timestamp>,v1=<sig>,v1=<sig>...
 *
 * The signed payload is `${timestamp}.${rawBody}`. We compute HMAC-SHA256
 * over that with the webhook signing secret and verify any v1 entry matches.
 */
async function verifyStripeWebhook(
  payload:         string,
  signatureHeader: string,
  secret:          string,
  toleranceSeconds: number = 300,
): Promise<boolean> {
  if (!signatureHeader) return false;

  let timestamp = '';
  const v1Sigs: string[] = [];
  for (const part of signatureHeader.split(',').map((p) => p.trim())) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === 't')        timestamp = v;
    else if (k === 'v1')  v1Sigs.push(v);
  }
  if (!timestamp || v1Sigs.length === 0) return false;

  // Replay protection — reject if too old or absurdly future
  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceSeconds) {
    return false;
  }

  // Compute HMAC-SHA256 over `${timestamp}.${payload}` with the secret
  const enc           = new TextEncoder();
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected  = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  // Match any v1 — Stripe rotates secrets occasionally and may send both
  // old + new during the rotation window. Constant-time compare each.
  return v1Sigs.some((sig) => constantTimeCompare(sig, expected));
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function renderLicenseEmail(
  tierLabel:  string,
  deviceCap:  number,
  termDays:   number,
  licenseKey: string,
  expiresAt:  string,
): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 16px">Welcome to Perspectiv ${esc(tierLabel)}</h2>
  <p style="line-height:1.6">Thanks for subscribing. Your license key is below — paste it into <strong>Settings &rarr; License &rarr; Activate</strong> in your Perspectiv install.</p>
  <pre style="background:#f1f5f9;padding:16px;border-radius:8px;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;margin:16px 0">${esc(licenseKey)}</pre>
  <h3 style="margin:24px 0 8px;font-size:16px">Plan details</h3>
  <ul style="line-height:1.6;padding-left:20px">
    <li>Tier: <strong>${esc(tierLabel)}</strong></li>
    <li>Device cap: <strong>${deviceCap}</strong> fully-monitored devices (unlimited ICMP-only)</li>
    <li>Term: <strong>${termDays}</strong> days</li>
    <li>Expires: <strong>${esc(expiresAt.slice(0, 10))}</strong></li>
  </ul>
  <p style="line-height:1.6;margin-top:24px">If activation fails or you have questions, just reply — we read every message personally.</p>
  <p style="color:#64748b;font-size:12px;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">Perspectiv — every feature, every tier.</p>
</body></html>`;
}

function renderLicenseEmailText(
  tierLabel:  string,
  deviceCap:  number,
  termDays:   number,
  licenseKey: string,
  expiresAt:  string,
): string {
  return [
    `Welcome to Perspectiv ${tierLabel}`,
    ``,
    `Thanks for subscribing. Paste the license key below into`,
    `Settings → License → Activate in your Perspectiv install.`,
    ``,
    licenseKey,
    ``,
    `Plan details`,
    `  Tier:       ${tierLabel}`,
    `  Device cap: ${deviceCap} fully-monitored (unlimited ICMP-only)`,
    `  Term:       ${termDays} days`,
    `  Expires:    ${expiresAt.slice(0, 10)}`,
    ``,
    `If activation fails or you have questions, reply to this email.`,
    `— Perspectiv`,
  ].join('\n');
}
