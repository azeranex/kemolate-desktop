/**
 * What the server code carried from the web build calls without importing it —
 * Nitro's auto-imports there; installed by `installServerGlobals` here (see
 * `server/utils/errors.ts`). `useEvent` is never defined: the web build's query
 * logger (`server/database/client.ts`) asks for it inside a `try`, and its
 * absence is the "not in a request" it already handles.
 */
import type { createError as makeError } from '../utils/errors'

declare global {
  const createError: typeof makeError
  function useEvent (): { context: Record<string, any> } | undefined

  /** Vite's `import.meta.dev`, which the web build's query logger reads; undefined in the main build. */
  interface ImportMeta {
    dev?: boolean
  }
}

export {}
