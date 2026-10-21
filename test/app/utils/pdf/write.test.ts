import { describe, expect, it } from 'vitest'

import { readPdf } from '~/utils/pdf/extract'
import { writePdf } from '~/utils/pdf/write'

/**
 * A PDF the app writes is one it — and any viewer — can read back.
 *
 * Checked two ways. The cross-reference table is where a hand-rolled writer
 * goes wrong silently: a viewer reading an offset one byte out rebuilds the
 * table or refuses the file, and nothing on this side notices. And the pages
 * are read back through the app's own reader (`readPdf`), which hands back an
 * embedded JPEG's bytes as they are — so the bytes out must be the bytes in:
 * a page is never re-encoded on its way into the file.
 *
 * Seam: `writePdf` over two small byte strings standing in for JPEGs; nothing
 * here decodes an image.
 */

/** Enough of a JPEG for a reader that keeps its bytes: the markers it starts and ends with. */
const jpeg = (fill: number) => new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, fill, fill, fill, 0xFF, 0xD9])], { type: 'image/jpeg' })

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

describe('writing a PDF', () => {
  it('points every cross-reference entry at the object it names', async () => {
    const pdf = await bytesOf(writePdf([
      { jpeg: jpeg(1), width: 200, height: 300 },
      { jpeg: jpeg(2), width: 400, height: 300 },
    ], { title: 'Chapter — 2' }))

    const text = new TextDecoder('latin1').decode(pdf)
    const start = Number(/startxref\n(\d+)/.exec(text)![1])

    expect(text.slice(start, start + 4)).toBe('xref')

    const [, first, count] = /xref\n(\d+) (\d+)\n/.exec(text.slice(start))!
    const rows = text.slice(start).split('\n').slice(2, 2 + Number(count))

    expect(Number(first)).toBe(0)
    expect(rows).toHaveLength(10)

    for (const [id, row] of rows.entries()) {
      if (id === 0) continue

      const offset = Number(row.slice(0, 10))

      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`)
    }
  })

  it('carries each page\'s JPEG through untouched, in order', async () => {
    const pages = [jpeg(7), jpeg(9)]
    const pdf = await bytesOf(writePdf(pages.map((one) => ({ jpeg: one, width: 10, height: 12 }))))

    const out: Uint8Array[] = []

    for await (const { page } of readPdf(pdf)) {
      if (page) out.push(page.data)
    }

    expect(out).toEqual([await bytesOf(pages[0]!), await bytesOf(pages[1]!)])
  })

  it('sizes a page by its pixels at the resolution asked for', async () => {
    const text = new TextDecoder('latin1').decode(await bytesOf(writePdf([{ jpeg: jpeg(1), width: 3000, height: 4500 }], { dpi: 300 })))

    // 3000 px at 300 dpi is ten inches: 720 points.
    expect(text).toContain('/MediaBox [0 0 720 1080]')
  })
})
