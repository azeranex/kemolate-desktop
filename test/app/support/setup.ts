import { vi } from 'vitest'

import { fetchWithEndpoints } from './test-utils'

import { nuxtReady } from '~/composables/nuxt'

/**
 * Every app test file, set up as Nuxt's test environment set it up:
 *
 * - The app is up. Nuxt's environment mounts an app before any test runs, so
 *   `onNuxtReady` callbacks fire there; here `main.ts` never runs, and without
 *   this every `remember`ed setting would wait for a start that never comes.
 * - `fetch` answers the endpoints a test registered. They last for the file, as
 *   they do there — several tests register theirs once, at the top.
 */
nuxtReady()

vi.stubGlobal('fetch', fetchWithEndpoints)
