import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { StackLayer } from '#shared/utils/layers'

/**
 * Selecting a layer, and what the selection does when the stack moves under it.
 *
 * **Needs the nuxt project**, and only for this: `layerSelection` is a
 * `useState`, so it wants Nuxt's context. Nothing else here does.
 *
 * The division is worth stating, because it decides what belongs in this file
 * and what does not. Every question about the *tree* — where a dragged row
 * lands, what a clip attaches to, which row a brush stroke marks — is answered
 * by pure functions in `shared/utils/layers.ts` and tested in the sub-second
 * project. `useComic.moveLayer` is one line over `dropLayer` and has nothing of
 * its own to check.
 *
 * What is left is the *selection*, which is genuinely stateful and genuinely
 * easy to get wrong: a row that is added should become the one you are working
 * on, a row that is removed must not leave the app pointing at it, and a
 * chapter closing must not carry a selection into the next one. Those are
 * questions about a ref, not about a stack.
 *
 * Seam: `useComic`'s returned surface — `layerSelection`, `addPaintLayer`,
 * `addGroupLayer`, `addAdjustLayer`, `removeLayer`, `reset`. Not the internals.
 */

describe('adding a layer', () => {
  it.todo('selects the paint layer it just added')
  it.todo('selects the group it just added')
  it.todo('selects the adjustment it just added')
  it.todo('puts a new row beside the selection rather than at the end')
  it.todo('puts a new row at the top when nothing is selected')
})

describe('removing a layer', () => {
  it.todo('clears the selection when the removed row was the selected one')
  it.todo('leaves the selection alone when some other row was removed')
  it.todo('refuses to remove a row the stack cannot do without')
})

describe('the selection across a chapter', () => {
  it.todo('goes back to the dialogue row when a chapter is replaced')
  it.todo('does not carry a row id from one workspace into the next')
})

describe('the eye drag', () => {
  it.todo('sweeps visibility across the rows the pointer crosses')
  it.todo('takes its on-or-off from the row the drag began on')
  it.todo('leaves a locked row alone')
  it.todo('stops changing rows once the drag has ended')
})

/**
 * A stack belongs to its page, and the bug that says why this is tested.
 *
 * It was reported as "placed image appear on all pages", and the placed image
 * was only the messenger. `layers` was a single `useState` holding one stack
 * for the whole chapter, and the only thing that ever pointed it at a different
 * page was `useLayerSync.pull` — which returns immediately when the workspace
 * is not shared. So on a local chapter every page drew the same rows: a sheet
 * added to sketch over one panel, a group, an adjustment and a placed clean all
 * appeared on all three hundred pages at once.
 *
 * That is word for word the failure `DEFAULT_STACK`'s own header describes as
 * the reason a stack was moved onto `layers.pageId` — fixed on the server, and
 * the client had never caught up. Nothing failed loudly, because one stack
 * shown everywhere looks exactly like a stack that has been shared on purpose
 * until you put something on it that only belongs to one page.
 *
 * So these check the property rather than the mechanism: rows added on one page
 * are on that page, and are not on any other.
 */
/*
 * happy-dom hands out object URLs only for its own `Blob`, and a `File` built
 * from the global one is not that — the same stub `useComic.pages.test.ts` uses
 * and for the same reason. The URLs are not what these tests watch; they only
 * have to exist and be distinct.
 */
const platform = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL }

let issued = 0

beforeAll(() => {
  URL.createObjectURL = () => `blob:test/${issued++}`
  URL.revokeObjectURL = () => {}
})

afterAll(() => {
  URL.createObjectURL = platform.createObjectURL
  URL.revokeObjectURL = platform.revokeObjectURL
})

describe('a stack belongs to the page it is on', () => {
  const scan = (path: string) => ({ file: new File([new Uint8Array(8)], path, { type: 'image/jpeg' }), path })

  const twoPages = async () => {
    const comic = useComic()

    comic.reset()
    await comic.openImages([scan('1.jpg'), scan('2.jpg')])

    return comic
  }

  const labels = (rows: StackLayer[]): string[] =>
    rows.flatMap((row) => [row.label, ...labels(row.children ?? [])])

  it('founds every page with its own copy of the standard stack', async () => {
    const comic = await twoPages()

    expect(comic.pages.value.map((page) => page.stack?.length)).toEqual([4, 4])

    // Its own copy, not the same one: the whole bug was two pages sharing an
    // array, so identity is the thing worth asserting rather than shape.
    expect(comic.pages.value[0]!.stack).not.toBe(comic.pages.value[1]!.stack)
  })

  it('keeps a layer added on one page off the other', async () => {
    const comic = await twoPages()

    comic.go(0)
    comic.addPaintLayer()

    expect(labels(comic.pages.value[0]!.stack!)).toContain('Layer 1')
    expect(labels(comic.pages.value[1]!.stack!)).not.toContain('Layer 1')
  })

  /** The report itself, in the terms it was reported in. */
  it('keeps a placed image off every page but the one it was placed on', async () => {
    const comic = await twoPages()

    comic.go(0)
    comic.addImageLayer({
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ext: 'png',
      name: '1_clean.png',
      width: 877,
      height: 1240,
    })

    expect(labels(comic.pages.value[0]!.stack!)).toContain('1_clean')
    expect(labels(comic.pages.value[1]!.stack!)).not.toContain('1_clean')
  })

  it('shows each page its own rows as the reader turns between them', async () => {
    const comic = await twoPages()

    comic.go(1)
    comic.addPaintLayer()

    comic.go(0)

    expect(labels(comic.layers.value)).not.toContain('Layer 1')

    comic.go(1)

    expect(labels(comic.layers.value)).toContain('Layer 1')
  })

  it('hiding a plate on one page leaves the other page showing it', async () => {
    const comic = await twoPages()

    comic.go(0)
    comic.setLayer('clean', { visible: false })

    expect(findLayer(comic.pages.value[0]!.stack!, 'clean')!.visible).toBe(false)
    expect(findLayer(comic.pages.value[1]!.stack!, 'clean')!.visible).toBe(true)
  })

  it('takes a page\'s stack away with the page', async () => {
    const comic = await twoPages()

    comic.go(0)
    comic.addPaintLayer()
    comic.removePage('scan:1.jpg')

    expect(comic.pages.value).toHaveLength(1)
    expect(labels(comic.pages.value[0]!.stack!)).not.toContain('Layer 1')
  })
})

/**
 * A sheet's strokes go with the sheet.
 *
 * Deleting a sheet took the row out of the stack and left everything painted
 * on it in this browser's storage, filed under a surface nothing could open
 * again — found on page 6 of the large-page test chapter as a stroke log for a
 * sheet that was no longer in its stack. On a cloud workspace the server's copy
 * already went with the layer by cascade; this is the browser's half.
 */
describe('removing a sheet', () => {
  const scan = (path: string) => ({ file: new File([new Uint8Array(8)], path, { type: 'image/jpeg' }), path })

  const stroke = (seq: number) => ({
    seq,
    clientId: 'test',
    tool: 'brush',
    composite: null,
    params: { size: 20, softness: 0, colour: '#ffffff' },
    points: [10, 10, 40, 10],
    x: 0,
    y: 0,
    w: 50,
    h: 20,
  })

  it('lets go of the strokes painted on it, and of nothing else', async () => {
    const comic = useComic()

    comic.reset()
    await comic.openImages([scan('1.jpg')])
    comic.go(0)
    comic.pages.value[0]!.scan!.hash = 'h1'

    const sheet = comic.addPaintLayer()
    const paint = usePaintCache()

    paint.add(`h1:${sheet}`, stroke(1))
    paint.add('h1:bg', stroke(2))

    comic.removeLayer(sheet)

    expect(paint.on(`h1:${sheet}`)).toEqual([])
    expect(paint.on('h1:bg')).toHaveLength(1)
  })

  it('lets go of the strokes on every sheet inside a group removed with it', async () => {
    const comic = useComic()

    comic.reset()
    await comic.openImages([scan('1.jpg')])
    comic.go(0)
    comic.pages.value[0]!.scan!.hash = 'h2'

    const sheet = comic.addPaintLayer()
    const group = comic.addGroupLayer()

    comic.moveLayer(sheet, group, 'inside')

    // Inside the group now, so it goes because the group does.
    expect(findLayer(comic.layers.value, group)!.children?.map((row) => row.id)).toContain(sheet)

    const paint = usePaintCache()

    paint.add(`h2:${sheet}`, stroke(1))
    comic.removeLayer(group)

    expect(paint.on(`h2:${sheet}`)).toEqual([])
  })
})
