/**
 * The assistant's loop — desktop only: ask the model, run the tools it asks
 * for, give it the answers, and go round until it answers without asking for
 * anything.
 *
 * It owns no tool and no rule about one. The tools are the MCP server's
 * (`electron/assistant.ts`), offered as `tools/list` describes them, and every
 * call goes back there. What is decided here is the loop itself: which tools a
 * model is offered, which calls wait for the reader, how much of the past is
 * sent again, and when to stop.
 *
 * ## Asking the reader
 *
 * By each tool's own annotations, so that a tool says once, where it is
 * defined, what kind of thing it is. Reading runs. A write that is not marked
 * destructive runs too — a translation saved is a revision, a style or a
 * correction is a change the reader can make back. One marked destructive
 * (`join_blocks`, `split_block`, `save_page_blocks`, `sort_page_blocks`,
 * `request_page_read`) waits for the reader, and a "no" goes back to the model
 * as that call's answer, so it can carry on knowing.
 *
 * ## What is sent again
 *
 * Every turn sends the whole conversation, and a check of a page returns a
 * crop per balloon. Sent again on every later turn, a chapter's worth of crops
 * would cost far more than looking at them did. So pictures are kept only in
 * the last `KEEP_PICTURES` tool answers; older ones become a line saying one
 * was there. The model saw them when they mattered, and the words it wrote
 * about them are still in the conversation.
 *
 * Answers a later call has made out of date go the same way (`SUPERSEDED`):
 * the review of a page that has been reviewed again since, a brief whose
 * translations have been saved. They were most of what a lettering run sent
 * again, and nothing in them was still true.
 *
 * Both rewrite an earlier turn, which the provider's cache then misses from
 * that turn on. That is paid once, when the newer answer arrives; resending the
 * stale one was paid on every turn after it.
 *
 * ## What is offered
 *
 * The server's tools, less those with nothing to do in a window that is already
 * on its chapter (`NEVER`), and with their schemas shed of what the tab makes
 * true (`compact`) — the tool list is sent on every turn, and at ~36k
 * characters it was bigger than the playbook. Plus the window's own tools
 * (`LoopInput.local`), answered here rather than by the server.
 */

import { anthropicBody, anthropicReply } from './anthropic'
import { openAiBody, openAiReply } from './openai'

import type { AiModel } from '#shared/utils/models'
import type { ReasoningEffort } from '#shared/utils/prompt'
import type { OfferedTool, Part, Reply, ToolCall, ToolResult, Turn } from './messages'
import type { AiUsage, SendOptions, Sent, Service } from '~/utils/openrouter'

/** How many tool answers keep their pictures — see the header. */
export const KEEP_PICTURES = 2

/** The most tool calls one message from the reader may lead to before the loop stops and says so. */
export const MAX_CALLS = 40

/**
 * Tools the assistant is not offered. `get_guide` is already its system
 * prompt (and `read_playbook`). The workspace tools choose, list, open and
 * rename chapters, and the assistant works on the one in its tab. Anything that
 * answers only with a picture is left out for a model that cannot see, which
 * would otherwise call it and be told nothing.
 */
const NEVER = new Set(['get_guide', 'list_workspaces', 'open_workspace', 'get_workspace', 'update_workspace'])
const PICTURE_ONLY = new Set(['get_page_image'])

export interface Tool extends OfferedTool {
  annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean }
}

/**
 * A schema without what is true of every call from a tab: no `workspaceId`
 * (the tab's chapter is filled in — see `defaulted` on the server), no
 * `$schema`, no integer bound nobody will reach, and `pageId` said once.
 */
export function compact (schema: unknown, top = true): unknown {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false))
  if (!schema || typeof schema !== 'object') return schema

  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema' || (key === 'maximum' && value === Number.MAX_SAFE_INTEGER)) continue

    if (top && key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'workspaceId').map(([name, field]) => [
        name,
        name === 'pageId' ? { ...(compact(field, false) as object), description: 'Leave out for the page on screen.' } : compact(field, false),
      ]))
    } else if (top && key === 'required' && Array.isArray(value)) {
      out[key] = value.filter((name) => name !== 'workspaceId')
    } else {
      out[key] = compact(value, false)
    }
  }

  return out
}

export function offered (tools: Tool[], model: AiModel): Tool[] {
  return tools
    .filter((tool) => !NEVER.has(tool.name) && (model.vision || !PICTURE_ONLY.has(tool.name)))
    .map((tool) => ({ ...tool, inputSchema: compact(tool.inputSchema) as Record<string, unknown> }))
}

/** Whether a call waits for the reader — see "Asking the reader". */
export const asksFirst = (tool: Tool | undefined) => Boolean(tool && !tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint)

const NO_SIGHT: Part = { type: 'text', text: '[A picture was returned here, but this model cannot see pictures.]' }
const SEEN: Part = { type: 'text', text: '[A picture was shown here earlier.]' }

/**
 * Which later calls make an answer out of date — see the header. A review once
 * the same page is reviewed again; a page read once it is read again; a brief
 * once that page's translations are saved, or it is briefed again.
 */
const SUPERSEDED: Record<string, string[]> = {
  review_lettering: ['review_lettering'],
  review_page_reading: ['review_page_reading'],
  read_page: ['read_page'],
  prepare_page_translation: ['save_page_translations', 'prepare_page_translation'],
}

/** The pages a call is about, each as a comparable key: the page on screen when it names none. */
function pagesOf (call: ToolCall): string[] {
  const args = call.arguments
  const named = Array.isArray(args.pageIds)
    ? args.pageIds
    : Array.isArray(args.pages) ? (args.pages as { pageId?: unknown }[]).map((page) => page?.pageId) : [args.pageId]

  return named.map((id) => String(id ?? 'screen'))
}

const stale = (name: string): Part => ({ type: 'text', text: `[Out of date: a later call replaced what ${name} answered here, so it is no longer sent.]` })

/** The ids of answers a later, successful call has made out of date. */
function staleIn (turns: Turn[]): Set<string> {
  const calls = turns.flatMap((turn) => (turn.role === 'assistant' ? turn.calls : []))
  const failed = new Set(turns.flatMap((turn) => (turn.role === 'tool' ? turn.results.filter((result) => result.isError).map((result) => result.callId) : [])))
  const out = new Set<string>()

  calls.forEach((call, at) => {
    const by = SUPERSEDED[call.name]

    if (!by || failed.has(call.id)) return

    const later = calls.slice(at + 1).filter((next) => by.includes(next.name) && !failed.has(next.id))

    // Only once every page the answer was about has been dealt with since.
    if (pagesOf(call).every((page) => later.some((next) => pagesOf(next).includes(page)))) out.add(call.id)
  })

  return out
}

/** The turns as they are sent: out-of-date answers and older pictures dropped, and every picture for a model that cannot see. */
export function forSending (turns: Turn[], model: AiModel, keep = KEEP_PICTURES): Turn[] {
  const replaced = staleIn(turns)
  let kept = 0

  return turns.map((turn) => (turn.role === 'tool' && turn.results.some((result) => replaced.has(result.callId))
    ? { ...turn, results: turn.results.map((result) => (replaced.has(result.callId) ? { ...result, content: [stale(result.name)] } : result)) }
    : turn)).reverse().map((turn) => {
    if (turn.role === 'user') {
      // A chapter run's message, with the review it looked up: its pictures are kept like a tool's.
      if (!turn.parts?.some((part) => part.type === 'image')) return turn

      const keeping = model.vision && kept < keep

      kept += 1

      return keeping ? turn : { ...turn, parts: turn.parts.map((part) => (part.type === 'image' ? (model.vision ? SEEN : NO_SIGHT) : part)) }
    }

    if (turn.role !== 'tool') return turn

    const pictured = turn.results.some((result) => result.content.some((part) => part.type === 'image'))
    const keeping = model.vision && pictured && kept < keep

    if (pictured) kept += 1
    if (keeping || !pictured) return turn

    return {
      ...turn,
      results: turn.results.map((result) => ({
        ...result,
        content: result.content.map((part) => (part.type === 'image' ? (model.vision ? SEEN : NO_SIGHT) : part)),
      })),
    }
  }).reverse()
}

/** One provider round, whichever service the key goes to. */
export type Asker = (body: (service: Service, effort: ReasoningEffort) => Record<string, unknown>, options: SendOptions) => Promise<Sent>

export interface LoopInput {
  model: AiModel
  system: string
  tools: Tool[]
  /** The conversation so far, ending with the reader's message. Turns are pushed onto it as they happen. */
  turns: Turn[]
  /**
   * Where in `turns` what the model is sent begins. A chapter run is a fresh
   * conversation per page, shown in the panel one after the other; sending
   * each the pages before it would make a chapter cost the square of its length.
   */
  since?: number
  effort: ReasoningEffort
  signal: AbortSignal
  ask: Asker
  call: (name: string, args: Record<string, unknown>) => Promise<{ content: Part[], isError?: boolean }>
  /** Whether the reader lets this call run — asked only where `asksFirst`. */
  approve: (call: ToolCall, tool: Tool) => Promise<boolean>
  /** Tools whose calls a conversation of these turns refuses — see `TOOLS_OF` in `prompt.ts`. Asked every turn. */
  withheld?: (turns: Turn[]) => Set<string>
  /** Tools left out of the list altogether. Asked every turn, and kept rare: a changed list is a cache missed whole. */
  unlisted?: (turns: Turn[]) => Set<string>
  /** Tools answered in the window rather than by the server — `read_playbook`. */
  local?: { tool: Tool, run: (args: Record<string, unknown>) => string }[]
  /** Each provider round's cost, for the ledger. */
  spent?: (usage: AiUsage) => void
  retrying?: (wait: number) => void
  /** Which call is running, for the panel. */
  running?: (call: ToolCall | null) => void
  maxCalls?: number
}

/** How a run ended: answered, out of calls, or cut off at the token limit. */
export type Ending = 'answered' | 'out-of-calls' | 'cut-off'

function readOf (sent: Sent): Reply {
  return sent.service === 'Anthropic' ? anthropicReply(sent.data) : openAiReply(sent.service, sent.data)
}

async function answer (input: LoopInput, call: ToolCall, tool: Tool | undefined): Promise<ToolResult> {
  const failed = (text: string): ToolResult => ({ callId: call.id, name: call.name, content: [{ type: 'text', text }], isError: true })

  if (!tool) return failed(`There is no tool called ${call.name}.`)
  if (call.unparsed !== undefined) return failed('The arguments were not a JSON object. Call it again with valid JSON.')
  if (asksFirst(tool) && !await input.approve(call, tool)) return failed('The user declined this call. Ask them, or carry on without it.')

  input.signal.throwIfAborted()
  input.running?.(call)

  try {
    const own = input.local?.find((local) => local.tool.name === call.name)

    if (own) return { callId: call.id, name: call.name, content: [{ type: 'text', text: own.run(call.arguments) }], isError: false }

    const result = await input.call(call.name, call.arguments)

    return { callId: call.id, name: call.name, content: result.content, isError: Boolean(result.isError) }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  } finally {
    input.running?.(null)
  }
}

export async function runLoop (input: LoopInput): Promise<Ending> {
  const all = [...offered(input.tools, input.model), ...(input.local ?? []).map((local) => local.tool)]
  const most = input.maxCalls ?? MAX_CALLS
  let calls = 0

  for (;;) {
    const conversation = input.turns.slice(input.since ?? 0)
    const held = input.withheld?.(conversation) ?? new Set<string>()
    const hidden = input.unlisted?.(conversation) ?? new Set<string>()
    const tools = all.filter((tool) => !hidden.has(tool.name))
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const turns = forSending(conversation, input.model)
    const sent = await input.ask((service, effort) => service === 'Anthropic'
      ? anthropicBody({ model: input.model, system: input.system, tools, turns }, effort)
      : openAiBody(service, { model: input.model, system: input.system, tools, turns }, effort), {
      effort: input.effort,
      signal: input.signal,
      retrying: input.retrying,
    })

    if (sent.usage) input.spent?.(sent.usage)

    const reply = readOf(sent)

    input.turns.push({ role: 'assistant', text: reply.text, calls: reply.calls, ...(reply.reasoning ? { reasoning: reply.reasoning } : {}), raw: reply.raw })

    if (reply.stop === 'length') return 'cut-off'
    if (!reply.calls.length) return 'answered'

    const results: ToolResult[] = []
    const unrun = (call: ToolCall, text: string): ToolResult => ({ callId: call.id, name: call.name, content: [{ type: 'text', text }], isError: true })

    try {
      for (const call of reply.calls) {
        // Out of calls: every call this turn still gets an answer, which both formats insist on.
        results.push(calls >= most
          ? unrun(call, 'Not run: this message has used all its tool calls.')
          : held.has(call.name)
            ? unrun(call, byName.has(call.name)
                ? `Not yet: ${call.name} comes with its playbook topic. Read it with read_playbook, then call it.`
                : `There is no tool called ${call.name}.`)
            : await answer(input, call, byName.get(call.name)))
        calls += 1
      }
    } finally {
      // Stopped part-way: the calls not reached are answered as stopped, or the
      // conversation would end on calls with no answers and every later ask be refused.
      for (const call of reply.calls.slice(results.length)) results.push(unrun(call, 'Not run: the user pressed Stop.'))

      input.turns.push({ role: 'tool', results })
    }

    if (calls >= most) return 'out-of-calls'
  }
}
