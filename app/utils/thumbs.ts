/**
 * Small copies of the scans, so a chapter can be looked at.
 *
 * The Pages panel draws every page of the chapter at about a hundred pixels
 * wide, and until now it drew each one from the scan itself: a `<img>` onto the
 * original file, shrunk by CSS. A browser decodes an image at its own size and
 * not at the size it is painted, so a forty-page chapter of two-megapixel scans
 * held something like three hundred megabytes of bitmap to show a strip of
 * postage stamps — and under memory pressure the browser evicts and re-decodes
 * them, which is the flicker you get scrolling such a strip.
 *
 * So each scan is copied down once, on the way in, and the panel draws the copy.
 *
 * ## Filed under the scan, like everything else derived
 *
 * The key is the scan's content hash, exactly as `patchKey` and the block cache
 * use it. Same two consequences, both wanted: re-importing a chapter finds its
 * thumbnails already made, and a page whose bytes changed is a different page
 * and rightly gets a new one. A thumbnail is never *wrong*, only unreachable,
 * so there is a sweep rather than an invalidation.
 *
 * Nothing here goes to the server. A thumbnail is an image asset and the server
 * holds none — see the schema, which has no column that can hold bytes.
 */
import { opfsRead, opfsWrite } from '~/utils/opfs'
import { scanJob } from '~/utils/raster/decoder'

const ROOT = 'thumbs'

/**
 * How wide a thumbnail is made.
 *
 * The strip draws them near a hundred CSS pixels, so this is comfortably past
 * what a two-times display asks for and leaves room for the panel to be widened
 * without everything going soft. Small enough that a hundred of them together
 * are a few megabytes of decode rather than a few hundred.
 */
const WIDTH = 320

/**
 * WebP rather than PNG: a thumbnail is photographic and lossless costs four or
 * five times the bytes for a picture nobody inspects at this size. Quality is
 * high because the alternative — ringing around lettering — is exactly what a
 * page of comics shows worst.
 */
const TYPE = 'image/webp'
const QUALITY = 0.86

export const readThumb = (hash: string): Promise<Blob | null> => opfsRead(ROOT, `${hash}.webp`)

// A thumbnail that cannot be written costs the panel a full-size decode, which
// is what it did before this existed — see `opfsWrite`, which says nothing.
const writeThumb = (hash: string, image: Blob) => opfsWrite(ROOT, `${hash}.webp`, image)

/**
 * A scan's thumbnail, made if it has not been made before — on the background
 * thread, where the shrinking does not cost the page a frame (`jobs.ts` has
 * the measurements, and how it is made).
 */
export async function thumbFor (hash: string, file: Blob): Promise<Blob | null> {
  const held = await readThumb(hash)

  if (held) return held

  try {
    const made = await scanJob(`thumb:${hash}`, file, { what: 'thumb', width: WIDTH, type: TYPE, quality: QUALITY })
    const image = made?.blob

    if (!image) return null

    await writeThumb(hash, image)

    return image
  } catch {
    // A scan the browser will not decode is a scan the panel will not draw
    // either, and it falls back to the file itself.
    return null
  }
}
