import { describe, expect, it } from 'vitest'

import type { Turn } from '~/utils/agent/messages'

import { CHAPTER_TRANSLATE, chapterLetter, withheld } from '~/utils/agent/prompt'

/**
 * Which tools the assistant is held back from, by what the conversation holds.
 *
 * Joining is the case worth pinning: asked to fix lettering, the assistant
 * merged blocks the reader wanted kept, so `join_blocks` waits for the reader's
 * own words.
 */

const said = (text: string): Turn => ({ role: 'user', text })
const readTopic = (topic: string): Turn => ({ role: 'assistant', text: '', calls: [{ id: topic, name: 'read_playbook', arguments: { topic } }] })

describe('what the assistant is held back from', () => {
  it('holds joining back even once the reading chapter is read, until the reader asks', () => {
    expect(withheld([said('Fix the lettering on this page.'), readTopic('reading')])).toContain('join_blocks')
    expect(withheld([said('Fix the lettering on this page.'), readTopic('reading')])).not.toContain('split_block')
    expect(withheld([said('Merge blocks 4 and 5, they are one balloon.'), readTopic('reading')])).not.toContain('join_blocks')
  })

  it('never offers joining to a chapter run', () => {
    expect(withheld([said(CHAPTER_TRANSLATE), readTopic('reading')])).toContain('join_blocks')
    expect(withheld([said(chapterLetter({ pageId: 3, name: '03.jpg' })), readTopic('reading')])).toContain('join_blocks')
  })

  it('offers a topic\'s tools once it is read', () => {
    expect(withheld([said('Go.')])).toContain('set_lettering_style')
    expect(withheld([said('Go.'), readTopic('lettering')])).not.toContain('set_lettering_style')
  })
})
