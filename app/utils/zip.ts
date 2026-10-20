/**
 * A zip file, written and read here rather than by a library.
 *
 * The same argument as `utils/idb.ts` and `utils/pdf/`: what is wanted is a
 * container that holds a manifest beside a few hundred image files, and every
 * zip library worth the name brings a deflate implementation this does not
 * need. The scans are already JPEG and PNG — compressing them again spends
 * seconds to grow the file by a percent — so everything but the manifest is
 * **stored**, and the one entry that benefits goes through the browser's own
 * `CompressionStream`. That leaves the format itself, which is three record
 * layouts and a CRC.
 *
 * Zip rather than a container of our own, and that is the decision worth
 * defending. A project file is the one artefact of this app that outlives the
 * app: it is what somebody mails to a collaborator, keeps in a backup, or opens
 * in five years to find out what a chapter said. A bespoke header would make
 * all of that depend on this code still existing. A zip can be opened by
 * anything, and a reader who has lost the app entirely can still get their
 * pages out with the operating system's own unarchiver — which is the whole
 * point of putting the scans in at their original bytes and giving them their
 * real paths.
 *
 * ## Memory
 *
 * A chapter is hundreds of megabytes and must never be held in the heap. Two
 * things keep that true. `Blob` parts are references — `new Blob([a, b, c])`
 * registers the pieces with the browser's blob store and copies nothing — so
 * the finished archive is a list of headers and `File`s rather than their
 * bytes. And every read is streamed: the CRC pass pulls each file through in
 * chunks, and `unzip` hands back `Blob.slice` views, which are also references.
 *
 * The one cost left is that CRC pass. Zip puts the checksum in the header
 * *before* the data, so every byte has to be summed before anything can be
 * written. (The format's escape hatch — a data descriptor after the payload —
 * does not help: the number still has to be computed, and it makes the archive
 * harder for other tools to read.) So it is paid at most once per set of
 * bytes, and twice over it is not paid here at all:
 *
 * - An entry whose sum the caller already has says so (`crc`). The page export
 *   does: its encoders sum each page in the worker that made it, where the
 *   bytes already are, and packing sixty finished PNGs stopped being 0.9 GB read
 *   back through the main thread — about five seconds, measured, before.
 * - An entry whose bytes the caller can *name* says what they are (`digest`),
 *   and the sum is remembered under that name for the session. A project
 *   file's scans are stored, not deflated, and a scan's bytes never change, so
 *   its sum is the same on every save; saving a chapter again reads none of it.
 *
 * The sum itself is `utils/crc32.ts`, at about 1.6 GB/s where the loop it
 * replaced managed 181 MB/s.
 *
 * ## What this deliberately is not
 *
 * No zip64, no encryption, no per-entry comments, no directory entries. The
 * limits that leaves are checked rather than hoped about — see `TOO_BIG` and
 * `TOO_MANY`, which refuse in a sentence instead of writing an archive that
 * silently truncates at four gigabytes.
 */
import { crc32Of } from './crc32'

/** Every entry is stored, except the ones asked to be deflated. */
const STORED = 0
const DEFLATED = 8

/**
 * Names are UTF-8, and the flag saying so.
 *
 * Bit 11. Without it a reader is entitled to decode the name as CP437, which
 * turns every page of a chapter whose folder has a Japanese name into mojibake
 * — in the app *and* in the operating system's unarchiver.
 */
const UTF8 = 0x0800

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const EOCD = 0x06054b50

/** Where the format stops, and what to say when a chapter reaches it. */
const LIMIT = 0xffffffff
const TOO_BIG = 'That chapter is over 4 GB, which is more than a project file can hold.'
const TOO_MANY = 'That chapter has more than 65,535 files in it.'

export interface ZipEntry {
  /** The path inside the archive, `/` separated. */
  name: string
  data: Blob
  /**
   * Whether it is worth compressing. False for anything already compressed,
   * which is every scan and every placed image.
   */
  deflate?: boolean
  /**
   * The CRC-32 of `data`, where the caller has it already — written as given,
   * and `data` is not read for it. A wrong number here is an entry every other
   * tool calls damaged, so it is for a caller that summed these very bytes (the
   * page export's encoders), never one that is guessing.
   */
  crc?: number
  /**
   * What `data` *is*: a digest of its bytes — a scan's or a placed image's
   * SHA-256 — under which its checksum is remembered for the session, so the
   * next archive holding the same bytes does not read them. Never a name or a
   * path: those stay put while the bytes under them change.
   */
  digest?: string
}

/**
 * Checksums already worked out, by the digest of what they are the sum of —
 * see `ZipEntry.digest`. Held for the session rather than written down: the
 * first save after a reload reads its scans once, and every save after it
 * reads none.
 *
 * The size is kept beside each as a check that costs nothing. A digest handed
 * in with the wrong bytes would almost always come with the wrong length too,
 * and then the sum is worked out afresh rather than trusted.
 *
 * Bounded, oldest first, though it would take a long session to matter: an
 * entry is a few dozen bytes, and a chapter is a few hundred of them.
 */
const sums = new Map<string, { crc: number, size: number }>()
const SUMS_KEPT = 4096

/** An entry's checksum: given, remembered, or read — in that order of preference. */
async function checksumOf (entry: ZipEntry): Promise<number> {
  if (entry.crc !== undefined) return entry.crc >>> 0

  const known = entry.digest ? sums.get(entry.digest) : undefined

  if (known && known.size === entry.data.size) return known.crc

  const crc = await crc32Of(entry.data)

  if (entry.digest) {
    sums.delete(entry.digest)
    sums.set(entry.digest, { crc, size: entry.data.size })

    if (sums.size > SUMS_KEPT) sums.delete(sums.keys().next().value!)
  }

  return crc
}

/**
 * The time, as MS-DOS wrote it in 1980.
 *
 * Two packed sixteen-bit fields with two-second resolution, which is what the
 * format has and what every unarchiver reads. Worth writing properly rather
 * than zeroing: a zero date is 1979 and shows up in Finder as such.
 */
function dosTime (at: Date): { time: number, date: number } {
  const year = Math.max(1980, at.getFullYear())

  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

/** A little-endian writer, because every field in the format is one. */
function record (size: number) {
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)

  let at = 0

  return {
    bytes,
    u16 (value: number) {
      view.setUint16(at, value, true)
      at += 2
    },
    u32 (value: number) {
      view.setUint32(at, value >>> 0, true)
      at += 4
    },
    raw (value: Uint8Array) {
      bytes.set(value, at)
      at += value.length
    },
  }
}

interface Placed {
  name: Uint8Array
  crc: number
  /** What went in. */
  size: number
  /** What was written, which differs only for the deflated manifest. */
  compressed: number
  method: number
  offset: number
}

/**
 * Pack entries into an archive.
 *
 * Deflation happens before anything is measured, because a compressed entry's
 * size is not knowable any other way and the header wants it up front. Only the
 * manifest is ever asked for it, and a manifest is a megabyte at worst.
 */
export async function zip (entries: ZipEntry[], at = new Date()): Promise<Blob> {
  if (entries.length > 0xffff) throw new Error(TOO_MANY)

  const { time, date } = dosTime(at)
  const encoder = new TextEncoder()

  const parts: BlobPart[] = []
  const placed: Placed[] = []

  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)

    // The checksum is of what went *in*, never of what deflate made of it —
    // that is what a reader verifies after inflating.
    const crc = await checksumOf(entry)
    const body = entry.deflate ? await deflate(entry.data) : entry.data
    const method = entry.deflate ? DEFLATED : STORED

    if (body.size > LIMIT || entry.data.size > LIMIT || offset + body.size > LIMIT) throw new Error(TOO_BIG)

    const header = record(30 + name.length)

    header.u32(LOCAL)
    header.u16(20)
    header.u16(UTF8)
    header.u16(method)
    header.u16(time)
    header.u16(date)
    header.u32(crc)
    header.u32(body.size)
    header.u32(entry.data.size)
    header.u16(name.length)
    header.u16(0)
    header.raw(name)

    parts.push(header.bytes, body)
    placed.push({ name, crc, size: entry.data.size, compressed: body.size, method, offset })

    offset += header.bytes.length + body.size
  }

  const start = offset
  const directory: BlobPart[] = []

  for (const entry of placed) {
    const header = record(46 + entry.name.length)

    header.u32(CENTRAL)
    // Made by a version 2.0 writer on a filesystem with no attributes of its
    // own to report — which is the honest answer from a browser.
    header.u16(20)
    header.u16(20)
    header.u16(UTF8)
    header.u16(entry.method)
    header.u16(time)
    header.u16(date)
    header.u32(entry.crc)
    header.u32(entry.compressed)
    header.u32(entry.size)
    header.u16(entry.name.length)
    header.u16(0)
    header.u16(0)
    header.u16(0)
    header.u16(0)
    header.u32(0)
    header.u32(entry.offset)
    header.raw(entry.name)

    directory.push(header.bytes)
    offset += header.bytes.length
  }

  const end = record(22)

  end.u32(EOCD)
  end.u16(0)
  end.u16(0)
  end.u16(placed.length)
  end.u16(placed.length)
  end.u32(offset - start)
  end.u32(start)
  end.u16(0)

  return new Blob([...parts, ...directory, end.bytes], { type: 'application/zip' })
}

async function deflate (data: Blob): Promise<Blob> {
  return new Response(data.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob()
}

async function inflate (data: Blob): Promise<Blob> {
  return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob()
}

/**
 * Read an archive back, by its central directory.
 *
 * The directory rather than a walk of the local headers, and that is not a
 * detail: the directory is the authority on what is in a zip — it is what every
 * other reader uses, and it is what survives an archive that was appended to.
 * Walking the front instead would find entries nothing points at any more.
 *
 * Stored entries come back as slices, which cost nothing until something reads
 * them. Only the deflated ones are actually materialised.
 */
export async function unzip (source: Blob): Promise<Map<string, Blob>> {
  const end = await locate(source)

  if (!end) throw new Error('That file is not a zip — no end-of-archive record.')

  const view = new DataView(await source.slice(end.at, end.at + 22).arrayBuffer())
  const count = view.getUint16(10, true)
  const size = view.getUint32(12, true)
  const start = view.getUint32(16, true)

  const directory = new DataView(await source.slice(start, start + size).arrayBuffer())
  const decoder = new TextDecoder()
  const out = new Map<string, Blob>()

  let at = 0

  for (let index = 0; index < count; index++) {
    if (directory.getUint32(at, true) !== CENTRAL) throw new Error('That archive’s index is damaged.')

    const method = directory.getUint16(at + 10, true)
    const compressed = directory.getUint32(at + 20, true)
    const nameLength = directory.getUint16(at + 28, true)
    const extraLength = directory.getUint16(at + 30, true)
    const commentLength = directory.getUint16(at + 32, true)
    const offset = directory.getUint32(at + 42, true)

    const name = decoder.decode(new Uint8Array(directory.buffer, at + 46, nameLength))

    // The local header's own extra field is allowed to differ in length from
    // the one recorded here, so where the data starts has to be read from the
    // local header rather than worked out from this one. Writers that pad for
    // alignment do exactly that, and an archive from one of them would
    // otherwise come back offset by a few bytes per entry.
    const local = new DataView(await source.slice(offset, offset + 30).arrayBuffer())

    if (local.getUint32(0, true) !== LOCAL) throw new Error(`“${name}” is not where the archive says it is.`)

    const from = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true)
    const slice = source.slice(from, from + compressed)

    // A directory entry — a name ending in `/`, with nothing in it. Nothing
    // here makes them, and an archive from elsewhere may.
    if (!name.endsWith('/')) {
      if (method === STORED) out.set(name, slice)
      else if (method === DEFLATED) out.set(name, await inflate(slice))
      else throw new Error(`“${name}” uses a compression this can’t read.`)
    }

    at += 46 + nameLength + extraLength + commentLength
  }

  return out
}

/**
 * Find the end-of-archive record, searching backwards.
 *
 * It is the last twenty-two bytes of a zip with no comment, and further in by
 * however long the comment is — up to sixty-four kilobytes. So the tail is read
 * and scanned rather than the fixed offset being assumed, which is what lets a
 * file that has been through some other tool still open.
 */
async function locate (source: Blob): Promise<{ at: number } | null> {
  const span = Math.min(source.size, 22 + 0xffff)
  const from = source.size - span
  const tail = new DataView(await source.slice(from).arrayBuffer())

  for (let at = span - 22; at >= 0; at--) {
    if (tail.getUint32(at, true) === EOCD) return { at: from + at }
  }

  return null
}

/**
 * Whether a name from an archive is safe to take at face value.
 *
 * Nothing here writes to a real filesystem — page paths are folded into one
 * OPFS name by `encodeURIComponent`, which neuters a `..` on its own — so this
 * is a belt rather than the only thing holding the trousers up. It is worth
 * having anyway: an imported project's paths are also what get written into
 * `pages.path` and shown to the reader, and a path that climbs out of the
 * archive is a file nobody meant to send.
 */
export function safeName (name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\')) return false

  return !name.split('/').includes('..')
}
