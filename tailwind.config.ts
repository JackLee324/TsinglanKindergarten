/**
 * Tailwind configuration.
 * =======================
 *
 * WHAT THIS WAS
 * -------------
 * `presets: [createTailwindPresetOfSimple()]` from `@lark-apaas/fullstack-presets`,
 * which contributed exactly three things, all reproduced or replaced here:
 *
 *   1. `darkMode: 'class'`            -> kept (see below).
 *   2. `content: ['node_modules/@lark-apaas/client-toolkit/lib/**\/*.js']`
 *      -> dropped: it scanned the platform package's compiled components for class
 *         names so their styles would be generated. Those components are deleted
 *         (`client/src/components/business-ui` and everything the app root used to
 *         import from the toolkit), and the built stylesheet was verified after the
 *         removal: of 86 classes that disappeared, ZERO are referenced anywhere in
 *         `client/`. The delta is dead CSS.
 *   3. an inline copy of `tailwindcss-animate` (a v3-era plugin generating
 *      `animate-in` / `fade-in-0` / `slide-in-from-*`).
 *      -> not needed: `client/src/index.css` imports `tw-animate-css`, the
 *         Tailwind-v4-native package that provides the same utilities as CSS, and it
 *         already supplied them. Verified by rebuilding and confirming those
 *         utilities are still in the output.
 *
 * `darkMode: 'class'` is kept because the vendored palette in
 * `client/src/vendor/toolkit-theme.css` still declares a `.dark` block; switching the
 * strategy here would leave those declarations unreachable.
 *
 * The `content` globs are the ONLY source of utility classes: `@import 'tailwindcss'`
 * runs with `source(none)` (see the vendored stylesheet), so automatic source
 * detection is off and this list is authoritative.
 */
export default {
  darkMode: 'class',
  content: [
    './client/index.html',
    './client/src/**/*.{ts,tsx,css}',
  ],
  plugins: [],
};
