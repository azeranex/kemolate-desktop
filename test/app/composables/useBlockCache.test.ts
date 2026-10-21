import { describe, expect, it } from 'vitest'

import { localise, localSurface } from '~/composables/useBlockCache'

/**
 * The one thing this cache must never keep: a server row id.
 *
 * It is filed under the scan's hash rather than under a workspace, so the same
 * entry is read back in whatever workspace the same page turns up in — and a
 * block's id *is* its row when it has one (`block:41`, which `rowOf` parses).
 * Holding both at once is a contradiction, and it failed in the quietest way
 * available: the restored blocks looked perfect, `useBlockSync.rowless` saw
 * nothing needing a row so never made any, and every edit patched a row
 * belonging to another workspace's page. Twenty-five `404 No such block`, no
 * toast, and a reading nobody could save a word of.
 *
 * Nothing in the running app fails loudly if this regresses, which is exactly
 * why it is worth a test.
 */
function block (id: string, extra: Partial<Block> = {}): Block {
  return {
    id,
    type: 'bubble',
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    source: 'ゲンガー',
    translation: '',
    confidence: 90,
    hidden: false,
    ...extra,
  }
}

describe('localise', () => {
  it('renames a block that claims a server row', () => {
    const [out] = localise([block('block:41')])

    expect(out!.id).not.toBe('block:41')
    expect(rowOf(out!)).toBeNull()
  })

  it('leaves a block that never had one alone', () => {
    const [out] = localise([block('read:abc12345:0')])

    expect(out!.id).toBe('read:abc12345:0')
  })

  it('reaches the children of a joined balloon', () => {
    // A balloon carries its columns, and each of those is a row of its own —
    // so a tree stripped only at the top still hands back foreign row ids.
    const [out] = localise([block('block:7', {
      children: [block('block:8'), block('block:9')],
    })])

    expect(rowOf(out!)).toBeNull()
    expect(out!.children?.map(rowOf)).toEqual([null, null])
  })

  it('keeps everything that is not the name', () => {
    const [out] = localise([block('block:41', { translation: 'Gengar', hidden: true })])

    expect(out).toMatchObject({ source: 'ゲンガー', translation: 'Gengar', hidden: true, w: 3 })
  })

  it('gives two blocks two names', () => {
    const out = localise([block('block:41'), block('block:42')])

    expect(out[0]!.id).not.toBe(out[1]!.id)
  })

  /*
   * The same name every time. It was a fresh random one per call, and this runs
   * on every write of the cache — so a workspace moved back to local renamed
   * its blocks on disk each time one was saved, and a mask correction filed
   * under a block's name could never follow it there.
   */
  it('names a block the same way every time, and says which name became which', () => {
    const renamed = new Map<string, string>()
    const [once] = localise([block('block:41', { children: [block('block:42')] })], renamed)
    const [twice] = localise([block('block:41')])

    expect(once!.id).toBe(twice!.id)
    expect([...renamed]).toEqual([['block:41', once!.id], ['block:42', once!.children![0]!.id]])
  })

  it('files a block\'s mask corrections under the name it is given', () => {
    const [out] = localise([block('block:41')])

    expect(localSurface('mask-41')).toBe(`mask-${out!.id}`)
    expect(localSurface('bg')).toBe('bg')
    expect(localSurface(`mask-${out!.id}`)).toBe(`mask-${out!.id}`)
  })
})

/**
 * The reading, kept between visits — and the one cache here that is not purely
 * content-addressed.
 *
 * Everything else derived from a scan is filed under its hash alone, because
 * the same page found again anywhere is the same work found again. A *reading*
 * is not: two workspaces can hold the same page and disagree about what is on
 * it, and one of them may be somebody else's chapter entirely. So the key
 * carries the workspace as well, and that asymmetry is the thing worth pinning
 * — it is invisible from any single call site.
 *
 * The empty-list rule below is the one with recent history. Restoring an empty
 * cached list over a page that has blocks would read, one layer along, as every
 * one of those rows having just been deleted — and `useBlockSync` would send a
 * DELETE for each. The guard exists; nothing says so.
 */

describe('the key', () => {
  it.todo('files a reading under the workspace and the scan together')
  it.todo('keeps two workspaces holding the same page apart')
  it.todo('reads back a page moved to a new position under the same hash')
})

describe('restoring', () => {
  it.todo('fills a page that has nothing on it')
  it.todo('leaves a page that already has blocks alone')
  it.todo('leaves a page that gained blocks while the lookup was in flight alone')
  it.todo('refuses to apply an empty cached list over a page')
  it.todo('ignores an entry written by a newer version of the app')
  it.todo('adopts the pre-workspace entry for a page, once')
})

describe('writing', () => {
  it.todo('keeps a page emptied on purpose, because that is a reading too')
  it.todo('writes nothing for a page whose scan has not been hashed yet')
})
