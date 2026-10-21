import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

/**
 * Adding pages, removing them, and what happens to the page you were reading.
 *
 * **Needs the nuxt project** for `useComic`'s state.
 *
 * A chapter is a list a reader edits while standing in the middle of it, which
 * is where most of the trouble comes from. Removing a page changes what `at`
 * points at; appending pages slots them among the ones already there rather
 * than at the end, so the page being read has to be found again *by id* or the
 * canvas shuffles out from under whoever is reading it. Both of those are easy
 * to get subtly wrong and neither throws when it is.
 *
 * The object URL is the other recurring hazard, and it bit today: a URL is a
 * claim on a file that outlives everything but the document, and only three
 * places let one go — `removePage`, `openImages` and `reset`. Revoke one too
 * early and the page renders blank with no error anywhere; forget one and a
 * session of opening chapters holds every file it ever saw.
 *
 * Seam: `useComic`'s returned surface — `pages`, `at`, `appendImages`,
 * `addBlankPage`, `removePage`, `movePage`, `renamePage`.
 */

describe('appending', () => {
  it.todo('slots a page in where its path says rather than at the end')
  it.todo('keeps the page being read under the reader, by id and not by index')
  it.todo('adds a page that arrives after the chapter is already open')
  it.todo('measures a page that arrived without dimensions, without blocking the others')
  it.todo('ignores a file that is already open under the same path')
})

/**
 * A canvas that draws nothing but hands back a file, because happy-dom has no
 * 2D context and `addBlankPage` gives up without one. What a blank *contains*
 * is `blankImage`'s business and is tested in `test/app/utils/images.test.ts`;
 * what is watched here is only what it ends up called.
 */
const platform = {
  getContext: HTMLCanvasElement.prototype.getContext,
  toBlob: HTMLCanvasElement.prototype.toBlob,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
}

let issued = 0

beforeAll(() => {
  // happy-dom hands out object URLs only for its own `Blob`, and a `File` built
  // from the global one is not that. The URLs are not what these tests watch;
  // they only have to exist, be distinct, and be lettable-go-of.
  URL.createObjectURL = () => `blob:test/${issued++}`
  URL.revokeObjectURL = () => {}

  HTMLCanvasElement.prototype.getContext = function (kind: string) {
    return kind === '2d' ? { fillStyle: '', fillRect: () => {} } : null
  } as unknown as typeof platform.getContext

  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
    callback(new Blob([new Uint8Array(8)], { type: 'image/png' }))
  } as unknown as typeof platform.toBlob
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = platform.getContext
  HTMLCanvasElement.prototype.toBlob = platform.toBlob
  URL.createObjectURL = platform.createObjectURL
  URL.revokeObjectURL = platform.revokeObjectURL
})

describe('a blank page', () => {
  const scan = (path: string) => ({ file: new File([new Uint8Array(8)], path, { type: 'image/jpeg' }), path })

  beforeEach(() => useComic().reset())

  it.todo('adds a page the size of the chapter it joins')
  it.todo('adds it after the page being read')
  it.todo('gives it a name that does not collide with a scan\'s')

  /*
   * The failure both of these describe: adding a blank turns to it, so the
   * second add stands on the first blank. Numbered against whatever page is
   * underfoot, that second blank called itself `blank-1` all over again and
   * stayed distinct only by nesting — `1.jpg.blank-1.png.blank-1.png`, and a
   * suffix longer for every page after that.
   */
  it('numbers a blank against the page it follows, not against the blank underfoot', async () => {
    const comic = useComic()

    await comic.openImages([scan('1.jpg'), scan('2.jpg')])
    await comic.addBlankPage()
    await comic.addBlankPage()

    expect(comic.pages.value.map((page) => page.id)).toEqual([
      'scan:1.jpg',
      'scan:1.jpg.blank-1.png',
      'scan:1.jpg.blank-2.png',
      'scan:2.jpg',
    ])
  })

  it('does not hand a blank a number the chapter is already using', async () => {
    const comic = useComic()

    await comic.openImages([scan('1.jpg')])
    await comic.addBlankPage()
    await comic.addBlankPage()

    comic.removePage('scan:1.jpg.blank-1.png')

    comic.go(0)

    await comic.addBlankPage()

    expect(comic.pages.value.map((page) => page.id)).toEqual([
      'scan:1.jpg',
      'scan:1.jpg.blank-3.png',
      'scan:1.jpg.blank-2.png',
    ])
  })
})

describe('removing', () => {
  it.todo('takes the page out of the list')
  it.todo('lets go of its object URL')
  it.todo('does not let go of any other page\'s')
  it.todo('keeps the reader on the same page when an earlier one is removed')
  it.todo('steps back when the page being read is the one removed')
  it.todo('handles removing the last page without leaving `at` past the end')
  it.todo('handles removing the only page')
  it.todo('clears the selection when the page holding it goes')
})

describe('moving and renaming', () => {
  it.todo('moves a page to a new position')
  it.todo('keeps the reader on the page they were on, wherever it moved to')
  it.todo('renames a page without changing its identity')
  it.todo('leaves the blocks on a page alone through both')
})

describe('the order and names a reader chose', () => {
  it.todo('remembers a reordering across a reload')
  it.todo('remembers a renaming across a reload')
  it.todo('does not remember a page the reader removed')
  it.todo('leaves no entry behind for a page that is gone')
})

/**
 * A page is called what it is, not what its file is kept as.
 *
 * A chapter kept as a copy in the browser's own storage is filed under each
 * page's whole path, encoded, and reads back under that name — so it reopened
 * with pages called `Chapter%2012%2F001.jpg`. `readBack` now says what each is
 * called (`PickedImage.name`), and opening takes that over the file's name.
 */
describe('naming a page', () => {
  beforeEach(() => useComic().reset())

  it('takes the name it was given over the name its file is kept under', async () => {
    const comic = useComic()
    const file = new File([new Uint8Array(8)], 'Chapter%2012%2F001.jpg', { type: 'image/jpeg' })

    await comic.openImages([{ file, path: 'Chapter 12/001.jpg', name: '001.jpg' }])

    expect(comic.pages.value[0]!.name).toBe('001.jpg')
  })

  it('is called what its file is called where nothing says otherwise', async () => {
    const comic = useComic()
    const file = new File([new Uint8Array(8)], '002.jpg', { type: 'image/jpeg' })

    await comic.openImages([{ file, path: 'Chapter 12/002.jpg' }])

    expect(comic.pages.value[0]!.name).toBe('002.jpg')
  })
})

/**
 * The selection only ever names blocks that are there to be picked.
 *
 * Held by two watchers that are now made once for the tab rather than once per
 * `useComic()` call — see `upkeep` — so this pins that they still run, however
 * many callers there are and wherever the first of them was.
 */
describe('the selection', () => {
  beforeEach(() => useComic().reset())

  it('lets go of a block that is taken off the page, and of the key with it', async () => {
    for (let i = 0; i < 5; i++) useComic()

    const comic = useComic()

    comic.pages.value = [{
      id: 'scan:1.jpg',
      name: '1.jpg',
      size: { width: 1000, height: 1400 },
      blocks: ['a', 'b'].map((id, i) => ({ id, type: 'bubble' as const, x: i * 20, y: 10, w: 10, h: 10, source: id, translation: '', confidence: 100, hidden: false })),
    } as unknown as ComicPage]
    comic.go(0)
    comic.selection.value = ['a', 'b']
    comic.keyed.value = 'a'

    comic.removeBlock('a')
    await nextTick()
    await nextTick()

    expect(comic.selection.value).toEqual(['b'])
    expect(comic.keyed.value).toBeNull()
  })
})

/**
 * A chapter opens on the page it is asked to.
 *
 * It used to open on page one and turn to the kept page a moment later. That
 * turn was a decode of page one thrown away on every reload, and page one's
 * image, landing late, gave the page that replaced it page one's size — which
 * on a chapter of different-sized pages saved its lettering out of place.
 */
describe('opening a chapter', () => {
  beforeEach(() => useComic().reset())

  const picked = (path: string) => ({ file: new File([new Uint8Array(8)], path, { type: 'image/png' }), path })

  it('starts on the page named, not on page one', async () => {
    const comic = useComic()

    await comic.openImages([picked('1.png'), picked('2.png'), picked('11.png')], undefined, 'scan:11.png')

    expect(comic.page.value?.id).toBe('scan:11.png')
  })

  it('starts on page one when the named page is not in it', async () => {
    const comic = useComic()

    await comic.openImages([picked('1.png'), picked('2.png')], undefined, 'scan:gone.png')

    expect(comic.at.value).toBe(0)
  })
})
