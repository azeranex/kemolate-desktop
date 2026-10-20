/**
 * The small pictures the page engine draws over the scan — repairs and placed
 * images — decoded once each and kept while a page in reach still wants them.
 *
 * Both arrive as object URLs (`useClean`'s patch map, `usePlacedImages`), which
 * is what they were drawn from as `<img>`s. An `<img>` decodes when it is put
 * on the page, which is exactly the frame the printed lettering showed through
 * before its repair caught up. Decoded here ahead of the page — the one on
 * screen and those either side — they are in hand when it is drawn.
 *
 * Keyed by URL: a repair made again is a new URL, and the old picture is kept
 * until the new one is decoded, so a re-clean never shows the page bare in
 * between (`keep` is told about both).
 */
import { release } from './gpu'

const decoded = new Map<string, ImageBitmap>()
const decoding = new Map<string, Promise<ImageBitmap | null>>()

/** The picture at this URL, if it has been decoded. */
export function pictureAt (url: string): ImageBitmap | undefined {
  return decoded.get(url)
}

/**
 * Decode the picture at this URL, once. Null for one that will not decode —
 * a URL revoked before it was read, or bytes that are not a picture — which
 * the engine treats as nothing to wait for.
 */
export function wantPicture (url: string): Promise<ImageBitmap | null> {
  const held = decoded.get(url)

  if (held) return Promise.resolve(held)

  const going = decoding.get(url)

  if (going) return going

  const made = fetch(url)
    .then((response) => response.blob())
    .then((blob) => createImageBitmap(blob))
    .then((bitmap) => {
      decoding.delete(url)

      // Let go of while it was decoding: nobody wants it now.
      if (!wanted.has(url)) {
        release(bitmap)

        return null
      }

      decoded.set(url, bitmap)

      return bitmap
    })
    .catch(() => {
      decoding.delete(url)

      return null
    })

  decoding.set(url, made)

  return made
}

/** What `keep` last said is wanted — so a decode finishing after it knows. */
let wanted = new Set<string>()

/** Keep these pictures and let every other go. */
export function keepPictures (urls: Set<string>) {
  wanted = urls

  for (const [url, bitmap] of decoded) {
    if (urls.has(url)) continue

    release(bitmap)
    decoded.delete(url)
  }
}
