/**
 * The request an MCP tool is answering, wherever it came from — desktop only.
 *
 * A tool finds its caller through `useEvent()` (`mcpContext`), which Nitro's
 * request context answers in the web build. Here two doors lead to the same
 * tools — the loopback server (`mcp.ts`) and the window's own assistant
 * (`assistant.ts`) — and both run each call inside this one store. Two stores
 * would mean whichever file installed `useEvent` last decided which door's
 * calls could find their caller, and the other's tools would all answer
 * "not signed in".
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface McpEvent { context: Record<string, unknown> }

export const mcpEvents = new AsyncLocalStorage<McpEvent>()

// The request an MCP call arrived in, where `installServerGlobals` left none:
// how `mcpContext` finds the caller. Undefined outside a call, as before.
Object.assign(globalThis, { useEvent: () => mcpEvents.getStore() })
