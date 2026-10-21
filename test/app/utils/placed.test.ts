import { describe, expect, it } from 'vitest'

import { placedExtension } from '~/utils/placed'

/**
 * What a placed image is filed as, which is not a cosmetic question.
 *
 * OPFS keeps no MIME type. A file read back out of it is typed by the browser
 * from its *name*, so the extension written on the way in is the whole of what
 * the blob claims to be on the way out — and an image stored as the wrong one
 * comes back lying about itself. `<img>` mostly survives that by sniffing the
 * bytes, and "mostly" across five formats and four browsers is exactly the kind
 * of thing that works until somebody's chapter opens blank.
 *
 * The order matters as much as the answers. A type the browser stated is
 * evidence; an extension somebody typed is a guess, and is only consulted when
 * there is no evidence — a file dragged out of some archivers arrives with an
 * empty type and nothing else to go on.
 */

/** A file with whatever type and name the case is about. Bytes are irrelevant. */
const file = (name: string, type: string) => new File([new Uint8Array(8)], name, { type })

describe('placedExtension — from the type', () => {
  it('takes a PNG', () => {
    expect(placedExtension(file('clean.png', 'image/png'))).toBe('png')
  })

  it('takes a JPEG, and calls it jpg', () => {
    expect(placedExtension(file('clean.jpeg', 'image/jpeg'))).toBe('jpg')
  })

  /** Some tools state `image/jpg`, which is not a real type and is not worth refusing over. */
  it('takes the type that is not quite a type', () => {
    expect(placedExtension(file('clean.jpg', 'image/jpg'))).toBe('jpg')
  })

  it('takes WebP, AVIF and GIF', () => {
    expect(placedExtension(file('a.webp', 'image/webp'))).toBe('webp')
    expect(placedExtension(file('a.avif', 'image/avif'))).toBe('avif')
    expect(placedExtension(file('a.gif', 'image/gif'))).toBe('gif')
  })

  /**
   * The stated type wins over the name, which is the direction that matters:
   * an image saved as `page.jpg.png` is a PNG, and believing the first thing
   * that looks like an extension would file it as a JPEG.
   */
  it('believes the type over the name when they disagree', () => {
    expect(placedExtension(file('page.jpg', 'image/png'))).toBe('png')
  })
})

describe('placedExtension — from the name, when there is no type', () => {
  it('reads the extension off a file the browser would not type', () => {
    expect(placedExtension(file('clean.png', ''))).toBe('png')
  })

  it('normalises a shouted extension', () => {
    expect(placedExtension(file('CLEAN.PNG', ''))).toBe('png')
  })

  it('normalises the long spelling of jpeg here too', () => {
    expect(placedExtension(file('clean.jpeg', ''))).toBe('jpg')
  })
})

describe('placedExtension — refusing', () => {
  /**
   * A format not on the list is refused rather than guessed at. Every clean
   * anybody actually has is one of the five, and a wrong guess is an image that
   * decodes today and does not tomorrow.
   */
  it('refuses a format we cannot name', () => {
    expect(placedExtension(file('clean.tif', 'image/tiff'))).toBeNull()
  })

  it('refuses something that is not an image at all', () => {
    expect(placedExtension(file('notes.pdf', 'application/pdf'))).toBeNull()
  })

  it('refuses a file with neither a type nor an extension', () => {
    expect(placedExtension(file('clean', ''))).toBeNull()
  })

  /** A bare `Blob` has no name to fall back on, and must not throw reaching for one. */
  it('refuses a blob with no name rather than failing to look', () => {
    expect(placedExtension(new Blob([new Uint8Array(8)]))).toBeNull()
  })
})
