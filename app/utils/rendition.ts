/**
 * A small copy of a page, made to be looked at once by something that is not
 * this browser.
 *
 * The only thing in the app that deliberately hands a picture of a scan to the
 * server, and it exists for one caller: the MCP relay, which is how an agent in
 * somebody's editor is shown a page it has no other way to see. The argument
 * for that, and the limits on it, are in `server/utils/relay.ts`; what matters
 * here is that **the reader's file is never what is sent** unless sending it
 * unchanged is strictly better for them than a copy would be — see the
 * pass-through in `jobs.ts`, where the drawing is.
 *
 * `createImageBitmap` with `resizeWidth`/`resizeHeight` for the reason
 * the thumbnails use it: it decodes and scales inside the browser's own image
 * pipeline, so a forty-megapixel scan never has to exist full-size in the
 * page's heap to produce a picture a fiftieth of its size.
 *
 * JPEG rather than the WebP the thumbnails use, because this one is read by
 * whichever model the agent happens to be, and JPEG is the format every one of
 * them accepts.
 *
 * ## Cropping first is what makes close reading possible
 *
 * A whole page bounded to sixteen hundred pixels cannot resolve small vertical
 * lettering, and the thing looking at it has no way to lean in. Given a region,
 * this cuts the rectangle out *before* scaling, so the bound is spent on the
 * part somebody asked about: a balloon a tenth of the page across comes back
 * ten times sharper and a fraction of the bytes. The region arrives in the
 * width-normalised units a block's box uses, so a caller can point at a block
 * without knowing the page's pixel size.
 */
import { jobKey, scanJob } from '~/utils/raster/decoder'

/** What the relay wants back: the bytes, and what they are. */
export interface Rendition {
  blob: Blob
  width: number
  height: number
}

/** A rectangle of the page, as fractions of its **width** on both axes. */
export interface RenditionRegion {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The page, or the region of it, as it travels — made on the background
 * thread (`jobs.ts`, which holds the drawing and the pass-through rule), so an
 * agent asking for a page costs the reader's tab no frames. The file itself
 * where sending it unchanged is the better answer.
 */
export async function renditionOf (
  file: Blob,
  maxEdge: number,
  quality: number,
  region?: RenditionRegion | null,
): Promise<Rendition | null> {
  try {
    const made = await scanJob(jobKey('rendition'), file, { what: 'rendition', maxEdge, quality, region: region ?? null })

    if (!made) return null
    if (made.same) return { blob: file, width: made.width, height: made.height }

    return made.blob ? { blob: made.blob, width: made.width, height: made.height } : null
  } catch {
    // A scan this browser will not decode is one it cannot show anybody. The
    // relay's own timeout reports it; there is nothing useful to raise here.
    return null
  }
}
