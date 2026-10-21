import { describe, expect, it } from 'vitest'

/**
 * `imageDimensions` is not imported: it is auto-imported from `app/utils`, and
 * calling it bare is half of what this file is here to prove — that the `nuxt`
 * project stands up the real module graph, and that a test under `test/app/`
 * sees the same globals the app does.
 *
 * The header is written byte by byte from the PNG spec rather than produced by
 * an encoder, so the numbers the assertion expects come from somewhere other
 * than the code under test.
 */
function pngHeader (width: number, height: number): Blob {
  const bytes = new Uint8Array(24)
  const view = new DataView(bytes.buffer)

  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) // \x89PNG\r\n\x1a\n
  view.setUint32(8, 13) // IHDR carries 13 bytes of data
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  view.setUint32(16, width)
  view.setUint32(20, height)

  return new Blob([bytes])
}

/**
 * A JPEG's first segments — SOI, an optional EXIF APP1 carrying one
 * Orientation entry, and a baseline start-of-frame — laid out from the JPEG
 * and TIFF specs. `order` is the TIFF byte order the camera chose: `II` little
 * endian, `MM` big; phones write both.
 */
function jpegHeader (width: number, height: number, exif?: { orientation: number, order?: 'II' | 'MM', ifdAt?: number }): Blob {
  const parts: number[] = [0xFF, 0xD8]

  if (exif) {
    const little = (exif.order ?? 'II') === 'II'
    const tiff = new DataView(new ArrayBuffer(26))

    tiff.setUint16(0, little ? 0x4949 : 0x4D4D)
    tiff.setUint16(2, 42, little)
    tiff.setUint32(4, exif.ifdAt ?? 8, little) // IFD0, relative to the TIFF header
    tiff.setUint16(8, 1, little) // one entry
    tiff.setUint16(10, 0x0112, little) // Orientation
    tiff.setUint16(12, 3, little) // SHORT
    tiff.setUint32(14, 1, little) // one of them
    tiff.setUint16(18, exif.orientation, little)
    tiff.setUint32(22, 0, little) // no next IFD

    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...new Uint8Array(tiff.buffer)] // 'Exif\0\0' + TIFF

    parts.push(0xFF, 0xE1, (body.length + 2) >> 8, (body.length + 2) & 0xFF, ...body)
  }

  // SOF0: length 17, 8-bit samples, then height before width, three components.
  parts.push(0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 0x03, ...new Array(9).fill(0))
  parts.push(...new Array(16).fill(0))

  return new Blob([new Uint8Array(parts)])
}

describe('imageDimensions', () => {
  it('reads a size out of a PNG header', async () => {
    await expect(imageDimensions(pngHeader(1280, 1810)))
      .resolves.toEqual({ width: 1280, height: 1810 })
  })

  it('reads a size out of a JPEG start-of-frame', async () => {
    await expect(imageDimensions(jpegHeader(1200, 1800)))
      .resolves.toEqual({ width: 1200, height: 1800 })
  })

  /**
   * The size a page is *drawn* at, not the one its frame is stored at. Every
   * decode here honours EXIF orientation — `createImageBitmap`'s default — so
   * a photo stored landscape and tagged to be turned a quarter arrives as a
   * portrait bitmap. Reported as stored, every box on the page was divided by
   * the wrong width: the detector's coordinates came off the turned picture.
   */
  it('swaps the sides of a JPEG its EXIF says to turn a quarter, in either byte order', async () => {
    await expect(imageDimensions(jpegHeader(1800, 1200, { orientation: 6 })))
      .resolves.toEqual({ width: 1200, height: 1800 })
    await expect(imageDimensions(jpegHeader(1800, 1200, { orientation: 8, order: 'MM' })))
      .resolves.toEqual({ width: 1200, height: 1800 })
    await expect(imageDimensions(jpegHeader(1800, 1200, { orientation: 5, order: 'MM' })))
      .resolves.toEqual({ width: 1200, height: 1800 })
  })

  it('leaves the sides of a JPEG turned upside down or not at all', async () => {
    await expect(imageDimensions(jpegHeader(1200, 1800, { orientation: 1 })))
      .resolves.toEqual({ width: 1200, height: 1800 })
    await expect(imageDimensions(jpegHeader(1200, 1800, { orientation: 3 })))
      .resolves.toEqual({ width: 1200, height: 1800 })
  })

  it('reads the frame as stored when the EXIF cannot be read, rather than failing', async () => {
    await expect(imageDimensions(jpegHeader(1200, 1800, { orientation: 6, ifdAt: 9000 })))
      .resolves.toEqual({ width: 1200, height: 1800 })
  })

  it('returns null for bytes no sniffer recognises, so the caller can fall back', async () => {
    await expect(imageDimensions(new Blob([new Uint8Array(64)])))
      .resolves.toBeNull()
  })
})
