# perspectiv-website

Source for [perspectiv.net](https://perspectiv.net) — Perspectiv's marketing site, pricing page, and docs portal.

Built with [Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com), deployed as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) with static assets. A small Worker script handles the `/api/contact` form submission via [Resend](https://resend.com); everything else is static HTML.

## Local development

```bash
npm install
npm run dev
```

The dev server runs on http://localhost:4321 with hot reload.

## Build

```bash
npm run build      # outputs static site to dist/
npm run preview    # preview the built site locally
```

## Project structure

```
src/
├── layouts/
│   └── BaseLayout.astro     # Header + footer wrapper, SEO meta
├── components/
│   ├── Nav.astro            # Top navigation (with mobile menu)
│   ├── Footer.astro
│   ├── Hero.astro           # Home page hero
│   ├── PricingTable.astro   # Pricing tier cards
│   └── CTA.astro            # Reusable closing CTA section
├── pages/
│   ├── index.astro          # Home (/)
│   ├── why.astro            # Why Perspectiv (/why)
│   ├── pricing.astro        # Pricing (/pricing)
│   ├── download.astro       # Download / install (/download)
│   ├── charter.astro        # Charter program (/charter)
│   ├── contact.astro        # Talk-to-sales form (/contact)
│   └── about.astro          # About + contact (/about)
└── styles/
    └── global.css           # Tailwind base + component classes

worker/
├── index.ts                 # Cloudflare Worker — handles POST /api/contact
└── tsconfig.json            # Worker-specific TS config (Worker types, not DOM)
```

## Contact form (`/contact`)

The "Talk to sales" buttons across the site link to `/contact`, which posts to a Cloudflare Worker at `/api/contact`. The Worker validates the submission, rejects honeypot hits, and sends an email via Resend to `sales@perspectiv.net`. On success it 303-redirects back to `/contact?status=sent`; on failure to `/contact?status=error`.

### One-time setup before the form works in production

1. **Verify the sending domain in Resend.**
   - Sign up at [resend.com](https://resend.com), go to Domains → Add Domain → `perspectiv.net`.
   - Resend gives you 2-3 DNS records (SPF include, DKIM CNAMEs, optional DMARC).
   - Add them in **Cloudflare DNS** with **Proxy status = "DNS only"** (gray cloud — proxying breaks email auth).
   - Click "Verify" in Resend. Usually instant on Cloudflare-managed domains.

2. **Create a Resend API key** under API Keys → Create. Copy it (it's shown once).

3. **Set the API key as a Worker secret** (do *not* put it in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   Paste the key when prompted. The secret is encrypted at rest in Cloudflare.

4. **(Optional) Override the from/to addresses.** Defaults are set in `wrangler.jsonc` under `vars`:
   - `CONTACT_FROM_EMAIL` — the verified Resend sender. Default: `Perspectiv <noreply@perspectiv.net>`.
   - `CONTACT_TO_EMAIL` — the destination inbox. Default: `sales@perspectiv.net`.

### Local end-to-end test

```bash
# Once-off: set the secret for your local dev environment.
npx wrangler secret put RESEND_API_KEY  # or use a .dev.vars file

npm run worker:dev   # builds the site and runs wrangler dev (http://localhost:8787)
```

Then submit the form. A successful submission redirects to `/contact?status=sent` and an email lands in `sales@perspectiv.net`.

## Deployment

Pushes to `main` auto-deploy via Cloudflare's git integration (Workers Builds). Each push runs `astro build && wrangler deploy`.

Build settings (configured in the Cloudflare dashboard for the Worker):
- Build command: `npm run build` (produces `dist/`)
- Deploy command: `npx wrangler deploy` (uploads Worker + static assets per `wrangler.jsonc`)
- Node version: `20` (or later)

For an emergency hotfix from a dev box:
```bash
npm run worker:deploy
```

Required secrets (set once via `npx wrangler secret put NAME`):
- `RESEND_API_KEY` — for the contact form sender

## Editing content

Most copy lives in the page files (`src/pages/*.astro`). Component-level structural elements live in `src/components/`. Brand colors, fonts, and tokens are in `tailwind.config.mjs`.

To update pricing tiers, edit the `tiers` array in `src/components/PricingTable.astro`.

## License

The website source is Apache 2.0. The Perspectiv product itself is proprietary commercial software — see [github.com/perspectiv-net/perspectiv](https://github.com/perspectiv-net/perspectiv) for the deploy bundle and product details.
