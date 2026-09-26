import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client build.
 * =================
 *
 * This used to be `defineConfig` from `@lark-apaas/coding-preset-vite-react`, a
 * 24-plugin preset that did far more than build: it injected the platform's page
 * title (`<title>{{appName}}</title>`, which the server then failed to fill in, so
 * the product shipped as 「妙搭应用」), a `window.__BASENAME__ = "/app/"` bootstrap that
 * forced the router's basename and made `GET /` render nothing, an OG-meta/favicon
 * HBS block, four external ByteDance scripts (Slardar error reporting, Tea analytics,
 * a performance SDK), a Google-Fonts mirror rewrite, an on-demand core-js polyfill,
 * a `routes.json` emitter, an inspector overlay, and a dev proxy.
 *
 * It is replaced by plain Vite. What is kept, and why, is below — every kept setting
 * is one the produced artefact actually depends on:
 *
 *   * `root` stays the repository root, and the entry document is
 *     `client/index.html`, because `server/main.ts` resolves the built HTML as
 *     `<cwd>/dist/client/index.html` (cwd is `dist/` at runtime) and
 *     `scripts/build.sh` publishes it there.
 *   * `publicDir = client/public` — favicon.svg and not-found.svg are copied from
 *     there; without it the 404 page and the tab icon 404.
 *   * `outDir = dist/client` and `emptyOutDir = false`: the repository's
 *     `scripts/build.sh` owns `dist/` (it does `rm -rf dist` itself, then adds the
 *     server build and the view tree). Letting Vite empty a directory the build
 *     script also writes would race with the parallel server build.
 *   * `assetsDir = 'bundle'` — kept from the platform-era workaround, but now for a
 *     mundane reason: `scripts/build.sh` and the deployment documentation refer to
 *     `dist/client/bundle`, and nothing is gained by renaming it.
 *   * `sourcemap: 'hidden'`, `minify: true`, `cssTarget` — same artefact shape as
 *     before (`hidden` keeps the maps for error reporting without a
 *     `sourceMappingURL` comment).
 *   * `server.proxy['/api']` in dev: `scripts/dev.sh` runs the Nest server and this
 *     dev server side by side and expects one origin (the session and CSRF cookies
 *     are `Secure`/`SameSite=None`, so the browser needs a single origin). Without
 *     the proxy, `npm run dev` would serve a UI whose every API call 404s.
 *
 * Tailwind is NOT a Vite plugin here on purpose: the repository already carries
 * `postcss.config.js` with `@tailwindcss/postcss`, which Vite picks up automatically.
 * Adding `@tailwindcss/vite` as well would process the same stylesheet twice.
 */
export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, 'client/public'),
  plugins: [react()],
  resolve: {
    alias: [
      // Longest prefixes first: `@shared/...` and `@client/...` must not be swallowed
      // by the `@` alias. (`@` alone only matches `@` and `@/`, but the order makes
      // that explicit rather than accidental.)
      { find: '@shared', replacement: path.resolve(__dirname, 'shared') },
      { find: '@client', replacement: path.resolve(__dirname, 'client') },
      { find: '@', replacement: path.resolve(__dirname, 'client/src') },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: false,
    assetsDir: 'bundle',
    sourcemap: 'hidden',
    minify: true,
    cssTarget: ['ios12', 'safari12', 'chrome80'],
    rollupOptions: {
      input: path.resolve(__dirname, 'client/index.html'),
    },
  },
  server: {
    port: Number(process.env.CLIENT_DEV_PORT) || 8080,
    host: process.env.CLIENT_DEV_HOST || 'localhost',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number(process.env.SERVER_PORT) || 3000}`,
        changeOrigin: false,
      },
    },
  },
});
