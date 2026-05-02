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
  if (get('website') !== '') {
    return success;
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
