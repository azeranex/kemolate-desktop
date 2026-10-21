import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

import { mockNuxtImports } from './test/app/support/mockNuxtImport.ts'
import { aliases, nuxtFlags, nuxtStyleImports } from './vite.config.ts'

import type { Plugin } from 'vite'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * The app's build-time flags (`nuxtFlags`), written into the code as it is
 * transformed. `define` does not do it here: Vitest runs the app's modules
 * through its server-side transform, which leaves `import.meta.client` and its
 * siblings alone — so every one read `undefined`, and the app took its *server*
 * branch in every test. `remember` never wired a setting, and a test of it
 * failed with the default; nothing said why.
 */
function flags (): Plugin {
  const values = nuxtFlags(true) as Record<string, string>

  return {
    name: 'kemolate:test-flags',
    transform (code, id) {
      if (id.includes('node_modules') || !code.includes('import.meta.')) return

      return { code: code.replace(/\bimport\.meta\.(client|server|dev)\b/g, (whole) => values[whole] ?? whole), map: null }
    },
  }
}

/**
 * The tests, laid out as in the web build: everything under `test/`, mirroring
 * the tree it covers, so a test carried across lands at the same path — with
 * one rename, `test/nuxt/` → `test/app/`, since there is no Nuxt here.
 *
 * Two projects, because the code splits in two, as it does in the web build.
 *
 * - `unit`, plain Node, for `shared/` and `server/`, which are written with
 *   explicit relative imports exactly so they run without the app's build
 *   around them.
 * - `app`, for anything reaching into `app/`, whose files lean on auto-imports
 *   and so are a `ReferenceError` outside the app's build. The web build stood
 *   a Nuxt build up for these (`@nuxt/test-utils`' `nuxt` environment); here it
 *   is the app's own Vite plugins — Vue, the auto-imports, the components —
 *   over happy-dom, which is what that environment ran on. What the tests asked
 *   of `@nuxt/test-utils/runtime` is answered by `test/app/support/`: see
 *   `mockNuxtImport.ts` for the one part that has to be a transform.
 *
 * The aliases are the app's own (`vite.config.ts`), so a test reaches its
 * subject through `~/...` and `#shared/...` as it did in the web build.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        plugins: [vue(), ...nuxtStyleImports(), mockNuxtImports(here('./app/auto-imports.d.ts')), flags()],
        resolve: {
          alias: {
            ...aliases,
            '@nuxt/test-utils/runtime': here('./test/app/support/test-utils.ts'),
            h3: here('./test/app/support/h3.ts'),
          },
        },
        test: {
          name: 'app',
          environment: 'happy-dom',
          include: ['test/app/**/*.test.ts'],
          setupFiles: ['test/app/support/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'out/coverage',

      /*
       * The code this project wrote, and only that — the web build's list, with
       * `electron/` beside `server/`. Vitest matches these with picomatch's
       * `contains`, so a pattern matches anywhere in a path: hence the
       * extensions, and the tests and their support excluded by name.
       */
      include: ['app/**/*.{ts,vue}', 'server/**/*.ts', 'shared/**/*.ts', 'electron/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        'app/components/ui/**',
        'app/utils/lib/**',
        'test/**',
        '**/*.{test,spec}.ts',
      ],

      /*
       * A floor, so coverage can only go one way — the web build's rule, measured
       * here. Each figure is a whole percent under what `pnpm test:coverage`
       * measured when it was set (2026-10-21, with the web build's app tests
       * carried across: lines 46.7%, statements 44.6%, functions 39.9%,
       * branches 33.8%). Lower than the web build's because what did not come
       * across is the cloud's tests, and what came across instead is code no
       * test of the web build reached either — the desktop's own composables
       * and pages.
       *
       * `electron/` is counted and has no floor: the main process is checked by
       * driving the built app (see CLAUDE.md), not by Vitest, and reads 0%.
       * Checked only when the whole suite runs with coverage; raise a figure
       * when an area climbs, and say so in the commit when one is lowered.
       */
      thresholds: {
        lines: 45,
        statements: 43,
        functions: 38,
        branches: 32,
        'app/composables/**': { lines: 46 },
        'app/utils/ocr/**': { lines: 50 },
        'app/utils/pdf/**': { lines: 53 },
        'app/utils/export/**': { lines: 25 },
        'shared/utils/**': { lines: 77 },
      },
    },
  },
})
