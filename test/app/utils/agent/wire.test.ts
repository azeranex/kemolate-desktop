import { describe, expect, it } from 'vitest'

import type { AiModel } from '#shared/utils/models'
import type { Turn } from '~/utils/agent/messages'

import { anthropicBody, anthropicReply } from '~/utils/agent/anthropic'
import { openAiBody, openAiReply } from '~/utils/agent/openai'

/**
 * The assistant's conversation on each provider's wire.
 *
 * What is worth pinning is where the formats differ and a wrong turn is a
 * refused request rather than a worse answer: a tool's pictures (inside the
 * result on Anthropic, after the tool messages in OpenAI's format), a turn
 * sent back as it came to the service it came from, and arguments that were
 * not JSON.
 */

const model: AiModel = { id: 'anthropic/claude-sonnet-5.5', label: 'Sonnet', note: '', vision: true, price: { in: 1, out: 1 } }
const tools = [{ name: 'read_page', description: 'Read.', inputSchema: { type: 'object', properties: {} } }]

const turns: Turn[] = [
  { role: 'user', text: 'Check this page.' },
  { role: 'assistant', text: 'Looking.', calls: [{ id: 't1', name: 'review_page_reading', arguments: { pageId: 4 } }] },
  {
    role: 'tool',
    results: [{
      callId: 't1',
      name: 'review_page_reading',
      isError: false,
      content: [{ type: 'text', text: 'two blocks' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    }],
  },
]

describe('Anthropic', () => {
  it('puts a tool\'s pictures inside its result, and caches the system prompt and tools', () => {
    const body = anthropicBody({ model, system: 'You help.', tools, turns }, 'auto')

    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.system[0]).toMatchObject({ text: 'You help.', cache_control: { type: 'ephemeral' } })
    expect(body.tools.at(-1)).toMatchObject({ name: 'read_page', input_schema: tools[0]!.inputSchema, cache_control: { type: 'ephemeral' } })
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'review_page_reading', input: { pageId: 4 } }],
    })
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'two blocks' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      }],
    })
  })

  it('sends its own turn back as it came, thinking and all', () => {
    const thinking = [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }]
    const raw: Turn = { role: 'assistant', text: '', calls: [{ id: 't1', name: 'x', arguments: {} }], raw: { service: 'Anthropic', message: { content: thinking } } }

    expect(anthropicBody({ model, system: '', tools, turns: [turns[0]!, raw] }, 'auto').messages[1]).toEqual({ role: 'assistant', content: thinking })
  })

  it('reads a reply that calls tools', () => {
    const reply = anthropicReply({
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'One moment.' }, { type: 'tool_use', id: 'c', name: 'list_pages', input: { needs: 'reading' } }],
    })

    expect(reply).toMatchObject({ text: 'One moment.', stop: 'tools', calls: [{ id: 'c', name: 'list_pages', arguments: { needs: 'reading' } }] })
  })
})

describe('OpenAI\'s format', () => {
  it('says a tool returned pictures, and sends them after the tool messages', () => {
    const body = openAiBody('OpenRouter', { model, system: 'You help.', tools, turns }, 'auto')

    expect(body.messages[0]).toEqual({ role: 'system', content: 'You help.' })
    expect(body.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'review_page_reading', arguments: '{"pageId":4}' } }] })
    expect(body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 't1' })
    expect(String(body.messages[3]!.content)).toContain('1 picture(s) from this call follow')
    expect(body.messages[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Pictures from review_page_reading (call t1):' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })

  it('names DeepSeek\'s own model', () => {
    const deepseek: AiModel = { ...model, id: 'deepseek/deepseek-v4-pro', vision: false }

    expect(openAiBody('DeepSeek', { model: deepseek, system: '', tools, turns: [turns[0]!] }, 'auto').model).toBe('deepseek-v4-pro')
  })

  it('keeps arguments that were not JSON for the loop to refuse', () => {
    const reply = openAiReply('OpenRouter', {
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c', function: { name: 'read_page', arguments: '{pageId: 4' } }] } }],
    })

    expect(reply.calls[0]).toEqual({ id: 'c', name: 'read_page', arguments: {}, unparsed: '{pageId: 4' })
    expect(reply.raw).toMatchObject({ service: 'OpenRouter', message: { role: 'assistant' } })
  })
})
