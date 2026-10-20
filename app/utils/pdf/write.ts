/**
 * A PDF of pictures: one page per image, each a JPEG shown whole.
 *
 * Hand-rolled for the reason the reader beside it is (`extract.ts`): what is
 * needed is a sliver of the format, and every library that writes PDFs brings
 * the rest of it along. A page here is an image XObject with the JPEG's own
 * bytes as its stream (`/DCTDecode` — a PDF viewer decodes a JPEG natively, so
 * nothing is re-encoded), a content stream that paints it over the page, and
 * the page that holds both. Then the cross-reference table, which is the one
 * fiddly part: every object's byte offset, which is why the file is assembled
 * as a list of parts with their lengths counted rather than as one string.
 *
 * Built as a `Blob` of parts, the way the zip writer builds an archive, so a
 * chapter of full-resolution pages is never one buffer in the heap.
 */

/** One page to write: the JPEG, and its size in pixels. */
export interface PdfImagePage {
  jpeg: Blob
  width: number
  height: number
}

export interface PdfOptions {
  /**
   * How many image pixels to an inch, which sets the page's printed size. A
   * comic scanned at 300 dpi comes out at the size it was printed; the pixels
   * are all there whatever this says.
   */
  dpi?: number
  /** The document's title, as a viewer shows it. */
  title?: string
}

const ascii = new TextEncoder()

/**
 * A PDF text string. Plain ASCII as a literal, with the three characters a
 * literal cannot hold escaped; anything else as UTF-16BE with its byte-order
 * mark, which is how a PDF says Unicode in a text string.
 */
function pdfText (text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`

  let hex = 'FEFF'

  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()

  return `<${hex}>`
}

/** A length in points, to two places — plenty for a page, and short. */
const pt = (value: number) => String(Math.round(value * 100) / 100)

export function writePdf (pages: PdfImagePage[], options: PdfOptions = {}): Blob {
  const dpi = options.dpi ?? 300
  const parts: BlobPart[] = []
  const offsets: number[] = []
  let length = 0

  const put = (part: string | Blob) => {
    if (typeof part === 'string') {
      const bytes = ascii.encode(part)

      parts.push(bytes)
      length += bytes.length
    } else {
      parts.push(part)
      length += part.size
    }
  }

  /** Begin object `id` here, noting where it starts. */
  const open = (id: number) => {
    offsets[id] = length
    put(`${id} 0 obj\n`)
  }

  // A binary comment on the second line, as the specification recommends, so
  // that anything guessing whether the file is text guesses no. Bytes rather
  // than a string: encoded, those four characters would be eight.
  put('%PDF-1.4\n')
  put(new Blob([new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])]))

  // 1 is the catalog, 2 the page tree, 3 the document's details; each page is
  // then three objects — the page, its content, its image — from 4 on.
  const pageId = (index: number) => 4 + index * 3
  const kids = pages.map((_, index) => `${pageId(index)} 0 R`).join(' ')

  open(1)
  put('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

  open(2)
  put(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`)

  open(3)
  put(`<< /Producer (Kemolate)${options.title ? ` /Title ${pdfText(options.title)}` : ''} >>\nendobj\n`)

  for (const [index, page] of pages.entries()) {
    const id = pageId(index)
    const w = (page.width * 72) / dpi
    const h = (page.height * 72) / dpi
    const draw = `q ${pt(w)} 0 0 ${pt(h)} 0 0 cm /Im0 Do Q\n`

    open(id)
    put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(w)} ${pt(h)}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>\nendobj\n`)

    open(id + 1)
    put(`<< /Length ${ascii.encode(draw).length} >>\nstream\n${draw}endstream\nendobj\n`)

    open(id + 2)
    put(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.size} >>\nstream\n`)
    put(page.jpeg)
    put('\nendstream\nendobj\n')
  }

  const count = 4 + pages.length * 3
  const xref = length

  // Every entry exactly twenty bytes, the space before the newline included —
  // the table is read by position, not parsed.
  put(`xref\n0 ${count}\n0000000000 65535 f \n`)

  for (let id = 1; id < count; id++) put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)

  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  return new Blob(parts, { type: 'application/pdf' })
}
