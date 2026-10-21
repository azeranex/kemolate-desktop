import { randomBytes } from 'node:crypto'
import { inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib'

import { describe, expect, it, vi } from 'vitest'

import { zip } from '~/utils/zip'

/**
 * The archive `zip` writes, read by something that is not `unzip`.
 *
 * `zip.test.ts` round-trips through the app's own reader, which proves the two
 * halves agree and nothing more — a writer and a reader can share a mistake
 * and still agree. A project file is opened years later by an operating
 * system's unarchiver, so these read the bytes the way that would: the central
 * directory by hand, every offset followed to its local header, every CRC
 * checked against `node:zlib`'s, a stored entry compared byte for byte, and
 * the deflated manifest inflated by zlib.
 *
 * And the two ways an entry's checksum is now had without reading it — given
 * by the caller (`crc`, what the page export's encoders hand over) and
 * remembered by digest (`digest`, what makes saving a chapter twice read its
 * scans once) — are held to the same reader, and to not reading.
 *
 * Seam: `zip`, against a hand-written parser and `node:zlib`.
 */

interface Parsed {
  name: string
  method: number
  flags: number
  crc: number
  compressed: number
  size: number
  data: Uint8Array
}

/** The archive as an unarchiver sees it: the end record, the central directory, and each local header it points at. */
function parse (archive: Uint8Array): Parsed[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()

  // No comment is written, so the end record is the last 22 bytes exactly.
  const end = archive.length - 22

  expect(view.getUint32(end, true)).toBe(0x06054B50)

  const count = view.getUint16(end + 10, true)

  expect(view.getUint16(end + 8, true)).toBe(count)

  const directorySize = view.getUint32(end + 12, true)
  const directoryStart = view.getUint32(end + 16, true)

  expect(directoryStart + directorySize).toBe(end)

  const out: Parsed[] = []

  let at = directoryStart

  for (let index = 0; index < count; index++) {
    expect(view.getUint32(at, true)).toBe(0x02014B50)

    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const offset = view.getUint32(at + 42, true)
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength))

    // The local header says the same as the directory, field for field.
    expect(view.getUint32(offset, true)).toBe(0x04034B50)
    expect(view.getUint16(offset + 6, true)).toBe(flags)
    expect(view.getUint16(offset + 8, true)).toBe(method)
    expect(view.getUint32(offset + 14, true)).toBe(crc)
    expect(view.getUint32(offset + 18, true)).toBe(compressed)
    expect(view.getUint32(offset + 22, true)).toBe(size)

    const localName = view.getUint16(offset + 26, true)
    const localExtra = view.getUint16(offset + 28, true)

    expect(decoder.decode(archive.subarray(offset + 30, offset + 30 + localName))).toBe(name)

    const from = offset + 30 + localName + localExtra

    out.push({ name, method, flags, crc, compressed, size, data: archive.subarray(from, from + compressed) })

    at += 46 + nameLength + extraLength + commentLength
  }

  expect(at).toBe(end)

  return out
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

/** A blob whose every way of being read is watched. */
function watched (bytes: Uint8Array<ArrayBuffer>) {
  const blob = new Blob([bytes])
  const reads = [
    vi.spyOn(blob, 'stream'),
    vi.spyOn(blob, 'arrayBuffer'),
    vi.spyOn(blob, 'text'),
    vi.spyOn(blob, 'slice'),
    ...('bytes' in blob ? [vi.spyOn(blob as Blob & { bytes: () => Promise<Uint8Array> }, 'bytes')] : []),
  ]

  return { blob, reads: () => reads.reduce((total, spy) => total + spy.mock.calls.length, 0) }
}

describe('what another reader finds', () => {
  it('lists every entry, sized and summed as zlib sums it, stored entries byte for byte', async () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ app: 'kemolate', pages: Array.from({ length: 50 }, (_, at) => ({ at })) }))
    const pages = [0, 1, 7, 8, 9, 65_537, 300_001].map((length) => new Uint8Array(randomBytes(length)))
    const names = pages.map((_, at) => `pages/第${at}話/${String(at).padStart(3, '0')}.jpg`)

    const archive = await bytesOf(await zip([
      { name: 'project.json', data: new Blob([manifest]), deflate: true },
      ...pages.map((bytes, at) => ({ name: names[at]!, data: new Blob([bytes]) })),
    ]))

    const found = parse(archive)

    expect(found.map((entry) => entry.name)).toEqual(['project.json', ...names])

    // Every name flagged UTF-8, or an unarchiver reads 第 as CP437.
    for (const entry of found) expect(entry.flags & 0x0800).toBe(0x0800)

    const [head, ...rest] = found

    expect(head!.method).toBe(8)
    expect(head!.size).toBe(manifest.length)
    expect(new Uint8Array(inflateRawSync(head!.data))).toEqual(manifest)
    expect(head!.crc).toBe(zlibCrc32(manifest))

    for (const [at, entry] of rest.entries()) {
      expect(entry.method, entry.name).toBe(0)
      expect(entry.size, entry.name).toBe(pages[at]!.length)
      expect(entry.compressed, entry.name).toBe(pages[at]!.length)
      expect(entry.data, entry.name).toEqual(pages[at])
      expect(entry.crc, entry.name).toBe(zlibCrc32(pages[at]!))
    }
  })

  it('writes an empty archive another reader accepts', async () => {
    expect(parse(await bytesOf(await zip([])))).toEqual([])
  })
})

describe('a checksum the caller already has', () => {
  it('is written as given, and the entry is not read for it', async () => {
    const bytes = new Uint8Array(randomBytes(100_003))
    const page = watched(bytes)

    const archive = await bytesOf(await zip([{ name: '001.png', data: page.blob, crc: zlibCrc32(bytes) }]))

    expect(page.reads()).toBe(0)

    const [entry] = parse(archive)

    expect(entry!.crc).toBe(zlibCrc32(bytes))
    expect(entry!.data).toEqual(bytes)
  })
})

describe('a checksum remembered by digest', () => {
  it('reads the bytes the first time and never again, as a second save of the same scans does', async () => {
    const bytes = new Uint8Array(randomBytes(200_001))
    const digest = 'a'.repeat(64)

    // Two blobs with the same bytes, as two saves hand over the same `File`s
    // — the second one watched.
    const first = watched(bytes)
    const second = watched(bytes)

    const one = await bytesOf(await zip([{ name: 'pages/001.jpg', data: first.blob, digest }]))

    expect(first.reads()).toBe(1)

    const two = await bytesOf(await zip([{ name: 'pages/001.jpg', data: second.blob, digest }]))

    expect(second.reads()).toBe(0)
    expect(parse(two)[0]!.crc).toBe(zlibCrc32(bytes))
    expect(parse(one)[0]!.crc).toBe(zlibCrc32(bytes))
  })

  it('reads again where the digest arrives with bytes of another length', async () => {
    const digest = 'b'.repeat(64)
    const bytes = new Uint8Array(randomBytes(5_000))
    const other = new Uint8Array(randomBytes(5_001))

    await zip([{ name: 'a', data: new Blob([bytes]), digest }])

    const wrong = watched(other)
    const archive = await bytesOf(await zip([{ name: 'a', data: wrong.blob, digest }]))

    expect(wrong.reads()).toBe(1)
    expect(parse(archive)[0]!.crc).toBe(zlibCrc32(other))
  })

  it('remembers nothing for an entry with no digest', async () => {
    const bytes = new Uint8Array(randomBytes(1_000))

    await zip([{ name: 'a', data: new Blob([bytes]) }])

    const again = watched(bytes)

    await zip([{ name: 'a', data: again.blob }])

    expect(again.reads()).toBe(1)
  })
})
