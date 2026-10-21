import { describe, expect, it } from 'vitest'

import { safeName, unzip, zip } from '~/utils/zip'

/**
 * The container a project file is, written and read here rather than by a
 * library — so these are the tests that stand in for the library's own.
 *
 * The round trip is the whole of it. A zip that writes an archive nothing else
 * can open is a chapter's work in a file the reader cannot get back, and the
 * failure would not show up until somebody tried — weeks later, on a machine
 * that no longer has the original. Every case here is a way the format is got
 * subtly wrong while still producing a file:
 *
 * - **CRC across chunk boundaries.** The checksum is carried un-inverted from
 *   chunk to chunk and inverted once at the end; inverting per chunk is the
 *   classic mistake and gives the right answer for anything read in one go.
 *   So one case is deliberately larger than a stream chunk.
 * - **The local header's extra field.** Where a file's data starts is read from
 *   the local header rather than worked out from the central directory, because
 *   the two are allowed to differ. Reading the wrong one offsets every entry by
 *   a few bytes and produces files that decode to almost the right thing.
 * - **UTF-8 names.** Bit 11 of the flags, without which a chapter whose folder
 *   has a Japanese name comes back as mojibake — in the app and in the
 *   operating system's unarchiver alike.
 *
 * Seam: `zip` and `unzip` against each other, and `safeName` on its own.
 */

const text = async (blob: Blob | undefined) => (blob ? blob.text() : null)

describe('a round trip', () => {
  it('gives back what went in', async () => {
    const archive = await zip([
      { name: 'project.json', data: new Blob(['{"app":"kemolate"}']), deflate: true },
      { name: 'pages/006.jpg', data: new Blob(['not really a jpeg']) },
    ])

    const held = await unzip(archive)

    expect([...held.keys()]).toEqual(['project.json', 'pages/006.jpg'])
    expect(await text(held.get('project.json'))).toBe('{"app":"kemolate"}')
    expect(await text(held.get('pages/006.jpg'))).toBe('not really a jpeg')
  })

  it('keeps a name that is not ASCII', async () => {
    const name = 'pages/日蝕 第2話/001.png'
    const archive = await zip([{ name, data: new Blob(['page']) }])

    const held = await unzip(archive)

    expect([...held.keys()]).toEqual([name])
  })

  it('keeps a path with folders in it, which is how a page is re-linked', async () => {
    const archive = await zip([{ name: 'pages/ch01/sub/09.webp', data: new Blob(['nine']) }])

    expect(await text((await unzip(archive)).get('pages/ch01/sub/09.webp'))).toBe('nine')
  })

  it('sums a file bigger than one stream chunk correctly', async () => {
    // Past the 64 KB a blob stream hands over at a time, so the checksum is
    // genuinely computed across more than one read.
    const big = 'x'.repeat(300_000)
    const archive = await zip([{ name: 'big.txt', data: new Blob([big]) }])

    expect(await text((await unzip(archive)).get('big.txt'))).toBe(big)
  })

  it('deflates only what it was asked to, and inflates it back', async () => {
    const repetitive = 'the same sentence over and over. '.repeat(500)

    const packed = await zip([{ name: 'a.txt', data: new Blob([repetitive]), deflate: true }])
    const stored = await zip([{ name: 'a.txt', data: new Blob([repetitive]) }])

    expect(packed.size).toBeLessThan(stored.size)
    expect(await text((await unzip(packed)).get('a.txt'))).toBe(repetitive)
  })

  it('survives an empty file, which a blank page is', async () => {
    const archive = await zip([{ name: 'nothing', data: new Blob([]) }])

    expect(await text((await unzip(archive)).get('nothing'))).toBe('')
  })

  it('survives an archive with nothing in it at all', async () => {
    expect((await unzip(await zip([]))).size).toBe(0)
  })

  it('holds many entries without losing their order', async () => {
    const names = Array.from({ length: 120 }, (_, at) => `pages/${String(at).padStart(3, '0')}.jpg`)

    const archive = await zip(names.map((name) => ({ name, data: new Blob([name]) })))
    const held = await unzip(archive)

    expect([...held.keys()]).toEqual(names)
    expect(await text(held.get(names[42]!))).toBe(names[42])
  })
})

describe('what it refuses', () => {
  it('says so plainly when handed something that is not a zip', async () => {
    await expect(unzip(new Blob(['this is a jpeg, honestly']))).rejects.toThrow(/not a zip/)
  })
})

describe('safeName', () => {
  it('accepts an ordinary page path', () => {
    expect(safeName('pages/ch01/006.jpg')).toBe(true)
  })

  it('refuses a path that climbs out of the archive', () => {
    expect(safeName('pages/../../etc/passwd')).toBe(false)
    expect(safeName('../secret')).toBe(false)
  })

  it('refuses an absolute path', () => {
    expect(safeName('/etc/passwd')).toBe(false)
  })

  it('refuses a Windows separator, which would not be split on', () => {
    expect(safeName('pages\\..\\..\\secret')).toBe(false)
  })

  it('accepts a name that merely contains dots', () => {
    expect(safeName('pages/006..jpg')).toBe(true)
    expect(safeName('pages/..hidden/006.jpg')).toBe(true)
  })

  it('refuses an empty name', () => {
    expect(safeName('')).toBe(false)
  })
})
