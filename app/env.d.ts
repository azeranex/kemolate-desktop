/// <reference types="vite/client" />

import type { KemolateApi } from '../electron/preload'

declare global {
  interface Window {
    /** The preload's bridge — absent when the page is opened in a plain browser. */
    kemolate?: KemolateApi
  }
}
