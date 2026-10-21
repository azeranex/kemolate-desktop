import { describe, expect, it } from 'vitest'

import type { RemotePage } from '~/composables/useShared'

import { pathOfPage, rowOfPage, withAbsent } from '~/composables/useShared'

/**
 * What a chapter looks like when its pictures are somewhere else.
 *
 * This is the rule that decides whether a workspace's page is on screen at all,
 * and it has to agree exactly with `rowOfPage` — the rule that decides which
 * row a page *is*. The two disagreeing is not a visible bug in either of them:
 * it is a chapter that quietly holds two of every page, or one that hides a
 * page the reader is looking for, and both take a second computer and a real
 * folder to reproduce by hand. Cheap to state here, expensive to find there.
 *
 * The case underneath all of them is the one that prompted the feature: a
 * dropped file now adds a page in its own right rather than being matched to
 * whatever row holds the same picture, so a second machine can no longer get
 * its pictures back by dropping the folder in. It gets them back by the pages
 * being *shown*, and handed a file one at a time.
 */

function row (over: Partial<RemotePage> & { id: number, uid: string }): RemotePage {
  return {
    path: `${over.uid}.png`,
    name: `${over.uid}.png`,
    position: over.id,
    hash: `hash-${over.uid}`,
    width: 1600,
    height: 2400,
    ...over,
  }
}

/** A page this browser holds the file for, hashed unless told otherwise. */
function held (over: Partial<ComicPage> & { id: string }, hash: string | null = 'hash-a'): ComicPage {
  return {
    name: over.id,
    blocks: [],
    scan: { url: 'blob:x', file: new File([], 'x'), width: 1600, height: 2400, hash },
    ...over,
  }
}

describe('withAbsent', () => {
  it('shows every page of a chapter no file here accounts for', () => {
    const rows = [row({ id: 1, uid: 'a' }), row({ id: 2, uid: 'b' })]

    const next = withAbsent(rows, [])

    expect(next).toHaveLength(2)
    expect(next!.map((page) => page.uid)).toEqual(['a', 'b'])
    // Absent, and saying so by having no scan — which is what every gate in the
    // canvas and the page list reads.
    expect(next!.every(isOffline)).toBe(true)
  })

  /**
   * The size is not decoration. A block is a share of the page box, so a page
   * drawn at the usual proportions when it is really something else has every
   * balloon in the wrong place — and the workspace's record is the only thing
   * that knows the shape when there is no file to measure.
   */
  it('carries the shape and the chapter’s path onto a page it invents', () => {
    const [page] = withAbsent([row({ id: 1, uid: 'a', path: 'vol2/007.png', width: 1200, height: 1700 })], [])!

    expect(page!.size).toEqual({ width: 1200, height: 1700 })
    expect(pathOfPage(page!)).toBe('vol2/007.png')
  })

  it('leaves a row alone when a file here already stands for it', () => {
    const rows = [row({ id: 1, uid: 'a' }), row({ id: 2, uid: 'b' })]

    const next = withAbsent(rows, [held({ id: 'scan:a.png', uid: 'a' })])

    expect(next).toHaveLength(2)
    expect(next!.filter(isOffline).map((page) => page.uid)).toEqual(['b'])
  })

  /**
   * The same question `rowOfPage` answers, asked from the other side: a page
   * that has not been named yet is recognised by its bytes. Getting this wrong
   * would lay a second, empty copy of the chapter over the one on screen.
   */
  it('recognises a held page by its hash before it has been given a uid', () => {
    const rows = [row({ id: 1, uid: 'a', hash: 'hash-a' })]

    const page = held({ id: 'scan:whatever-they-called-it.png' }, 'hash-a')

    expect(rowOfPage(rows, page)?.uid).toBe('a')
    expect(withAbsent(rows, [page])).toBeNull()
  })

  /**
   * Hashing runs in the background long after the pages are on screen. Judging
   * during that window declares every chapter absent — including the one the
   * pages plainly belong to.
   */
  it('says nothing while a file here has not been identified', () => {
    const rows = [row({ id: 1, uid: 'a' })]

    expect(withAbsent(rows, [held({ id: 'scan:a.png' }, null)])).toBeNull()
  })

  it('takes the absent page away once its file turns up', () => {
    const rows = [row({ id: 1, uid: 'a' })]

    const [absent] = withAbsent(rows, [])!

    // The same page, now holding the file — which is what `attach` does to it.
    const linked = { ...absent!, scan: held({ id: absent!.id }).scan }

    expect(withAbsent(rows, [linked])).toBeNull()
  })

  it('takes an absent page away when the workspace stops holding its row', () => {
    const rows = [row({ id: 1, uid: 'a' }), row({ id: 2, uid: 'b' })]

    const both = withAbsent(rows, [])!

    expect(withAbsent([rows[0]!], both)).toEqual([expect.objectContaining({ uid: 'a' })])
  })

  it('puts the chapter in the workspace’s order, not the order it arrived in', () => {
    const rows = [
      row({ id: 1, uid: 'a', position: 2 }),
      row({ id: 2, uid: 'b', position: 0 }),
      row({ id: 3, uid: 'c', position: 1 }),
    ]

    expect(withAbsent(rows, [])!.map((page) => page.uid)).toEqual(['b', 'c', 'a'])
  })

  /**
   * The ordering bug this feature shipped with for an hour, and the reason the
   * place a page belongs is asked of `rowOfPage` rather than of its uid.
   *
   * A page read off a folder has no uid until a push comes back with one. An
   * absent page is invented from a row and so is named from birth. Sorting on
   * uids alone therefore gave every absent page its real position and every
   * page actually here no position at all — so on the way in, the missing pages
   * sorted to the front and the chapter looked shuffled.
   */
  it('interleaves absent pages with held ones that have not been named yet', () => {
    const rows = [
      row({ id: 1, uid: 'a', position: 0, hash: 'hash-a' }),
      row({ id: 2, uid: 'gap', position: 1, hash: 'nobody-here-has-this' }),
      row({ id: 3, uid: 'c', position: 2, hash: 'hash-c' }),
    ]

    // Neither has a uid: this is the browser that has just opened the folder.
    const mine = [
      held({ id: 'scan:c.png' }, 'hash-c'),
      held({ id: 'scan:a.png' }, 'hash-a'),
    ]

    expect(withAbsent(rows, mine)!.map((page) => page.name))
      .toEqual(['scan:a.png', 'gap.png', 'scan:c.png'])
  })

  /**
   * A page dropped in is a page in its own right and the workspace has not
   * heard of it yet, so it has no row and no position. Sinking it below
   * everything the chapter does know is the same rule `align` and `applyMeta`
   * follow; dropping it would be losing work the reader can see.
   */
  it('keeps a page the workspace has not heard of, below the ones it has', () => {
    const rows = [row({ id: 1, uid: 'a', position: 0 })]

    const mine = held({ id: 'scan:new.png', uid: 'freshly-minted' }, 'hash-new')

    const next = withAbsent([...rows, row({ id: 2, uid: 'b', position: 1 })], [mine])!

    expect(next.map((page) => page.uid)).toEqual(['a', 'b', 'freshly-minted'])
  })

  /**
   * Two blank pages of a chapter are byte-identical, which is the case `uid`
   * exists for. One hash naming two rows must name neither, or one file would
   * account for both and the second page would never be shown as absent.
   */
  it('does not let one file account for two rows that share a hash', () => {
    const rows = [
      row({ id: 1, uid: 'a', hash: 'same', path: 'blank-1.png' }),
      row({ id: 2, uid: 'b', hash: 'same', path: 'blank-2.png' }),
    ]

    const next = withAbsent(rows, [held({ id: 'scan:blank-1.png' }, 'same')])!

    // Matched by path, which is the only thing left that tells them apart.
    expect(next.filter(isOffline).map((page) => page.uid)).toEqual(['b'])
  })

  it('has nothing to say about a workspace with no pages of its own', () => {
    expect(withAbsent([], [held({ id: 'scan:a.png' })])).toBeNull()
  })
})
