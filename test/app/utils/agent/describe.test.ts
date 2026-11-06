import { describe, expect, it } from 'vitest'

import { describeCall } from '~/utils/agent/describe'

/**
 * A tool call in the reader's words. What is worth pinning is the pages a call
 * names, said the way a reader counts them, and that a tool the panel does not
 * know is still shown — by its name — rather than not at all.
 */

const call = (name: string, args: Record<string, unknown> = {}) => describeCall({ id: 'c', name, arguments: args })

describe('a tool call in the reader\'s words', () => {
  it('names the page, a run of pages, or the page on screen', () => {
    expect(call('review_lettering', { pageId: 7 }).done).toBe('Reviewed the lettering of page 7')
    expect(call('read_page', { pageIds: [5, 3, 4] }).done).toBe('Read pages 3–5')
    expect(call('read_page', { pageIds: [2, 9] }).done).toBe('Read 2 pages')
    expect(call('review_lettering').doing).toBe('Reviewing the lettering of the page on screen')
  })

  it('counts what a write changes', () => {
    expect(call('set_lettering_style', { pageId: 7, frames: [{}, {}] })).toMatchObject({ done: 'Restyled 2 lines', detail: 'page 7', kind: 'letter' })
    expect(call('correct_blocks', { corrections: [{}] }).done).toBe('Corrected 1 block')
  })

  it('shows a tool it does not know by its name', () => {
    expect(call('brand_new_tool')).toEqual({ doing: 'brand_new_tool', done: 'brand_new_tool', kind: 'other' })
  })
})
