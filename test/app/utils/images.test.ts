import { crc32, deflateSync, inflateSync } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The one image this app *makes* rather than opens: the white page a reader
 * inserts.
 *
 * **Needs the nuxt project** for the auto-import, and a canvas of its own —
 * happy-dom hands out a `<canvas>` whose `getContext('2d')` is null and whose
 * `toBlob` yields nothing, so the platform is stood in for below. The stand-in
 * is a 2D context that can do the two things `blankImage` asks of one — a fill
 * colour and a filled rectangle — over a real pixel buffer, encoded to a real
 * PNG by hand. That is what keeps "the page is white" an assertion about the
 * code under test rather than about the double: nothing here paints anything,
 * so a `blankImage` that forgot to fill would come out black.
 *
 * What is being guarded: a blank page's bytes are its identity. Everything
 * derived from a page hangs off its SHA-256 — the block cache, the thumbnail,
 * cleaned patches, and what a peer asks the swarm for — so two blanks that
 * hash alike are one page as far as all of those are concerned, and lettering
 * one of them hydrates onto the other after a reload. Two white pages of the
 * same size are otherwise the same PNG down to the byte.
 *
 * Seam: `blankImage`, and the file it hands back.
 */

/** Lowercase hex, the way `hash.ts` writes a digest and every tool prints one. */
async function digest (file: Blob) {
  const buffer = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())

  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A four-byte big-endian length or CRC, which is the only number PNG writes. */
function be32 (value: number) {
  const bytes = new Uint8Array(4)

  new DataView(bytes.buffer).setUint32(0, value >>> 0)

  return bytes
}

/**
 * One chunk: length, type, data, CRC over type and data.
 *
 * The CRC comes from `node:zlib`, which is an implementation of the same
 * polynomial written by somebody else — so a chunk this file builds and a chunk
 * the code under test builds are checked against the same outside answer rather
 * than against each other.
 */
function chunk (type: string, data: Uint8Array) {
  const named = new Uint8Array([...new TextEncoder().encode(type), ...data])

  return new Uint8Array([...be32(data.length), ...named, ...be32(crc32(named))])
}

/**
 * A PNG written from the spec rather than produced by an encoder: 8-bit RGB,
 * no interlacing, every scanline unfiltered. `blankImage` has to survive any
 * valid PNG its canvas hands it, and this is one.
 */
function png (width: number, height: number, pixels: Uint8Array) {
  const raw = new Uint8Array(height * (width * 3 + 1))

  for (let row = 0; row < height; row++) {
    // The leading zero is the filter type — 0, meaning the row is itself.
    raw.set(pixels.subarray(row * width * 3, (row + 1) * width * 3), row * (width * 3 + 1) + 1)
  }

  const header = new Uint8Array([...be32(width), ...be32(height), 8, 2, 0, 0, 0])

  return new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ...chunk('IHDR', header),
    ...chunk('IDAT', new Uint8Array(deflateSync(raw))),
    ...chunk('IEND', new Uint8Array(0)),
  ])
}

/** Every chunk in a file, in the order they were written. */
function chunksOf (bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const latin1 = new TextDecoder('latin1')
  const found: { type: string, data: Uint8Array, crc: number }[] = []

  let at = 8

  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at)

    found.push({
      type: latin1.decode(bytes.subarray(at + 4, at + 8)),
      data: bytes.subarray(at + 8, at + 8 + length),
      crc: view.getUint32(at + 8 + length),
    })

    at += 12 + length
  }

  return found
}

function bytesOf (file: Blob) {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer))
}

/** What a decoder would show: the size in the header and the pixels themselves. */
function decoded (bytes: Uint8Array) {
  const chunks = chunksOf(bytes)
  const header = chunks.find((one) => one.type === 'IHDR')!
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength)

  const width = view.getUint32(0)
  const height = view.getUint32(4)

  const data = chunks.filter((one) => one.type === 'IDAT').flatMap((one) => [...one.data])
  const raw = new Uint8Array(inflateSync(new Uint8Array(data)))

  const pixels: number[] = []

  for (let row = 0; row < height; row++) {
    const at = row * (width * 3 + 1)

    // Only unfiltered rows are understood here, which is what this file's own
    // encoder writes. A row that arrived filtered would mean the pixels had
    // been through something on the way, which is itself the failure.
    if (raw[at] !== 0) throw new Error(`row ${row} came back filtered`)

    pixels.push(...raw.subarray(at + 1, at + 1 + width * 3))
  }

  return { width, height, pixels }
}

/**
 * The 2D context happy-dom does not have, over a pixel buffer per canvas.
 *
 * Only `fillStyle` and `fillRect` — the two things `blankImage` uses. Anything
 * else it grows a need for should fail loudly here rather than be quietly
 * absent.
 */
const surfaces = new WeakMap<HTMLCanvasElement, Uint8Array>()

function surfaceOf (canvas: HTMLCanvasElement) {
  let pixels = surfaces.get(canvas)

  if (!pixels) {
    pixels = new Uint8Array(canvas.width * canvas.height * 3)
    surfaces.set(canvas, pixels)
  }

  return pixels
}

function contextFor (canvas: HTMLCanvasElement) {
  const context = {
    fillStyle: '#000000',
    fillRect (x: number, y: number, width: number, height: number) {
      const colour = [1, 3, 5].map((at) => Number.parseInt(context.fillStyle.slice(at, at + 2), 16))
      const pixels = surfaceOf(canvas)

      for (let row = y; row < Math.min(y + height, canvas.height); row++) {
        for (let column = x; column < Math.min(x + width, canvas.width); column++) {
          pixels.set(colour, (row * canvas.width + column) * 3)
        }
      }
    },
  }

  return context
}

const platform = {
  getContext: HTMLCanvasElement.prototype.getContext,
  toBlob: HTMLCanvasElement.prototype.toBlob,
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    return kind === '2d' ? contextFor(this) : null
  } as unknown as typeof platform.getContext

  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
    callback(new Blob([png(this.width, this.height, surfaceOf(this))], { type: 'image/png' }))
  } as unknown as typeof platform.toBlob
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = platform.getContext
  HTMLCanvasElement.prototype.toBlob = platform.toBlob
})

describe('blankImage', () => {
  it('gives two blanks of the same size two different digests', async () => {
    const one = await blankImage('1.jpg.blank-1.png', 40, 24)
    const two = await blankImage('1.jpg.blank-2.png', 40, 24)

    expect(await digest(one!.file)).not.toBe(await digest(two!.file))
  })

  it('makes the two differ by their metadata and not by their picture', async () => {
    const one = await blankImage('1.jpg.blank-1.png', 40, 24)
    const two = await blankImage('1.jpg.blank-2.png', 40, 24)

    const picture = (bytes: Uint8Array) =>
      chunksOf(bytes).filter((chunk) => chunk.type === 'IDAT').flatMap((chunk) => [...chunk.data])

    expect(picture(await bytesOf(one!.file))).toEqual(picture(await bytesOf(two!.file)))
  })

  it('writes the page\'s own path into the file', async () => {
    const path = 'ECLIPSE日蚀2中文版/1.jpg.blank-1.png'
    const blank = await blankImage(path, 8, 8)

    const said = chunksOf(await bytesOf(blank!.file))
      .filter((chunk) => chunk.type !== 'IHDR' && chunk.type !== 'IDAT' && chunk.type !== 'IEND')
      .map((chunk) => new TextDecoder().decode(chunk.data))

    expect(said.some((text) => text.includes(path))).toBe(true)
  })

  it('stays a file every decoder can still read', async () => {
    const blank = await blankImage('1.jpg.blank-1.png', 40, 24)
    const bytes = await bytesOf(blank!.file)
    const chunks = chunksOf(bytes)

    // Each chunk answers for itself, against zlib's CRC rather than ours, and
    // `IEND` is last — a chunk written after it is a chunk nothing reads.
    for (const { type, data, crc } of chunks) {
      expect(crc32(new Uint8Array([...new TextEncoder().encode(type), ...data]))).toBe(crc)
    }

    expect(chunks.at(-1)?.type).toBe('IEND')
  })

  it('is still a PNG of the size that was asked for', async () => {
    const blank = await blankImage('1.jpg.blank-1.png', 40, 24)

    expect(decoded(await bytesOf(blank!.file))).toMatchObject({ width: 40, height: 24 })
  })

  it('is white to the last pixel', async () => {
    const blank = await blankImage('1.jpg.blank-1.png', 40, 24)
    const { pixels } = decoded(await bytesOf(blank!.file))

    expect(pixels).toHaveLength(40 * 24 * 3)
    expect(pixels.every((value) => value === 0xFF)).toBe(true)
  })
})
