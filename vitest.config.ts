import { defineConfig } from 'vitest/config'

import { aliases } from './vite.config.ts'

/**
 * The tests, laid out as in the web build: everything under `test/`, mirroring
 * the tree it covers, so a test carried across lands at the same path.
 *
 * One project so far — `unit`, plain Node — because only `shared/` has come
 * across, and `shared/` is written with explicit relative imports exactly so it
 * can run without the app's build around it. The web build's second project
 * (`test/nuxt/`, for anything reaching into `app/`) returns as an `app` project
 * here, on Vite with the same auto-imports as the app, when the first of those
 * tests is migrated.
 *
 * The aliases are the app's own (`vite.config.ts`), so a test reaches its
 * subject through `#shared/...` as it did in the web build, rather than by
 * counting `../`s out of `test/unit/`.
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
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'out/coverage',
    },
  },
})
