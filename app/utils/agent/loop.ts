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
 * prompt. Anything that answers only with a picture is left out for a model
 * that cannot see, which would otherwise call it and be told nothing.
 */
const NEVER = new Set(['get_guide'])
const PICTURE_ONLY = new Set(['get_page_image'])

export interface Tool extends OfferedTool {
  annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean }
}

export function offered (tools: Tool[], model: AiModel): Tool[] {
  return tools.filter((tool) => !NEVER.has(tool.name) && (model.vision || !PICTURE_ONLY.has(tool.name)))
}

/** Whether a call waits for the reader — see "Asking the reader". */
export const asksFirst = (tool: Tool | undefined) => Boolean(tool && !tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint)

const NO_SIGHT: Part = { type: 'text', text: '[A picture was returned here, but this model cannot see pictures.]' }
const SEEN: Part = { type: 'text', text: '[A picture was shown here earlier.]' }

/** The turns as they are sent: older pictures dropped, and every picture for a model that cannot see. */
export function forSending (turns: Turn[], model: AiModel, keep = KEEP_PICTURES): Turn[] {
  let kept = 0

  return [...turns].reverse().map((turn) => {
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
  effort: ReasoningEffort
  signal: AbortSignal
  ask: Asker
  call: (name: string, args: Record<string, unknown>) => Promise<{ content: Part[], isError?: boolean }>
  /** Whether the reader lets this call run — asked only where `asksFirst`. */
  approve: (call: ToolCall, tool: Tool) => Promise<boolean>
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
    const result = await input.call(call.name, call.arguments)

    return { callId: call.id, name: call.name, content: result.content, isError: Boolean(result.isError) }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  } finally {
    input.running?.(null)
  }
}

export async function runLoop (input: LoopInput): Promise<Ending> {
  const tools = offered(input.tools, input.model)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const most = input.maxCalls ?? MAX_CALLS
  let calls = 0

  for (;;) {
    const turns = forSending(input.turns, input.model)
    const sent = await input.ask((service, effort) => service === 'Anthropic'
      ? anthropicBody({ model: input.model, system: input.system, tools, turns }, effort)
      : openAiBody(service, { model: input.model, system: input.system, tools, turns }, effort), {
      effort: input.effort,
      signal: input.signal,
      retrying: input.retrying,
    })

    if (sent.usage) input.spent?.(sent.usage)

    const reply = readOf(sent)

    input.turns.push({ role: 'assistant', text: reply.text, calls: reply.calls, raw: reply.raw })

    if (reply.stop === 'length') return 'cut-off'
    if (!reply.calls.length) return 'answered'

    const results: ToolResult[] = []
    const unrun = (call: ToolCall, text: string): ToolResult => ({ callId: call.id, name: call.name, content: [{ type: 'text', text }], isError: true })

    try {
      for (const call of reply.calls) {
        // Out of calls: every call this turn still gets an answer, which both formats insist on.
        results.push(calls >= most ? unrun(call, 'Not run: this message has used all its tool calls.') : await answer(input, call, byName.get(call.name)))
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
