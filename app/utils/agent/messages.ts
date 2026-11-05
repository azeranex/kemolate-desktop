/**
 * A conversation with the assistant, in no provider's shape — desktop only.
 *
 * The assistant (`useAssistant`) talks to Anthropic on one key and to
 * OpenRouter or DeepSeek, in OpenAI's format, on another, and the reader may
 * change model between two messages. So the transcript is kept here in words
 * of its own — what was said, which tools were called with what, what each
 * answered — and `anthropic.ts` and `openai.ts` each turn it into their wire.
 *
 * ## `raw`, and why the reply is kept as it came
 *
 * A model's turn is also kept exactly as its provider sent it, tagged with the
 * service. Sent back to that service it goes as it came, because two of them
 * refuse a tool loop otherwise: Anthropic with thinking on wants each turn's
 * signed `thinking` blocks back, and DeepSeek thinking wants its
 * `reasoning_content` within the turn that is calling tools. Neither can be
 * rebuilt from the words. The neutral half is what is shown, and what another
 * provider is sent after a change of model, which can only happen between the
 * reader's messages — at a turn that called nothing, which is the one place
 * either provider accepts a turn without its reasoning.
 */
import type { Service } from '~/utils/openrouter'

/** One part of what a tool answered: text, or a picture as base64. */
export type Part =
  | { type: 'text', text: string }
  | { type: 'image', data: string, mimeType: string }

/** A tool the model asked for. `unparsed` is arguments that were not JSON, which the loop answers as an error. */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  unparsed?: string
}

/** What one call answered. */
export interface ToolResult {
  callId: string
  name: string
  content: Part[]
  isError: boolean
}

export type Turn =
  | { role: 'user', text: string }
  | { role: 'assistant', text: string, calls: ToolCall[], raw?: { service: Service, message: unknown } }
  /** Every answer to one assistant turn's calls, together — Anthropic takes them as one message. */
  | { role: 'tool', results: ToolResult[] }

/** A tool as the model is offered it: `tools/list`'s entry. */
export interface OfferedTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** What a provider's reply comes to, whoever sent it. */
export interface Reply {
  text: string
  calls: ToolCall[]
  /** `length`: cut off at the token limit, which is no answer however it reads. */
  stop: 'end' | 'tools' | 'length'
  raw: { service: Service, message: unknown }
}

/** Arguments as a model wrote them, which is a JSON string in OpenAI's format and sometimes not JSON. */
export function argumentsOf (written: unknown): { arguments: Record<string, unknown>, unparsed?: string } {
  if (written && typeof written === 'object' && !Array.isArray(written)) return { arguments: written as Record<string, unknown> }
  if (typeof written !== 'string' || !written.trim()) return { arguments: {} }

  try {
    const parsed = JSON.parse(written) as unknown

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { arguments: parsed as Record<string, unknown> }
  } catch {
    // Not JSON: said below, as arguments the loop answers with an error.
  }

  return { arguments: {}, unparsed: written }
}
