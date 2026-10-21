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
      reportsDirectory: 'out/coverage',
    },
  },
})
