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

  it('offers schemas without the chapter, which the tab fills in', () => {
    const [tool] = offered([{
      name: 'read_page',
      inputSchema: {
        $schema: 'x',
        type: 'object',
        properties: { workspaceId: { type: 'string' }, pageId: { type: 'integer', maximum: Number.MAX_SAFE_INTEGER, description: 'long' } },
        required: ['workspaceId'],
      },
    }], seeing)

    expect(tool!.inputSchema).toEqual({ type: 'object', properties: { pageId: { type: 'integer', description: 'Leave out for the page on screen.' } }, required: [] })
  })

  it('answers a window tool itself, and sends only the turns since its conversation began', async () => {
    const { ask, bodies } = scripted(calling({ id: 'p', name: 'read_playbook', input: { topic: 'lettering' } }), saying('Read.'))
    const run = input({
      ask,
      turns: [{ role: 'user', text: 'An earlier page.' }, { role: 'assistant', text: 'Done.', calls: [] }, { role: 'user', text: 'Go.' }],
      since: 2,
      local: [{ tool: { name: 'read_playbook', inputSchema: { type: 'object' } }, run: () => 'the chapter' }],
    })

    await runLoop(run)

    expect(run.call).not.toHaveBeenCalled()
    expect(run.turns[4]).toMatchObject({ results: [{ content: [{ text: 'the chapter' }] }] })
    expect((bodies[0]!.messages as unknown[])).toHaveLength(1)
    expect((bodies[0]!.tools as { name: string }[]).map((tool) => tool.name)).toContain('read_playbook')
  })

  it('refuses calls to a withheld tool but keeps it listed, so the tool list — and the cache — never changes', async () => {
    const { ask, bodies } = scripted(calling({ id: 'j', name: 'list_pages' }), calling({ id: 'k', name: 'list_pages' }), saying('Fixed.'))
    const run = input({ ask, withheld: (turns) => new Set(turns.length > 2 ? [] : ['list_pages']) })

    await runLoop(run)

    const listed = bodies.map((body) => (body.tools as { name: string }[]).map((tool) => tool.name))

    expect(listed[0]).toContain('list_pages')
    expect(listed[1]).toEqual(listed[0])
    expect(run.turns[2]).toMatchObject({ results: [{ isError: true, content: [{ text: expect.stringContaining('Not yet') }] }] })
    expect(run.call).toHaveBeenCalledTimes(1)
  })

  it('leaves an unlisted tool out of the list, and answers a call to it as no such tool', async () => {
    const { ask, bodies } = scripted(calling({ id: 'j', name: 'join_blocks' }), saying('Left them.'))
    const run = input({ ask, withheld: () => new Set(['join_blocks']), unlisted: () => new Set(['join_blocks']) })

    await runLoop(run)

    expect((bodies[0]!.tools as { name: string }[]).map((tool) => tool.name)).not.toContain('join_blocks')
    expect(run.turns[2]).toMatchObject({ results: [{ isError: true, content: [{ text: 'There is no tool called join_blocks.' }] }] })
    expect(run.call).not.toHaveBeenCalled()
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

  it('counts the pictures a chapter run put in its message like a tool answer\'s', () => {
    const message: Turn = { role: 'user', text: 'Fix page 3.', parts: [{ type: 'image', data: 'review', mimeType: 'image/jpeg' }] }
    const [first] = forSending([message, pictured('2'), pictured('3')], seeing, 2)

    expect(first).toMatchObject({ role: 'user', parts: [{ type: 'text', text: expect.stringContaining('shown here earlier') }] })
    expect(forSending([message, pictured('2')], seeing, 2)[0]).toEqual(message)
  })

  const asked = (id: string, name: string, args: Record<string, unknown> = {}): Turn => ({ role: 'assistant', text: '', calls: [{ id, name, arguments: args }] })
  const answered = (id: string, name: string, text: string, isError = false): Turn => ({ role: 'tool', results: [{ callId: id, name, isError, content: [{ type: 'text', text }] }] })
  const textOf = (turns: Turn[], id: string) => turns.flatMap((turn) => (turn.role === 'tool' ? turn.results : [])).find((result) => result.callId === id)?.content.map((part) => (part.type === 'text' ? part.text : '')).join('')

  it('drops a page\'s review once the page is reviewed again, and keeps another page\'s', () => {
    const sent = forSending([
      asked('r1', 'review_lettering', { pageId: 4 }), answered('r1', 'review_lettering', 'first review'),
      asked('r2', 'review_lettering', { pageId: 5 }), answered('r2', 'review_lettering', 'other page'),
      asked('r3', 'review_lettering', { pageId: 4 }), answered('r3', 'review_lettering', 'second review'),
    ], seeing)

    expect(textOf(sent, 'r1')).toContain('Out of date')
    expect(textOf(sent, 'r2')).toBe('other page')
    expect(textOf(sent, 'r3')).toBe('second review')
  })

  it('drops a brief once its pages are saved, but not when the save failed or covered fewer pages', () => {
    const brief = [asked('b', 'prepare_page_translation', { pageIds: [1, 2] }), answered('b', 'prepare_page_translation', 'the brief')]

    expect(textOf(forSending([...brief, asked('s', 'save_page_translations', { pages: [{ pageId: 1 }, { pageId: 2 }] }), answered('s', 'save_page_translations', 'ok')], seeing), 'b')).toContain('Out of date')
    expect(textOf(forSending([...brief, asked('s', 'save_page_translations', { pages: [{ pageId: 1 }, { pageId: 2 }] }), answered('s', 'save_page_translations', '409', true)], seeing), 'b')).toBe('the brief')
    expect(textOf(forSending([...brief, asked('s', 'save_page_translations', { pages: [{ pageId: 1 }] }), answered('s', 'save_page_translations', 'ok')], seeing), 'b')).toBe('the brief')
  })

  it('keeps none for a model that cannot see, and says so', () => {
    const sent = forSending([pictured('1')], blind)

    expect(pictures(sent)).toEqual([])
    expect(JSON.stringify(sent)).toContain('cannot see pictures')
  })
})
