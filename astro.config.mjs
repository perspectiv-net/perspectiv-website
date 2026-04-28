import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
//
// NOTE: @astrojs/sitemap was intentionally removed at scaffold time.
// It crashed at build with "Cannot read properties of undefined
// (reading 'reduce')" — a known compatibility issue between certain
// Astro 4.x patch releases and @astrojs/sitemap 3.x where the hook
// signature changed. Sitemap generation will be added back later
// either via a fresh @astrojs/sitemap version or via a simple custom
// build step. Cloudflare Pages serves the site fine without it; the
// only impact is search-engine sitemap discovery (which can also be
// surfaced via robots.txt → manual sitemap.xml).
export default defineConfig({
  site: 'https://perspectiv.net',
  integrations: [
    tailwind({
      // Apply Tailwind to all .astro files; use src/styles/global.css
      // for any custom @layer additions.
      applyBaseStyles: false,
    }),
  ],
  // Output static HTML — Cloudflare Pages serves these directly with
  // no server runtime needed. Switch to 'server' if we ever need
  // dynamic routes (contact form submissions, etc.).
  output: 'static',
  build: {
    // Inline tiny CSS into the page rather than spawning extra HTTP
    // requests for sub-4KB stylesheets. Standard perf win.
    inlineStylesheets: 'auto',
  },
  // Image optimization — Astro processes images in src/ at build time.
  image: {
    domains: [],
  },
});
