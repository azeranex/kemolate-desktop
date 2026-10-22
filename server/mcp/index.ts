/**
 * The MCP server: its tools, its prompt, and what every client is told first —
 * desktop.
 *
 * In the web build `@nuxtjs/mcp-toolkit` finds the files under `tools/` and
 * `prompts/` by itself, and `mcp.instructions` in `nuxt.config.ts` is the
 * briefing; the handler there (this file's path) resolves the token. Here the
 * listing is by hand, the briefing is `instructions.ts`, and there is no
 * token — who may come in is settled before a request reaches this file
 * (`electron/mcp.ts`, which says why). The tool and prompt files are the web build's, verbatim but for
 * `list_workspaces` — a tool added there is a file copied to the same path
 * here and a line added below — and `get_active_workspace`, which is the
 * desktop's own (see `defaulted`).
 *
 * `serverFor` builds one per request, which is the toolkit's stateless mode
 * and the web build's choice (`sessions` off): every tool is a question
 * answered in one request, and nothing here pushes.
 *
 * Imported only once the globals are installed (`installMcpGlobals`), since a
 * tool calls `defineMcpTool` as it loads, and once the database is open, since
 * the tools reach the services.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { INSTRUCTIONS } from './instructions'
import translateChapter from './prompts/translate-chapter'
import correctBlocks from './tools/correct-blocks'
import getActiveWorkspace from './tools/get-active-workspace'
import getCast from './tools/get-cast'
import getGlossary from './tools/get-glossary'
import getPageImage from './tools/get-page-image'
import getWorkspace from './tools/get-workspace'
import listPages from './tools/list-pages'
import listWorkspaces from './tools/list-workspaces'
import preparePageTranslation from './tools/prepare-page-translation'
import readPage from './tools/read-page'
import requestPageRead from './tools/request-page-read'
import reviewPageReading from './tools/review-page-reading'
import savePageBlocks from './tools/save-page-blocks'
import savePageTranslations from './tools/save-page-translations'
import sortPageBlocks from './tools/sort-page-blocks'
import updateWorkspace from './tools/update-workspace'

import type { McpPromptDefinition, McpToolDefinition, McpToolResult } from '~~/server/utils/mcpToolkit'

import { HttpError } from '~~/server/utils/errors'
import { requireMcpActor } from '~~/server/utils/mcp'
import { swarmState } from '~~/server/utils/swarm'

const TOOLS = [
  getActiveWorkspace,
  listWorkspaces,
  getWorkspace,
  updateWorkspace,
  listPages,
  readPage,
  requestPageRead,
  reviewPageReading,
  getPageImage,
  correctBlocks,
  savePageBlocks,
  sortPageBlocks,
  preparePageTranslation,
  savePageTranslations,
  getGlossary,
  getCast,
] as unknown as McpToolDefinition[]

const PROMPTS = [translateChapter] as unknown as McpPromptDefinition[]

/**
 * A tool's failure, as the toolkit reports one: the status in brackets, so an
 * agent can tell "no such page" from "the window did not answer", and the data
 * a refusal carries (the issues of a body that did not parse).
 */
function failed (error: unknown): McpToolResult {
  if (error instanceof HttpError) {
    const data = error.data == null ? '' : `\n${JSON.stringify(error.data)}`

    return { content: [{ type: 'text', text: `[${error.statusCode}] ${error.statusMessage}${data}` }], isError: true }
  }

  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
}

const anyChapter = z.string().optional()
  .describe('The chapter\'s id, from `list_workspaces`. Leave it out for the chapter open in Kemolate.')

const anyPage = z.number().int().positive().optional()
  .describe('The page\'s id, from `list_pages`. Leave it out for the page on screen in Kemolate, in the open chapter.')

/**
 * A tool that works on the open chapter and page when not told which —
 * desktop only.
 *
 * Every tool here names its chapter (`workspaceId`), and some one page
 * (`pageId`), because in the web build there is no "open" one to fall back on.
 * Here there is one window, so "this chapter" and "this page" mean what it
 * shows (`SwarmState.active`), and the ids become optional at registration —
 * the tool files stay the web build's. An id given is used as given; only a
 * missing one is filled in, and the page only for the open chapter, since the
 * page on screen means nothing about another. Nothing open is said, with what
 * to do instead, rather than guessed at.
 */
function defaulted (tool: McpToolDefinition): McpToolDefinition {
  const shape = tool.inputSchema

  if (!shape || !('workspaceId' in shape)) return tool

  const onePage = 'pageId' in shape

  return {
    ...tool,
    inputSchema: { ...shape, workspaceId: anyChapter, ...(onePage ? { pageId: anyPage } : {}) },
    handler: (input: Record<string, unknown>) => {
      const open = swarmState.active
      const filled = { ...input }

      if (filled.workspaceId === undefined) {
        if (!open) {
          throw createError({
            statusCode: 409,
            statusMessage: 'No chapter is open in Kemolate, so name a `workspaceId` (from `list_workspaces`) — or ask the user to open the chapter.',
          })
        }

        filled.workspaceId = open.publicId
      }

      if (onePage && filled.pageId === undefined) {
        if (!open || filled.workspaceId !== open.publicId) {
          throw createError({ statusCode: 400, statusMessage: 'Name a `pageId` (from `list_pages`): the page on screen is only the default in the chapter open in Kemolate.' })
        }

        if (!open.pageId) {
          throw createError({ statusCode: 409, statusMessage: 'The page on screen in Kemolate has no record yet — name a `pageId` from `list_pages`.' })
        }

        filled.pageId = open.pageId
      }

      return tool.handler(filled as never)
    },
  }
}

/** The server one request is answered by, offering what this caller may see — see `mcpEnabled`. */
export function serverFor (event: { context: Record<string, unknown> }): McpServer {
  const server = new McpServer(
    { name: 'kemolate', title: 'Kemolate', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  )

  const tools = TOOLS.filter((tool) => !tool.enabled || tool.enabled(event)).map(defaulted)
  const prompts = PROMPTS.filter((prompt) => !prompt.enabled || prompt.enabled(event))

  /*
   * A caller offered nothing still has to be able to ask. The SDK only answers
   * `tools/list` and `prompts/list` once something is registered, so a server
   * with nothing on it answered "Method not found" — the error the toolkit's
   * rule exists to spare a client with a bad token. Answered empty instead —
   * and a call, which a client that listed tools earlier under another token
   * still makes, is answered with why, not "Method not found" (it was, and the
   * Claude Desktop bridge read that as Kemolate not running).
   */
  if (!tools.length) {
    server.server.registerCapabilities({ tools: {} })
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
    server.server.setRequestHandler(CallToolRequestSchema, () => {
      try {
        requireMcpActor(event)
      } catch (error) {
        return failed(error)
      }

      return failed(createError({ statusCode: 404, statusMessage: 'No such tool.' }))
    })
  }

  if (!prompts.length) {
    server.server.registerCapabilities({ prompts: {} })
    server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }))
  }

  for (const tool of tools) {
    const handler = async (input: Record<string, unknown>) => {
      try {
        return await tool.handler(input as never)
      } catch (error) {
        return failed(error)
      }
    }

    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, (tool.inputSchema ? handler : () => handler({})) as never)
  }

  for (const prompt of prompts) {
    server.registerPrompt(prompt.name, {
      title: prompt.title,
      description: prompt.description,
      argsSchema: prompt.inputSchema,
    }, (async (input: Record<string, unknown>) => ({
      messages: [{ role: 'user', content: { type: 'text', text: await prompt.handler(input as never) } }],
    })) as never)
  }

  return server
}
