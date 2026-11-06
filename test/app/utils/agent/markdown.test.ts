import { describe, expect, it } from 'vitest'

import { inline, markdown } from '~/utils/agent/markdown'

/**
 * The little Markdown a reply uses. What matters is that the marks a model
 * writes come out as marks, and that nothing it writes is lost — what is not
 * understood stays text.
 */

describe('a reply\'s Markdown', () => {
  it('reads bold, italics and code inside a line', () => {
    expect(inline('There is **one page** and `pageId` _here_.')).toEqual([
      { type: 'text', text: 'There is ' },
      { type: 'strong', text: 'one page' },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'pageId' },
      { type: 'text', text: ' ' },
      { type: 'em', text: 'here' },
      { type: 'text', text: '.' },
    ])
  })

  it('leaves a lone mark as it is', () => {
    expect(inline('2 * 3 = 6')).toEqual([{ type: 'text', text: '2 * 3 = 6' }])
  })

  it('reads paragraphs, lists, a heading and a fence', () => {
    const blocks = markdown('## Done\n\nFixed:\n- block 13\n- block 14\n\n1. one\n2. two\n\n```\n{"a":1}\n```\nAfter.')

    expect(blocks.map((block) => block.type)).toEqual(['h', 'p', 'ul', 'ol', 'code', 'p'])
    expect(blocks[2]).toEqual({ type: 'ul', items: [[{ type: 'text', text: 'block 13' }], [{ type: 'text', text: 'block 14' }]] })
    expect(blocks[4]).toEqual({ type: 'code', text: '{"a":1}' })
  })
})
