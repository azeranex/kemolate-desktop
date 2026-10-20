/**
 * A lettering plate, drawn as the board draws it, into a canvas the scan's size.
 *
 * The board letters with HTML — flex boxes, wrapping, vertical writing, text
 * strokes — and the one way to get *that* into pixels, rather than a second
 * layout that only resembles it, is to have the browser lay the same HTML out
 * again and hand back the picture: XHTML inside an SVG `<foreignObject>`, drawn
 * as an image. The CSS on each box is the board's own (`app/utils/letterCss`),
 * at a scale of one scan pixel to one pixel.
 *
 * Two things an SVG image cannot do, and what is done about them:
 *
 * - **Fetch anything.** An SVG drawn as an image is sealed: no stylesheets, no
 *   font files, nothing by URL. So the `@font-face` rules for the faces in use
 *   are copied out of the page's stylesheets with every font file inlined as a
 *   data URL (`faceRules`), narrowed to the subsets whose `unicode-range` the
 *   text actually touches — fontsource splits a face into a dozen files.
 * - **Be read back, sometimes.** A browser may treat a `foreignObject` image as
 *   cross-origin and taint the canvas it is drawn on, after which the export
 *   cannot read it. Chrome does not for a data URL that references nothing; a
 *   browser that does is reported rather than handed a blank page.
 */
import type { CSSProperties } from 'vue'
import type { ShapeParts } from '~/utils/letterCss'

/** One box of lettering: where it sits, how it is set, what it says. */
export interface LetterItem {
  place: CSSProperties
  set: CSSProperties
  line: CSSProperties
  /** The shape its lines wrap into, as the board sets it — `shapeParts` — or null for the plain box. */
  parts?: ShapeParts | null
  /** The language it is in, which hyphenation looks words up in. */
  lang?: string
  text: string
}

/** A font file's data URL, by its URL, kept for the session — every page asks for the same few. */
const inlined = new Map<string, Promise<string | null>>()

async function asDataUrl (url: string): Promise<string | null> {
  const held = inlined.get(url)

  if (held) return held

  const reading = fetch(url)
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => blob && new Promise<string | null>((resolve) => {
      const reader = new FileReader()

      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    }))
    .catch(() => null)

  inlined.set(url, reading)

  return reading
}

/** Every `@font-face` rule the document has, stylesheet imports followed. */
function fontFaceRules (): { rule: CSSFontFaceRule, base: string }[] {
  const out: { rule: CSSFontFaceRule, base: string }[] = []

  const walk = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList

    try {
      rules = sheet.cssRules
    } catch {
      // A stylesheet from another origin, which cannot be read — and holds
      // none of this app's faces.
      return
    }

    const base = sheet.href ?? location.href

    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) out.push({ rule, base })
      else if (rule instanceof CSSImportRule && rule.styleSheet) walk(rule.styleSheet)
    }
  }

  for (const sheet of document.styleSheets) walk(sheet)

  return out
}

/** The families a `font-family` stack names, unquoted. */
const familiesOf = (stack: string) => stack.split(',').map((one) => one.trim().replace(/^["']|["']$/g, '')).filter(Boolean)

/** Whether a `unicode-range` descriptor covers any of these code points. Absent covers everything. */
function touches (range: string, points: Set<number>): boolean {
  if (!range.trim()) return true

  for (const part of range.split(',')) {
    const spec = part.trim().replace(/^u\+/i, '')
    const [from, to] = spec.includes('-')
      ? spec.split('-').map((hex) => Number.parseInt(hex, 16))
      : spec.includes('?')
        ? [Number.parseInt(spec.replace(/\?/g, '0'), 16), Number.parseInt(spec.replace(/\?/g, 'F'), 16)]
        : [Number.parseInt(spec, 16), Number.parseInt(spec, 16)]

    if (from === undefined || to === undefined || Number.isNaN(from) || Number.isNaN(to)) return true

    for (const point of points) if (point >= from && point <= to) return true
  }

  return false
}

/**
 * The `@font-face` rules for these families, each font file inlined, narrowed
 * to the subsets that hold characters from `text`.
 */
async function faceRules (families: Set<string>, text: string): Promise<string> {
  const points = new Set([...text].map((char) => char.codePointAt(0)!))
  const wanted = fontFaceRules().filter(({ rule }) => {
    const family = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '')

    return families.has(family) && touches(rule.style.getPropertyValue('unicode-range'), points)
  })

  const rules = await Promise.all(wanted.map(async ({ rule, base }) => {
    let css = rule.cssText
    const urls = [...css.matchAll(/url\((["']?)([^"')]+)\1\)/g)]

    for (const [whole, , url] of urls) {
      if (!url || url.startsWith('data:')) continue

      const data = await asDataUrl(new URL(url, base).href)

      // A file that would not come is left out of the rule rather than left
      // pointing somewhere the image cannot go.
      css = css.replace(whole, data ? `url("${data}")` : 'url("")')
    }

    return css
  }))

  return rules.join('\n')
}

/** CSS properties as an inline `style` value. */
function inline (style: CSSProperties): string {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => {
      const property = name.startsWith('Webkit')
        ? `-webkit-${name.slice(6).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`.replace('-webkit--', '-webkit-')
        : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

      return `${property}:${String(value)}`
    })
    .join(';')
}

/** Text and attribute values made safe for XML. */
const xml = (text: string) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** The same frame the board puts each box in — `absolute flex overflow-hidden`. */
const FRAME = 'position:absolute;display:flex;overflow:hidden;box-sizing:border-box'

async function svgImage (svg: string): Promise<HTMLImageElement> {
  const image = new Image()

  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  await image.decode()

  return image
}

/** A small drawing of an image, as a number — enough to tell two renderings of a page's lettering apart. */
function fingerprint (image: HTMLImageElement, size: { width: number, height: number }): number {
  const width = 384
  const height = Math.max(1, Math.round((size.height / size.width) * width))
  const canvas = document.createElement('canvas')

  canvas.width = width
  canvas.height = height

  const c = canvas.getContext('2d', { willReadFrequently: true })

  if (!c) return 0

  c.drawImage(image, 0, 0, width, height)

  const data = c.getImageData(0, 0, width, height).data
  let hash = 0

  for (let i = 3; i < data.length; i += 4) hash = (Math.imul(hash, 31) + data[i]!) | 0

  return hash
}

/** How long a page waits for its faces before it is drawn in whatever it has. */
const FACE_WAIT = 3000

/**
 * Wait until the faces inlined into the lettering are the ones it is drawn in.
 *
 * Desktop: the web build's file drew the image as soon as it decoded, and
 * `decode()` does not wait for an SVG image's own `@font-face` rules — the font
 * files are data URLs, but they are still loaded after the image is. So a page
 * whose faces had not landed yet was drawn in the generic fallback, and every
 * line was set in a face it had not been fitted in: wider, so a line fitted to
 * its balloon's shape no longer fitted beside the floats that carve it, wrapped
 * below its frame and was clipped away entirely. The first export of a session
 * came out in Arial with two balloons empty on the test chapter's first page;
 * the same SVG drawn a moment later was right.
 *
 * So the image is compared with the same lettering drawn with no faces at all
 * (`bare`) — exactly what the image shows until its faces arrive, since every
 * rule here is `font-display: swap` — and drawn once the two differ. A page
 * whose faces were already in hand differs at once and waits for nothing. One
 * that never differs (a face whose glyphs the text does not use) is drawn after
 * `FACE_WAIT`, as it would have been before.
 */
async function facesIn (image: HTMLImageElement, bare: HTMLImageElement, size: { width: number, height: number }) {
  const without = fingerprint(bare, size)
  const until = performance.now() + FACE_WAIT

  while (fingerprint(image, size) === without && performance.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

export class TaintedLettering extends Error {
  constructor () {
    super('This browser will not let a page\'s lettering be read back into an image.')
  }
}

/**
 * Draw one plate's lettering at the scan's size. Null where there is nothing
 * on it.
 */
export async function drawLettering (size: { width: number, height: number }, items: LetterItem[]): Promise<HTMLCanvasElement | null> {
  if (!items.length) return null

  const families = new Set(items.flatMap((item) => familiesOf(String(item.set.fontFamily ?? ''))))
  const faces = await faceRules(families, items.map((item) => item.text).join(''))

  // The same markup as `CanvasLetterWords`, piece for piece — including no
  // whitespace between the floats and the words, which would be a text node the
  // fit never measured.
  const words = (item: LetterItem) => (item.parts
    ? `<span style="${xml(inline(item.parts.container))}"><i style="${xml(inline(item.parts.start))}"></i><i style="${xml(inline(item.parts.end))}"></i><i style="${xml(inline(item.parts.spacer))}"></i>${xml(item.text)}</span>`
    : `<span style="${xml(inline(item.line))}">${xml(item.text)}</span>`)

  const boxes = items.map((item) => `<div${item.lang ? ` lang="${xml(item.lang)}"` : ''} style="${xml(`${FRAME};${inline(item.place)};${inline(item.set)}`)}">${words(item)}</div>`).join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">` +
    `<foreignObject x="0" y="0" width="${size.width}" height="${size.height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${size.width}px;height:${size.height}px;margin:0">` +
    `<style>${xml(faces)}</style>${boxes}</div></foreignObject></svg>`

  const image = await svgImage(svg)

  if (faces) await facesIn(image, await svgImage(svg.replace(`<style>${xml(faces)}</style>`, '')), size)

  const canvas = document.createElement('canvas')

  canvas.width = size.width
  canvas.height = size.height

  const c = canvas.getContext('2d')

  if (!c) return null

  c.drawImage(image, 0, 0, size.width, size.height)

  // Read one pixel back, so a browser that taints the canvas says so here
  // rather than as a blank page, or an error from deep inside the export.
  try {
    c.getImageData(0, 0, 1, 1)
  } catch {
    throw new TaintedLettering()
  }

  return canvas
}
