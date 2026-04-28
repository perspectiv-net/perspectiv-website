# perspectiv-website

Source for [perspectiv.net](https://perspectiv.net) — Perspectiv's marketing site, pricing page, and docs portal.

Built with [Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com), deployed to [Cloudflare Pages](https://pages.cloudflare.com).

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
│   └── about.astro          # About + contact (/about)
└── styles/
    └── global.css           # Tailwind base + component classes
```

## Deployment

Pushes to `main` auto-deploy to Cloudflare Pages. Preview deployments are created for PR branches.

Build settings (configured in Cloudflare Pages dashboard):
- Framework preset: **Astro**
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `20` (or later)

## Editing content

Most copy lives in the page files (`src/pages/*.astro`). Component-level structural elements live in `src/components/`. Brand colors, fonts, and tokens are in `tailwind.config.mjs`.

To update pricing tiers, edit the `tiers` array in `src/components/PricingTable.astro`.

## License

The website source is Apache 2.0. The Perspectiv product itself is proprietary commercial software — see [github.com/perspectiv-net/perspectiv](https://github.com/perspectiv-net/perspectiv) for the deploy bundle and product details.
