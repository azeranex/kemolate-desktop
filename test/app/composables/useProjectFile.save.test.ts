import { randomBytes } from 'node:crypto'
import { crc32 as zlibCrc32 } from 'node:zlib'

import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useComic } from '~/composables/useComic'
import { useProjectFile } from '~/composables/useProjectFile'

/**
 * Saving a chapter twice reads its scans once.
 *
 * A zip wants every entry's checksum before the entry, and a project file is
 * mostly scans — a sixty-page chapter is a gigabyte and a half of them — so
 * the save used to read every scan through a checksum on the main thread,
 * every time. A scan goes in stored and its bytes never change, so its sum is
 * remembered under its hash (`ZipEntry.digest`) and the second save reads
 * none of it. What would undo that silently is the save no longer handing the
 * hash over, which is what this watches for: the archive would still come out
 * right, just slowly, forever.
 *
 * Seam: `useProjectFile().save` on a local workspace of one page whose `File`
 * has every way of being read watched; `download` replaced, so the archive is
 * caught rather than saved.
 */

const { download } = vi.hoisted(() => ({ download: vi.fn() }))

vi.mock('~/utils/download', () => ({ download }))

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws-save' }, fullPath: '/w/ws-save' }))

/** A file whose every way of being read is counted. */
function watchedFile (bytes: Uint8Array<ArrayBuffer>, name: string) {
  const file = new File([bytes], name, { type: 'image/jpeg' })
  const spies = (['stream', 'arrayBuffer', 'text', 'slice', 'bytes'] as const)
    .filter((method) => method in file)
    .map((method) => vi.spyOn(file as File & { bytes: () => Promise<Uint8Array> }, method))

  return { file, reads: () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0) }
}

/** An entry's stored checksum, found by walking the archive's local headers. */
async function checksumIn (archive: Blob, name: string): Promise<number | null> {
  const bytes = new Uint8Array(await archive.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const decoder = new TextDecoder()

  let at = 0

  while (view.getUint32(at, true) === 0x04034B50) {
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const extraLength = view.getUint16(at + 28, true)

    if (decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength)) === name) return view.getUint32(at + 14, true)

    at += 30 + nameLength + extraLength + size
  }

  return null
}

describe('saving a project', () => {
  it('reads a scan for its checksum the first time and not the second', async () => {
    const bytes = new Uint8Array(randomBytes(300_001))
    const scan = watchedFile(bytes, '001.jpg')
    const { pages } = useComic()

    pages.value = [{
      id: 'scan:001.jpg',
      name: '001.jpg',
      blocks: [],
      scan: { url: 'blob:scan', file: scan.file, width: 10, height: 14, hash: 'c'.repeat(64) },
    } as unknown as ComicPage]

    const { save } = effectScope().run(() => useProjectFile())!

    expect(await save()).toBe(true)
    expect(scan.reads()).toBe(1)

    expect(await save()).toBe(true)
    expect(scan.reads()).toBe(1)

    // Both archives carry the scan's real checksum — the remembered one is not
    // a guess that happens to go unread.
    const archives = download.mock.calls.map(([archive]) => archive as Blob)

    expect(archives).toHaveLength(2)

    for (const archive of archives) expect(await checksumIn(archive, 'pages/001.jpg')).toBe(zlibCrc32(bytes))
  })
})
