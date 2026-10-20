/**
 * Where the pictures drawn over a scan lie on it — a page's repairs, and a
 * placed picture — in scan pixels.
 *
 * Two readers, and they must agree: the page engine, drawing the page, and the
 * paint surfaces' sampling tools, reading what is under them (`paint/under.ts`).
 * A clone stamp that copied a repair from a place a pixel away from where the
 * page shows it would be a repair drawn twice, once slightly wrong.
 */
import type { PlacedImage } from '#shared/utils/layers'
import type { PagePatch } from '~/composables/useClean'

/**
 * A picture over the scan: its URL and where it lies, in scan pixels — and for
 * a repair, its block and the name it is filed under (`patchKey`), which is
 * what a page's cleaning is recognised by across sessions (`cleaningSignature`).
 */
export interface Over { url: string, sx: number, sy: number, sw: number, sh: number, block?: string, key?: string }

/**
 * A page's repairs, as the clean plate would draw them — block by block, each
 * the repair `stands` says is still this scan's.
 */
export function repairOvers (
  page: ComicPage,
  held: Record<string, PagePatch> | undefined,
  stands: (patch: PagePatch | undefined, scan: ComicPage['scan']) => boolean,
): Over[] {
  const own = page.scan

  if (!own || !held) return []

  return page.blocks.flatMap((block) => {
    const patch = held[block.id]

    if (!patch || !stands(patch, own)) return []

    return [{
      block: block.id,
      ...(patch.key ? { key: patch.key } : {}),
      url: patch.url,
      sx: (patch.x / 100) * own.width,
      sy: (patch.y / 100) * own.height,
      sw: (patch.w / 100) * own.width,
      sh: (patch.h / 100) * own.height,
    }]
  })
}

/**
 * A placed picture, fitted inside the page and centred — what `object-contain`
 * did to it as an element, so a clean raw of the wrong shape still shows as a
 * band down one side rather than a page stretched to fit.
 */
export function placedOver (page: { width: number, height: number }, image: PlacedImage, url: string): Over | null {
  if (!page.width || !image.width || !image.height) return null

  const fit = Math.min(page.width / image.width, page.height / image.height)
  const sw = image.width * fit
  const sh = image.height * fit

  return { url, sx: (page.width - sw) / 2, sy: (page.height - sh) / 2, sw, sh }
}
