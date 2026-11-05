import { describe, expect, it, vi } from 'vitest'

import type { AiModel } from '#shared/utils/models'
import type { Asker, LoopInput, Tool } from '~/utils/agent/loop'
import type { Turn } from '~/utils/agent/messages'

import { forSending, offered, runLoop } from '~/utils/agent/loop'

/**
 * The assistant's loop, against a provider that answers from a script.
 *
 * Seam: `ask` — the loop is handed the provider round rather than reaching for
 * `send`, so these are Anthropic-shaped replies with no network under them.
 */

const seeing: AiModel = { id: 'anthropic/claude-sonnet-5.5', label: 'Sonnet', note: '', vision: true, price: { in: 1, out: 1 } }
const blind: AiModel = { ...seeing, vision: false }

const tools: Tool[] = [
  { name: 'get_guide', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'list_pages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'get_page_image', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'join_blocks', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
]

const calling = (...calls: { id: string, name: string, input?: object }[]) => ({
  stop_reason: 'tool_use',
  content: calls.map((call) => ({ type: 'tool_use', input: {}, ...call })),
})
const saying = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })

/** A provider that answers with these replies in turn, and the bodies it was sent. */
function scripted (...replies: unknown[]) {
  const bodies: Record<string, unknown>[] = []
  const ask: Asker = async (body, options) => {
    bodies.push(body('Anthropic', options.effort))

    return { service: 'Anthropic', data: replies.shift(), usage: { input: 10, output: 5, reasoning: 0, cost: 0.01 } }
  }

  return { ask, bodies }
}

function input (overrides: Partial<LoopInput> & Pick<LoopInput, 'ask'>): LoopInput {
  return {
    model: seeing,
    system: 'You help.',
    tools,
    turns: [{ role: 'user', text: 'Go.' }],
    effort: 'auto',
    signal: new AbortController().signal,
    call: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    approve: vi.fn(async () => true),
    ...overrides,
  }
}

describe('the assistant\'s loop', () => {
  it('runs a call, gives the answer back, and stops when the model answers', async () => {
    const { ask, bodies } = scripted(calling({ id: 'a', name: 'list_pages', input: { needs: 'reading' } }), saying('Two pages need reading.'))
    const run = input({ ask })

    expect(await runLoop(run)).toBe('answered')
    expect(run.call).toHaveBeenCalledWith('list_pages', { needs: 'reading' })
    expect(run.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(bodies).toHaveLength(2)
  })

  it('does not offer the playbook, which is its prompt, nor a picture-only tool to a model that cannot see', () => {
    expect(offered(tools, seeing).map((tool) => tool.name)).toEqual(['list_pages', 'get_page_image', 'join_blocks'])
    expect(offered(tools, blind).map((tool) => tool.name)).toEqual(['list_pages', 'join_blocks'])
  })

  it('asks the reader before a destructive call, and a no goes back as its answer', async () => {
    const { ask } = scripted(calling({ id: 'j', name: 'join_blocks' }), saying('Left them apart.'))
    const run = input({ ask, approve: vi.fn(async () => false) })

    await runLoop(run)

    expect(run.approve).toHaveBeenCalledTimes(1)
    expect(run.call).not.toHaveBeenCalled()
    expect(run.turns[2]).toMatchObject({ role: 'tool', results: [{ callId: 'j', isError: true }] })
  })

  it('does not ask before a read', async () => {
    const { ask } = scripted(calling({ id: 'a', name: 'list_pages' }), saying('Done.'))
    const run = input({ ask })

    await runLoop(run)

    expect(run.approve).not.toHaveBeenCalled()
  })

  it('stops at its call limit, answering every call it was asked for', async () => {
    const { ask } = scripted(calling({ id: 'a', name: 'list_pages' }, { id: 'b', name: 'list_pages' }, { id: 'c', name: 'list_pages' }))
    const run = input({ ask, maxCalls: 2 })

    expect(await runLoop(run)).toBe('out-of-calls')
    expect(run.call).toHaveBeenCalledTimes(2)
    expect((run.turns[2] as Extract<Turn, { role: 'tool' }>).results.map((result) => result.isError)).toEqual([false, false, true])
  })

  it('answers the calls it did not reach when stopped, so the conversation can go on', async () => {
    const stopping = new AbortController()
    const { ask } = scripted(calling({ id: 'a', name: 'list_pages' }, { id: 'b', name: 'list_pages' }))
    const run = input({
      ask,
      signal: stopping.signal,
      call: vi.fn(async () => {
        stopping.abort(new DOMException('Stopped.', 'AbortError'))

        return { content: [{ type: 'text' as const, text: 'ok' }] }
      }),
    })

    await expect(runLoop(run)).rejects.toThrow('Stopped.')
    expect((run.turns[2] as Extract<Turn, { role: 'tool' }>).results.map((result) => result.callId)).toEqual(['a', 'b'])
  })

  it('refuses a tool that does not exist and arguments that are not JSON, without calling anything', async () => {
    const { ask } = scripted(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'delete_everything', input: {} }] },
      saying('Sorry.'),
    )
    const run = input({ ask })

    await runLoop(run)

    expect(run.call).not.toHaveBeenCalled()
    expect(run.turns[2]).toMatchObject({ results: [{ isError: true, content: [{ text: 'There is no tool called delete_everything.' }] }] })
  })
})

describe('what is sent again', () => {
  const pictured = (id: string): Turn => ({
    role: 'tool',
    results: [{ callId: id, name: 'get_page_image', isError: false, content: [{ type: 'image', data: id, mimeType: 'image/png' }] }],
  })

  const pictures = (turns: Turn[]) => turns.flatMap((turn) => turn.role === 'tool'
    ? turn.results.flatMap((result) => result.content.filter((part) => part.type === 'image').map((part) => (part as { data: string }).data))
    : [])

  it('keeps pictures only in the newest answers', () => {
    expect(pictures(forSending([pictured('1'), pictured('2'), pictured('3')], seeing, 2))).toEqual(['2', '3'])
  })

  it('keeps none for a model that cannot see, and says so', () => {
    const sent = forSending([pictured('1')], blind)

    expect(pictures(sent)).toEqual([])
    expect(JSON.stringify(sent)).toContain('cannot see pictures')
  })
})
