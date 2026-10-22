/**
 * What the server code carried from the web build calls without importing it —
 * Nitro's auto-imports there; installed by `installServerGlobals` here (see
 * `server/utils/errors.ts`) and `installMcpGlobals` (`server/utils/mcpToolkit.ts`).
 * `useEvent` answers undefined outside an MCP call: the web build's query
 * logger (`server/database/client.ts`) asks for it inside a `try`, and its
 * absence is the "not in a request" it already handles; inside one it is the
 * call's request (`electron/mcp.ts`).
 */
import type { createError as makeError } from '../utils/errors'
import type { mcpJson as makeJson } from '../utils/mcp'
import type * as toolkit from '../utils/mcpToolkit'

declare global {
  const createError: typeof makeError

  /** The MCP toolkit's auto-imports, and `mcpJson` from `server/utils` — installed by `installMcpGlobals`. */
  const defineMcpTool: typeof toolkit.defineMcpTool
  const defineMcpPrompt: typeof toolkit.defineMcpPrompt
  const jsonResult: typeof toolkit.jsonResult
  const imageResult: typeof toolkit.imageResult
  const mcpJson: typeof makeJson
  function useEvent (): { context: Record<string, any> } | undefined

  /** Vite's `import.meta.dev`, which the web build's query logger reads; undefined in the main build. */
  interface ImportMeta {
    dev?: boolean
  }
}

export {}
