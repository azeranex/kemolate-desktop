/// <reference types="vite/client" />

import type { KemolateApi } from '../electron/preload'

declare global {
  interface Window {
    /** The preload's bridge — absent when the page is opened in a plain browser. */
    kemolate?: KemolateApi
  }

  /** Nuxt's build-time flags, defined in `vite.config.ts` — see `composables/nuxt.ts`. */
  interface ImportMeta {
    readonly client: boolean
    readonly server: boolean
    readonly dev: boolean
  }
}
