import { describe, expect, it } from 'vitest'

import type { ArchiveSource, Source } from '~/utils/images'

import { archivePage, archiveSource, imagesOf, withoutPage } from '~/utils/images'
import { zip, zipIndex } from '~/utils/zip'

/**
 * A project file's scans read in place — desktop only.
 *
 * Opening a `.kemolate` used to copy every scan out of it into OPFS, so a
 * chapter sat on the disk twice. Its entries are stored, never deflated, so a
 * scan is a byte range of the archive and is kept as one (`ArchiveSource`).
 * What would go wrong quietly:
 *
 * - **The range is off.** A page that decodes to almost the right thing, or a
 *   hash that matches nothing in the workspace. So the bytes are compared.
 * - **The archive is saved over.** Ranges into a different file are pages of
 *   somebody else's bytes; the pages must be found again by name instead.
 * - **The archive is gone.** Every page of it is missing — counted, so the
 *   chapter opens with its pages absent rather than refusing.
 * - **The same page differs between the import and a reopen.** The hash memo is
 *   keyed on name, size and modified time, so `archivePage` must make the same
 *   `File` both times, named by path so two `001.jpg`s do not share a memo.
 *
 * Seam: a real archive from `zip`, and a file handle that is something with
 * `getFile` — all `imagesOf` asks of one.
 */

const bytes = (text: string) => new TextEncoder().encode(text)

async function project (pages: Record<string, string>, extra: { name: string, data: Blob, deflate?: boolean }[] = []) {
  const blob = await zip([
    { name: 'project.json', data: new Blob(['{}']), deflate: true },
    ...Object.entries(pages).map(([path, text]) => ({ name: `pages/${path}`, data: new Blob([bytes(text)]) })),
    ...extra,
  ])

  return new File([blob], 'chapter.kemolate', { lastModified: 1_700_000_000_000 })
}

function handleOn (read: () => File) {
  return { kind: 'file', name: 'chapter.kemolate', getFile: async () => read() } as unknown as FileSystemFileHandle
}

const wanted = (...paths: string[]) => paths.map((path) => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  entry: `pages/${path}`,
  type: '',
}))

describe('zipIndex', () => {
  it('says where each stored entry’s bytes are in the archive', async () => {
    const archive = await project({ '001.jpg': 'first page', 'ch2/002.jpg': 'second' })
    const index = await zipIndex(archive)
    const page = index.find((entry) => entry.name === 'pages/ch2/002.jpg')!

    expect(page.stored).toBe(true)
    expect(await archive.slice(page.start, page.start + page.length).text()).toBe('second')
    expect(index.find((entry) => entry.name === 'project.json')!.stored).toBe(false)
  })
})

describe('archiveSource', () => {
  it('keeps each page as its range of the archive', async () => {
    const archive = await project({ '001.jpg': 'first page', '002.jpg': 'second' })
    const source = (await archiveSource(handleOn(() => archive), archive, wanted('001.jpg', '002.jpg')))!

    expect(source.size).toBe(archive.size)
    expect(source.lastModified).toBe(archive.lastModified)
    expect(await Promise.all(source.pages.map((page) => archivePage(archive, page).file.text()))).toEqual(['first page', 'second'])
  })

  it('refuses a scan that was deflated, which has no range to keep', async () => {
    const archive = await project({}, [{ name: 'pages/001.jpg', data: new Blob(['squashed']), deflate: true }])

    expect(await archiveSource(handleOn(() => archive), archive, wanted('001.jpg'))).toBeNull()
  })
})

describe('archivePage', () => {
  it('names the file by its whole path, so two pages called 001 do not share a memo', async () => {
    const archive = await project({ 'a/001.jpg': 'aaaa', 'b/001.jpg': 'bbbb' })
    const source = (await archiveSource(handleOn(() => archive), archive, wanted('a/001.jpg', 'b/001.jpg')))!
    const [a, b] = source.pages.map((page) => archivePage(archive, page))

    expect(a!.file.name).toBe('a/001.jpg')
    expect(b!.file.name).toBe('b/001.jpg')
    expect(a!.name).toBe('001.jpg')
    expect(a!.file.lastModified).toBe(archive.lastModified)
  })
})

describe('imagesOf, on a project file', () => {
  it('reads the pages back out of the archive, beside other sources, in reading order', async () => {
    const archive = await project({ '002.jpg': 'two', '010.jpg': 'ten' })
    const source = (await archiveSource(handleOn(() => archive), archive, wanted('002.jpg', '010.jpg')))!
    const loose = { kind: 'file', getFile: async () => new File([bytes('nine')], '009.png', { type: 'image/png' }) } as unknown as FileSystemFileHandle

    const found = await imagesOf([source, { kind: 'file', handle: loose, path: '009.png' }])

    expect(found.images.map((image) => image.path)).toEqual(['002.jpg', '009.png', '010.jpg'])
    expect(await Promise.all(found.images.map((image) => image.file.text()))).toEqual(['two', 'nine', 'ten'])
    expect(found.missing).toBe(0)
  })

  it('counts every page of a project file that has gone as missing', async () => {
    const archive = await project({ '001.jpg': 'one', '002.jpg': 'two' })
    const source = (await archiveSource(handleOn(() => archive), archive, wanted('001.jpg', '002.jpg')))!
    const gone: ArchiveSource = {
      ...source,
      handle: { kind: 'file', getFile: async () => { throw new DOMException('gone', 'NotFoundError') } } as unknown as FileSystemFileHandle,
    }

    const found = await imagesOf([gone])

    expect(found.images).toEqual([])
    expect(found.missing).toBe(2)
  })

  it('finds the pages again by name in an archive that was saved over', async () => {
    const before = await project({ '001.jpg': 'one', '002.jpg': 'two' })
    const source = (await archiveSource(handleOn(() => before), before, wanted('001.jpg', '002.jpg')))!

    // Saved again with something in front of the pages, so every range moved,
    // and without page two.
    const after = new File([await project({ '000.jpg': 'a page put in front', '001.jpg': 'one, cleaner' })], 'chapter.kemolate', { lastModified: 1_800_000_000_000 })

    const found = await imagesOf([{ ...source, handle: handleOn(() => after) }])

    expect(found.images.map((image) => image.path)).toEqual(['001.jpg'])
    expect(await found.images[0]!.file.text()).toBe('one, cleaner')
    expect(found.missing).toBe(1)
  })
})

describe('withoutPage', () => {
  it('takes one page out of an archive, and the archive with its last page', async () => {
    const archive = await project({ '001.jpg': 'one', '002.jpg': 'two' })
    const source = (await archiveSource(handleOn(() => archive), archive, wanted('001.jpg', '002.jpg')))!

    const once = withoutPage([source], '001.jpg')

    expect(once.held).toBe(true)
    expect((once.sources[0] as ArchiveSource).pages.map((page) => page.path)).toEqual(['002.jpg'])
    expect(withoutPage(once.sources, '002.jpg')).toEqual({ sources: [], held: true })
  })

  it('leaves a folder alone and says nothing held the page by name', () => {
    const folder: Source = { kind: 'folder', handle: {} as FileSystemDirectoryHandle, prefix: 'ch/' }

    expect(withoutPage([folder], 'ch/001.jpg')).toEqual({ sources: [folder], held: false })
  })
})
