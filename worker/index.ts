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

    // Reject other methods on the API path so we don't accidentally
    // serve the static 404 page for a misrouted POST.
    if (url.pathname === '/api/contact') {
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
