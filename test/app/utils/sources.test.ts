import { describe, expect, it } from 'vitest'

import type { Source } from '~/utils/images'

import { imagesOf } from '~/utils/images'

/**
 * A chapter kept by its sources, read out of them again — desktop only.
 *
 * What matters is that each file comes back as the page it was: a page's id is
 * `scan:<path>`, and the reading, order, names and history of a chapter hang off
 * it. So a file comes back under the path it was dropped as, a folder's pages
 * under its prefix and their own path within it, and a source that has gone is
 * one source missing rather than a chapter that will not open.
 *
 * Seam: the handles. A file handle is something with `getFile`; a folder
 * handle, something whose `values()` lists its entries — which is all
 * `imagesOf` asks of either.
 */

const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

function fileHandle (name: string, gone = false) {
  return {
    kind: 'file',
    name,
    getFile: async () => {
      if (gone) throw new DOMException('A requested file or directory could not be found.', 'NotFoundError')

      return png(name)
    },
  } as unknown as FileSystemFileHandle
}

function folderHandle (name: string, entries: (FileSystemFileHandle | FileSystemDirectoryHandle)[]) {
  return {
    kind: 'directory',
    name,
    async * values () { yield * entries },
  } as unknown as FileSystemDirectoryHandle
}

describe('imagesOf', () => {
  it('gives every page back under the path it arrived as, in reading order', async () => {
    const sources: Source[] = [
      { kind: 'file', handle: fileHandle('10.png'), path: '10.png' },
      { kind: 'folder', handle: folderHandle('more', [fileHandle('14.png'), folderHandle('deeper', [fileHandle('2.png')]), fileHandle('13.png')]), prefix: 'more/' },
      { kind: 'file', handle: fileHandle('9.png'), path: '9.png' },
    ]

    const found = await imagesOf(sources)

    expect(found.images.map((image) => image.path)).toEqual(['9.png', '10.png', 'more/13.png', 'more/14.png', 'more/deeper/2.png'])
    expect(found.missing).toBe(0)
  })

  it('counts a file that has gone, and still gives the rest', async () => {
    const sources: Source[] = [
      { kind: 'file', handle: fileHandle('1.png'), path: '1.png' },
      { kind: 'file', handle: fileHandle('2.png', true), path: '2.png' },
      { kind: 'file', handle: fileHandle('3.png'), path: '3.png' },
    ]

    const found = await imagesOf(sources)

    expect(found.images.map((image) => image.path)).toEqual(['1.png', '3.png'])
    expect(found.missing).toBe(1)
  })

  it('counts a folder that has emptied as missing', async () => {
    const found = await imagesOf([{ kind: 'folder', handle: folderHandle('gone', []), prefix: 'gone/' }])

    expect(found.images).toEqual([])
    expect(found.missing).toBe(1)
  })
})
