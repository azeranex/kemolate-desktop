/**
 * What the MCP tools carried from the web build call without importing them —
 * desktop.
 *
 * In the web build `@nuxtjs/mcp-toolkit` auto-imports `defineMcpTool`,
 * `defineMcpPrompt`, `jsonResult` and `imageResult` into every server file, and
 * Nitro auto-imports `server/utils`, which is how a tool calls `mcpJson` bare.
 * Here they are made global once, at start, as `createError` is
 * (`installServerGlobals` in `./errors`) — by the main process before it loads a
 * tool (a test of one stands in what it needs) — so the tool files stay verbatim.
 *
 * The definitions are the toolkit's shape, only as much of it as the tools use,
 * and `electron/mcp.ts` registers them with the SDK the toolkit wraps.
 */
import { mcpJson } from './mcp'

import type { ZodRawShape } from 'zod'

/** A tool's answer, as the SDK takes it. */
export interface McpToolResult {
  [key: string]: unknown
  content: (
    | { type: 'text', text: string }
    | { type: 'image', data: string, mimeType: string }
  )[]
  isError?: boolean
}

interface McpEvent {
  context: Record<string, unknown>
}

export interface McpToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  /** Whether the tool is offered to this caller at all — see `mcpEnabled`. */
  enabled?: (event: McpEvent) => boolean
  inputSchema?: Shape
  handler: (input: { [K in keyof Shape]: import('zod').infer<Shape[K]> }) => Promise<McpToolResult> | McpToolResult
}

export interface McpPromptDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string
  title?: string
  description: string
  enabled?: (event: McpEvent) => boolean
  inputSchema?: Shape
  /** The prompt's text, as one user message. */
  handler: (input: { [K in keyof Shape]: import('zod').infer<Shape[K]> }) => string | Promise<string>
}

export function defineMcpTool<Shape extends ZodRawShape> (definition: McpToolDefinition<Shape>): McpToolDefinition<Shape> {
  return definition
}

export function defineMcpPrompt<Shape extends ZodRawShape> (definition: McpPromptDefinition<Shape>): McpPromptDefinition<Shape> {
  return definition
}

/** The toolkit's, with its default kept: pretty unless told otherwise. */
export function jsonResult (data: unknown, pretty = true): McpToolResult {
  return { content: [{ type: 'text', text: pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data) }] }
}

export function imageResult (data: string, mimeType: string): McpToolResult {
  return { content: [{ type: 'image', data, mimeType }] }
}

/** Called once, before any tool is loaded. */
export function installMcpGlobals () {
  Object.assign(globalThis, { defineMcpTool, defineMcpPrompt, jsonResult, imageResult, mcpJson })
}
