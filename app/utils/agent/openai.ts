/**
 * The assistant's conversation in OpenAI's chat format, for OpenRouter and
 * DeepSeek — desktop only. See `messages.ts` for the shape it is turned from.
 *
 * ## A tool's pictures
 *
 * A `tool` message in this format carries text and nothing else, while half
 * of what makes the assistant worth having is a tool answering with a crop
 * (`review_page_reading`, `review_lettering`, `get_page_image`). So each
 * answer's text says how many pictures it returned, and the pictures follow in
 * one `user` message straight after the tool messages, each introduced by the
 * call it belongs to. Every provider here accepts that order, and the model
 * reads them as the answer they are.
 *
 * A model that cannot see never gets this far with a picture: the loop has
 * already put a sentence in its place (`blind` in `loop.ts`).
 *
 * ## Caching
 *
 * DeepSeek, OpenAI and Google cache a repeated prompt by themselves. Claude
 * through OpenRouter does not unless asked, and asked nothing a page's
 * lettering was ~490k tokens all at full price. A top-level `cache_control` is
 * OpenRouter's automatic mode: it puts the breakpoint on the last cacheable
 * block and moves it as the conversation grows, which is what `anthropic.ts`
 * does by hand for a direct key. Here it cannot be done by hand: a `tool`
 * message is a string, with no block to carry one.
 *
 * Automatic alone still paid in full every few turns (a 24k-token turn billed
 * as a cache write, 2026-11-06), so two explicit breakpoints go beside it —
 * Anthropic counts the automatic one as one of four. One on the system prompt,
 * which with the tools before it is most of every request and outlives any
 * change to the messages; and one on the newest message that can carry it (the
 * reader's, or a tool's pictures), so a lookback from the moving breakpoint
 * that falls short still lands on a prefix that was written. Explicit
 * breakpoints are also what keeps OpenRouter on the provider that holds the
 * cache. What breaks a cache whole is the tool list changing, which is why
 * `withheld` in `prompt.ts` refuses a call rather than unlisting the tool.
 */
import { argumentsOf } from './messages'

import type { AiModel } from '#shared/utils/models'
import type { ReasoningEffort } from '#shared/utils/prompt'
import type { OfferedTool, Part, Reply, Turn } from './messages'
import type { Service } from '~/utils/openrouter'

import { deepseekModel, deepseekThinking, MAX_TOKENS } from '~/utils/openrouter'

const partOf = (part: Part) => part.type === 'text'
  ? { type: 'text', text: part.text }
  : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }

const CACHED = { type: 'ephemeral' }

/**
 * The explicit breakpoints for Claude through OpenRouter — see "Caching": the
 * system prompt, and the last block of the newest message that has blocks.
 */
function marked (messages: Record<string, unknown>[]) {
  const out = [...messages]
  const [system] = out

  if (system && typeof system.content === 'string') out[0] = { ...system, content: [{ type: 'text', text: system.content, cache_control: CACHED }] }

  for (let at = out.length - 1; at > 0; at--) {
    const message = out[at]!

    if (message.role !== 'user') continue

    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...(message.content as Record<string, unknown>[])]
    const end = blocks.at(-1)

    if (end) blocks[blocks.length - 1] = { ...end, cache_control: CACHED }
    out[at] = { ...message, content: blocks }

    break
  }

  return out
}

function messagesOf (service: Service, system: string, turns: Turn[]) {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: system }]

  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.parts?.length ? [{ type: 'text', text: turn.text }, ...turn.parts.map(partOf)] : turn.text })
    } else if (turn.role === 'assistant') {
      // As it came, where it came from here — see `raw` in `messages.ts`.
      if (turn.raw?.service === service) {
        messages.push(turn.raw.message as Record<string, unknown>)

        continue
      }

      messages.push({
        role: 'assistant',
        content: turn.text || null,
        ...(turn.calls.length
          ? {
              tool_calls: turn.calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.unparsed ?? JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      })
    } else {
      const pictures: Record<string, unknown>[] = []

      for (const result of turn.results) {
        const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        const images = result.content.filter((part) => part.type === 'image')
        const said = images.length ? `${text}\n\n[${images.length} picture(s) from this call follow in the next message.]` : text

        messages.push({ role: 'tool', tool_call_id: result.callId, content: (result.isError ? `Error: ${said}` : said) || '(no output)' })

        if (images.length) {
          pictures.push({ type: 'text', text: `Pictures from ${result.name} (call ${result.callId}):` })
          pictures.push(...images.map(partOf))
        }
      }

      if (pictures.length) messages.push({ role: 'user', content: pictures })
    }
  }

  return messages
}

export function openAiBody (service: Service, input: { model: AiModel, system: string, tools: OfferedTool[], turns: Turn[] }, effort: ReasoningEffort) {
  const deepseek = service === 'DeepSeek'
  const claude = !deepseek && input.model.id.startsWith('anthropic/')
  const messages = messagesOf(service, input.system, input.turns)

  return {
    model: deepseek ? deepseekModel(input.model.id) : input.model.id,
    max_tokens: MAX_TOKENS,
    ...(deepseek ? deepseekThinking(effort) : { usage: { include: true }, ...(effort === 'auto' ? {} : { reasoning: { effort } }) }),
    ...(claude ? { cache_control: CACHED } : {}),
    tools: input.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema },
    })),
    messages: claude ? marked(messages) : messages,
  }
}

export function openAiReply (service: Service, data: unknown): Reply {
  const choice = (data as {
    choices?: {
      message?: { content?: string | null, tool_calls?: { id?: string, function?: { name?: string, arguments?: unknown } }[] } & Record<string, unknown>
      finish_reason?: string | null
    }[]
  }).choices?.[0]
  const message = choice?.message ?? {}

  const calls = (message.tool_calls ?? []).map((call, index) => ({
    id: call.id || `call_${index}`,
    name: call.function?.name ?? '',
    ...argumentsOf(call.function?.arguments),
  }))

  return {
    text: message.content ?? '',
    calls,
    stop: choice?.finish_reason === 'length' ? 'length' : calls.length ? 'tools' : 'end',
    // Kept whole, with the role it may have left out, so it goes back as it came.
    raw: { service, message: { ...message, role: 'assistant' } },
  }
}
