import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import type { Opened } from '~/utils/images'

import { useProjectFile } from '~/composables/useProjectFile'
import { PROJECT_VERSION } from '~/utils/project'
import { zip } from '~/utils/zip'

/**
 * Opening a project with a handle reads its scans in place; without one, copies.
 *
 * The scans are handed to `useLibrary.opened` either way, and what decides
 * whether they are copied into OPFS is whether `sources` comes with them. So
 * that is what this watches: a project picked or dropped with a handle arrives
 * as an `archive` source naming each scan's range of the file, and the pages
 * handed over are those ranges — and a project with no handle (an `<input>`, or
 * a file the operating system handed over) still arrives without, to be copied.
 *
 * Seam: `useProjectFile().load` on a real archive, with `useLibrary` replaced
 * so `opened` records what it was given and stops the import there.
 */

const { opened } = vi.hoisted(() => ({ opened: vi.fn(async (_opened: Opened) => false) }))

mockNuxtImport('useLibrary', () => () => ({ opened }))
mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws-load' }, fullPath: '/w/ws-load' }))

async function aProject () {
  const manifest = {
    v: PROJECT_VERSION,
    app: 'kemolate',
    exported: 1_754_700_000_000,
    title: 'Chapter 3',
    pages: [
      { path: 'ch3/002.jpg', name: '002.jpg', position: 1, file: 'pages/ch3/002.jpg', blocks: [] },
      { path: 'ch3/001.jpg', name: '001.jpg', position: 0, file: 'pages/ch3/001.jpg', blocks: [] },
    ],
  }

  const blob = await zip([
    { name: 'project.json', data: new Blob([JSON.stringify(manifest)]), deflate: true },
    { name: 'pages/ch3/001.jpg', data: new Blob(['page one']) },
    { name: 'pages/ch3/002.jpg', data: new Blob(['page two']) },
  ])

  return new File([blob], 'Chapter 3.kemolate', { lastModified: 1_760_000_000_000 })
}

describe('opening a project', () => {
  beforeEach(() => opened.mockClear())

  it('keeps the scans as ranges of the file when it came with a handle', async () => {
    const file = await aProject()
    const handle = { kind: 'file', name: file.name, getFile: async () => file } as unknown as FileSystemFileHandle
    const { load } = effectScope().run(() => useProjectFile())!

    await load(file, handle)

    const given = opened.mock.calls[0]![0]
    const source = given.sources?.[0]

    expect(given.sources).toHaveLength(1)
    expect(source).toMatchObject({ kind: 'archive', handle, size: file.size, lastModified: file.lastModified })
    expect(source?.kind === 'archive' && source.pages.map((page) => [page.path, page.entry])).toEqual([
      ['ch3/001.jpg', 'pages/ch3/001.jpg'],
      ['ch3/002.jpg', 'pages/ch3/002.jpg'],
    ])

    // In the manifest's order, and the bytes are the scans.
    expect(given.images.map((image) => image.path)).toEqual(['ch3/001.jpg', 'ch3/002.jpg'])
    expect(await Promise.all(given.images.map((image) => image.file.text()))).toEqual(['page one', 'page two'])
  })

  it('hands the scans over to be copied when there is no handle', async () => {
    const file = await aProject()
    const { load } = effectScope().run(() => useProjectFile())!

    await load(file)

    const given = opened.mock.calls[0]![0]

    expect(given.sources).toBeUndefined()
    expect(await Promise.all(given.images.map((image) => image.file.text()))).toEqual(['page one', 'page two'])
  })
})
