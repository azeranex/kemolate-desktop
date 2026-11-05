/**
 * The assistant's conversation as Anthropic's Messages API takes it — desktop
 * only. See `messages.ts` for the shape it is turned from.
 *
 * Two things are Anthropic's own. A tool's pictures go *inside* its
 * `tool_result`, which is the one provider format that lets a tool answer with
 * an image. And the system prompt and the tool list carry `cache_control`:
 * together they are most of every request — the playbook alone is several
 * thousand tokens — and identical on every turn of a loop that may run forty
 * calls. So does the last block of the last message, a breakpoint that moves
 * with the conversation: each turn then reads everything before it from the
 * cache, at a tenth of the price, and only pays in full for what is new. With
 * the first two alone a page's lettering cost ~490k tokens at full price, the
 * transcript being sent again whole on every one of nineteen turns.
 */
import { argumentsOf } from './messages'

import type { AiModel } from '#shared/utils/models'
import type { ReasoningEffort } from '#shared/utils/prompt'
import type { OfferedTool, Part, Reply, Turn } from './messages'

import { anthropicModel, MAX_TOKENS, THINKING } from '~/utils/openrouter'

const partOf = (part: Part) => part.type === 'text'
  ? { type: 'text', text: part.text }
  : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }

function messagesOf (turns: Turn[]) {
  return turns.map((turn) => {
    if (turn.role === 'user') return { role: 'user', content: turn.text }

    if (turn.role === 'tool') {
      return {
        role: 'user',
        content: turn.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.callId,
          content: result.content.length ? result.content.map(partOf) : [{ type: 'text', text: '(no output)' }],
          ...(result.isError ? { is_error: true } : {}),
        })),
      }
    }

    // As it came, where it came from here — see `raw` in `messages.ts`.
    if (turn.raw?.service === 'Anthropic') return { role: 'assistant', content: (turn.raw.message as { content: unknown }).content }

    return {
      role: 'assistant',
      content: [
        ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
        ...turn.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
      ],
    }
  })
}

const CACHED = { type: 'ephemeral' }

/** The conversation with a cache breakpoint on its last block — see the header. */
function marked (messages: { role: string, content: unknown }[]) {
  const last = messages.at(-1)

  // Only the reader's or a tool's: a model's own turn goes back exactly as it came.
  if (!last || last.role !== 'user') return messages

  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...(last.content as Record<string, unknown>[])]
  const end = blocks.at(-1)

  if (end) blocks[blocks.length - 1] = { ...end, cache_control: CACHED }

  return [...messages.slice(0, -1), { ...last, content: blocks }]
}

export function anthropicBody (input: { model: AiModel, system: string, tools: OfferedTool[], turns: Turn[] }, effort: ReasoningEffort) {
  const budget = THINKING[effort]

  return {
    model: anthropicModel(input.model.id),
    max_tokens: MAX_TOKENS,
    ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    system: [{ type: 'text', text: input.system, cache_control: CACHED }],
    tools: input.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema,
      // On the last one: a breakpoint caches everything before it, the system prompt included.
      ...(index === input.tools.length - 1 ? { cache_control: CACHED } : {}),
    })),
    messages: marked(messagesOf(input.turns)),
  }
}

export function anthropicReply (data: unknown): Reply {
  const message = data as {
    content?: { type?: string, text?: string, id?: string, name?: string, input?: unknown }[]
    stop_reason?: string | null
  }
  const content = message.content ?? []

  const calls = content.filter((part) => part.type === 'tool_use').map((part) => ({
    id: part.id ?? '',
    name: part.name ?? '',
    ...argumentsOf(part.input),
  }))

  return {
    text: content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
    calls,
    stop: message.stop_reason === 'max_tokens' ? 'length' : calls.length ? 'tools' : 'end',
    raw: { service: 'Anthropic', message: { content } },
  }
}
