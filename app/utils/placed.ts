/**
 * Pictures a reader has placed on a page, kept where the browser keeps things.
 *
 * The case this was built for is a clean raw. Scanlation does not start at the
 * scan: a group that has a cleaner has the lettering taken out by hand, at the
 * source resolution, and running an inpainter over that page would be spending
 * seconds to produce a worse version of something already on disk. Placing that
 * image as a layer and setting the cleaner to `None` is the whole of saying so.
 *
 * It is deliberately not a "supplied clean". Nothing here knows what the
 * picture is *for* — a redraw, a logo, a credits strip, an effect drawn
 * elsewhere are the same thing to this file and to the stack. Building it as a
 * layer rather than as a second kind of cleaned plate is what buys that: the
 * eye, the opacity, the lock, the order in the pile and every preset's opinion
 * are machinery the stack already has, and a bespoke concept would have needed
 * its own copy of all five.
 *
 * ## Filed under its own hash, which is the departure
 *
 * Everything else the app keeps under a digest is keyed by the *scan* it was
 * derived from — thumbnails, repairs, the block cache — because those things
 * belong to a page and are worthless away from it. A placed image belongs to
 * nobody. It is a file that was put somewhere, so it is keyed by itself, and
 * three things follow: the same clean placed on two pages is stored once, the
 * stack row can name it in a way that survives being sent to another browser,
 * and a peer can be asked for it by hash exactly as it is asked for a scan.
 *
 * ## Stored as it arrived
 *
 * Never re-encoded — the same rule the PDF extractor keeps. A clean raw is a
 * source image: it is the thing that ships. Rewriting a lossless clean as a
 * lossy one to save room here would be spending the reader's artwork on our
 * disk usage, and rewriting a JPEG as PNG would multiply it instead.
 *
 * ## And nothing here collects
 *
 * A thumbnail or a repair may be thrown away because it is *derived*: throwing
 * one away costs the time to make it again (see `sweepStaleRecipes`). This is
 * not.
 * It came off somebody's disk, it may have taken an hour of their evening, and
 * there is no recomputing it.
 *
 * Which leaves a real gap, stated rather than hidden: a picture placed and then
 * deleted leaves its bytes behind. The obvious fix — drop the file when the last
 * row referencing it goes — is wrong, and wrong in the direction that loses
 * work: this store is shared across workspaces on purpose, so "no row in the
 * open chapter wants it" is not "no row wants it", and a reader with the same
 * clean placed in two workspaces would have one of them quietly emptied by
 * tidying the other. Closing it properly needs the whole library, which is the
 * same thing standing in the way of sweeping thumbnails.
 *
 * Nothing here reaches the server, for the reason nothing else holding pixels
 * does. A clean raw is a page of the comic with the words taken out; it is
 * exactly the kind of bytes the app promises never to upload.
 */
import type { PlacedExtension, PlacedImage } from '#shared/utils/layers'

import { PLACED_EXTENSIONS } from '#shared/utils/layers'
import { hashBytes, hashFile } from '~/utils/hash'
import { opfsDir, opfsUsable, opfsWrite } from '~/utils/opfs'

const ROOT = 'images'

/**
 * What a placed image may be, and what it is called on the way out.
 *
 * The extension is not decoration: OPFS keeps no MIME type, so a file read back
 * is typed by the browser from its *name*. Store a JPEG as `.png` and the blob
 * comes back claiming to be a PNG — which `<img>` mostly survives by sniffing
 * the bytes anyway, and that is exactly the kind of "mostly" not worth building
 * on. So the type is written into the name on the way in and is right on the
 * way out.
 *
 * A format not in this list is refused rather than guessed at. Every clean
 * anybody actually has is one of these, and a wrong guess here is an image that
 * decodes today and does not tomorrow.
 */
const TYPES: Record<string, PlacedExtension> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

/** What to say when a file is refused, in the words the panel shows. */
export const PLACED_KINDS = 'PNG, JPEG, WebP, AVIF or GIF'

const allowed = (ext: string): ext is PlacedExtension =>
  (PLACED_EXTENSIONS as readonly string[]).includes(ext)

/** The extension a file would be kept under, or nothing if it may not be kept. */
export function placedExtension (file: Blob & { name?: string }): PlacedExtension | null {
  const byType = TYPES[file.type.toLowerCase()]

  if (byType) return byType

  // A file dragged out of some archivers arrives with an empty type, so the
  // name is worth one look before refusing. Only as a fallback: a type the
  // browser *did* state is better evidence than an extension somebody typed.
  const named = /\.([a-z0-9]+)$/i.exec(file.name ?? '')?.[1]?.toLowerCase()
  const jpeg = named === 'jpeg' ? 'jpg' : named

  return jpeg && allowed(jpeg) ? jpeg : null
}

/** What one image is called here — its hash, wearing the type it arrived as. */
const nameOf = (image: Pick<PlacedImage, 'hash' | 'ext'>) => `${image.hash}.${image.ext}`

/**
 * Keep a picture, and answer with what the stack should write down about it.
 *
 * The hash is computed here rather than taken, because it is not a fact about
 * the file the caller happens to know — it is what this store files it under,
 * and a caller that supplied one could supply the wrong one. Content addressing
 * also makes this idempotent for nothing: placing the same clean on ten pages
 * writes one file and hands back ten identical references.
 *
 * The decode is what makes it an image rather than a file with a hopeful name,
 * and it is done before anything is written so that a refusal leaves no trace.
 * Its size comes out of the same decode, which the row wants anyway.
 *
 * Answers null for a file that is not an image we can keep. Which of the two it
 * was is the caller's to say — see `usePlacedImages`, where every refusal has a
 * sentence of its own.
 */
export async function writePlaced (file: File): Promise<PlacedImage | null> {
  const ext = placedExtension(file)

  if (!ext) return null

  const bitmap = await createImageBitmap(file).catch(() => null)

  if (!bitmap) return null

  const { width, height } = bitmap

  bitmap.close()

  const hash = await hashFile(file).catch(() => null)

  if (!hash) return null

  const image: PlacedImage = { hash, ext, name: file.name, width, height }

  // Answered with the reference whether or not the write went. Nowhere to
  // write, and the picture still draws for as long as this tab is open — the
  // object URL is made from the file in hand — and the row still names it, so
  // a browser that gains storage later finds the reference waiting. Better a
  // placement that works today than a refusal that helps nobody.
  await opfsWrite(ROOT, nameOf(image), file)

  return image
}

/**
 * File bytes that already have a name — what importing a project does.
 *
 * The departure from `writePlaced` above is that the hash is *taken* rather
 * than computed, and that sentence is written there as the thing a caller must
 * not be allowed to do. The exception is narrow and worth stating: an import
 * has the stack rows in the same archive as the bytes, so the reference and the
 * picture arrive together, and re-deriving the name would be answering a
 * question the file has already answered. What it must not become is a general
 * way in — a caller that supplies a hash it did not get from the same place as
 * the bytes writes a file nothing will ever find.
 *
 * So the digest is checked rather than trusted. A mismatch means the archive
 * disagrees with itself, and the honest answer is to keep nothing: a file
 * stored under a name its bytes do not have is a picture that draws today and
 * is a blank row on every other machine.
 *
 * Quiet on a browser with nowhere to write, exactly as `writePlaced` is. The
 * row still names the picture, and a browser that gains storage later finds the
 * reference waiting.
 */
export async function keepPlaced (
  image: Pick<PlacedImage, 'hash' | 'ext'>,
  bytes: Blob,
): Promise<boolean> {
  if (await hashBytes(bytes).catch(() => null) !== image.hash) return false

  return opfsWrite(ROOT, nameOf(image), bytes)
}

/**
 * The files behind a page's — or a chapter's — worth of references.
 *
 * Asked with the references rather than with bare hashes, because the name on
 * disk carries the type and the stack is the thing that knows it. Duplicates
 * fold together, which is the ordinary case: one clean placed on twenty pages
 * is twenty rows and one read.
 */
export async function readPlacedMany (
  images: Iterable<Pick<PlacedImage, 'hash' | 'ext'>>,
): Promise<Map<string, File>> {
  const out = new Map<string, File>()

  if (!opfsUsable()) return out

  const wanted = new Map<string, Pick<PlacedImage, 'hash' | 'ext'>>()

  for (const image of images) wanted.set(image.hash, image)

  if (!wanted.size) return out

  const dir = await opfsDir(ROOT).catch(() => null)

  if (!dir) return out

  for (const [hash, image] of wanted) {
    const file = await dir.getFileHandle(nameOf(image)).then((handle) => handle.getFile()).catch(() => null)

    if (file) out.set(hash, file)
  }

  return out
}
