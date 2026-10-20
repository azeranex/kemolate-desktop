/**
 * A PDF read the way repair tools read one: by walking the bytes for objects,
 * not by trusting the cross-reference table.
 *
 * The table is a promise about where things are, and it is the part of a PDF
 * most often broken — truncated downloads, sloppy generators, incremental
 * saves stacked on incremental saves. Every serious reader falls back to
 * scanning the file for `N G obj` when the table lets it down, and since the
 * scan alone reads every file the table would have and more, the table is
 * skipped outright. Objects found later in the file replace earlier ones,
 * which is also exactly what an incremental update means.
 *
 * This exists for one purpose — `extract.ts` pulling the original images back
 * out of a PDF of scanned pages — so it parses everything and judges nothing.
 * What a dictionary means is the caller's business.
 */
import { PdfPasswordError, unlock } from './decrypt'
import { ascii85, asciiHex, inflate, lzw, runLength, unpredict } from './filters'

import type { Decryptor } from './decrypt'

/** `/Name` — its own type so a name never gets mistaken for a string. */
export class PdfName {
  readonly name: string

  constructor (name: string) {
    this.name = name
  }
}

/** `12 0 R` — a pointer to an object, resolved through the document. */
export class PdfRef {
  readonly num: number
  readonly gen: number

  constructor (num: number, gen: number) {
    this.num = num
    this.gen = gen
  }
}

/** A stream: its dictionary, and its bytes exactly as they sit in the file. */
export interface PdfStream {
  dict: PdfDict
  raw: Uint8Array
  /**
   * Which object this is, where it was read straight from the file.
   *
   * Only encryption wants it, and encryption needs it badly: in every revision
   * before AES-256 a stream is encrypted under a key mixed with its own object
   * number, so bytes without a number attached cannot be decrypted at all. A
   * stream unpacked from inside an object stream has none and needs none — its
   * container was already decrypted whole.
   */
  num?: number
  gen?: number
}

export type PdfDict = Map<string, PdfValue>

/** Strings come back as bytes — a palette lookup string is not text. */
export type PdfValue = number | boolean | null | Uint8Array | PdfName | PdfRef | PdfValue[] | PdfDict | PdfStream

export function isStream (value: PdfValue | undefined): value is PdfStream {
  return typeof value === 'object' && value !== null && 'dict' in value && 'raw' in value
}

export function isDict (value: PdfValue | undefined): value is PdfDict {
  return value instanceof Map
}

/** The `/Type` or other name entry of a dictionary, as a plain string. */
export function nameOf (value: PdfValue | undefined): string | null {
  return value instanceof PdfName ? value.name : null
}

export class PdfDocument {
  /** Every object that could be read, by number. The last definition won. */
  readonly objects = new Map<number, PdfValue>()

  /** Every trailer dictionary found, in file order. */
  readonly trailers: PdfDict[] = []

  /**
   * How to read this file's streams, where it is encrypted — see `decrypt.ts`.
   * Null is the ordinary case: nothing to undo.
   */
  decryptor: Decryptor | null = null

  /**
   * A stream's bytes as the file meant them, decrypted where they were not.
   *
   * Everything that reads a stream goes through here rather than touching
   * `raw`, because on an encrypted file `raw` is ciphertext and nothing
   * downstream — not the filters, not the image extractor — would have any way
   * of knowing. Not cached on purpose: each stream is read once on the way to
   * becoming a page, and holding decrypted copies of a whole chapter would
   * double what a locked file costs to open.
   */
  async bytes (stream: PdfStream): Promise<Uint8Array> {
    if (!this.decryptor || stream.num === undefined) return stream.raw

    // Cross-reference streams are never encrypted — they are the map you need
    // in order to find the encryption dictionary in the first place.
    if (nameOf(this.entry(stream.dict, 'Type')) === 'XRef') return stream.raw

    return this.decryptor.stream(stream.raw, stream.num, stream.gen ?? 0)
  }

  /** Follow references until something real, with a guard against loops. */
  resolve (value: PdfValue | undefined): PdfValue | undefined {
    let out = value
    const seen = new Set<number>()

    while (out instanceof PdfRef) {
      if (seen.has(out.num)) return undefined

      seen.add(out.num)
      out = this.objects.get(out.num)
    }

    return out
  }

  /** A dictionary entry, resolved — the shape almost every lookup takes. */
  entry (dict: PdfDict | undefined, key: string): PdfValue | undefined {
    return this.resolve(dict?.get(key))
  }

  /** A numeric entry, or the fallback: `Width`, `BitsPerComponent`, `N`… */
  int (dict: PdfDict | undefined, key: string, fallback = 0): number {
    const value = this.entry(dict, key)

    return typeof value === 'number' ? Math.trunc(value) : fallback
  }
}

const SPACE = [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]
const DELIMS = '()<>[]{}/%'

function isSpace (byte: number | undefined) {
  return byte === undefined || SPACE.includes(byte)
}

function isDelim (byte: number | undefined) {
  return byte !== undefined && DELIMS.includes(String.fromCharCode(byte))
}

function isRegular (byte: number | undefined) {
  return !isSpace(byte) && !isDelim(byte)
}

function isDigit (byte: number | undefined) {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39
}

/**
 * One value read off the bytes, wherever `pos` points.
 *
 * `resolveLength` is the lexer's one window on the wider document: a stream
 * says how long it is in its dictionary, and the saying can be an indirect
 * reference to a number elsewhere in the file. Where even that fails, the
 * bytes are searched for `endstream`, which is what the length was promising
 * to make unnecessary.
 */
export class Lexer {
  readonly bytes: Uint8Array
  pos: number
  private resolveLength: (ref: PdfRef) => PdfValue | undefined

  constructor (bytes: Uint8Array, pos = 0, resolveLength: (ref: PdfRef) => PdfValue | undefined = () => undefined) {
    this.bytes = bytes
    this.pos = pos
    this.resolveLength = resolveLength
  }

  skip () {
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos]

      if (isSpace(byte)) {
        this.pos++
      } else if (byte === 0x25) {
        // A comment runs to the end of its line.
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a && this.bytes[this.pos] !== 0x0d) this.pos++
      } else {
        return
      }
    }
  }

  value (depth = 0): PdfValue {
    if (depth > 64) throw new Error('too deep')

    this.skip()

    const byte = this.bytes[this.pos]

    if (byte === undefined) throw new Error('ended early')

    if (byte === 0x2f) return this.name()
    if (byte === 0x28) return this.literalString()
    if (byte === 0x5b) return this.array(depth)

    if (byte === 0x3c) {
      if (this.bytes[this.pos + 1] === 0x3c) return this.dictOrStream(depth)

      return this.hexString()
    }

    if (isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e) return this.numberOrRef()

    if (this.word('true')) return true
    if (this.word('false')) return false
    if (this.word('null')) return null

    throw new Error(`unexpected byte ${byte} at ${this.pos}`)
  }

  /** A bare keyword at the cursor, taken only if it is there whole. */
  word (text: string) {
    for (let i = 0; i < text.length; i++) {
      if (this.bytes[this.pos + i] !== text.charCodeAt(i)) return false
    }

    if (isRegular(this.bytes[this.pos + text.length])) return false

    this.pos += text.length

    return true
  }

  private name (): PdfName {
    this.pos++

    let out = ''

    while (isRegular(this.bytes[this.pos])) {
      let byte = this.bytes[this.pos]!

      // `#41` is `A` — two hex digits escaped into the name.
      if (byte === 0x23) {
        const high = parseInt(String.fromCharCode(this.bytes[this.pos + 1] ?? 0), 16)
        const low = parseInt(String.fromCharCode(this.bytes[this.pos + 2] ?? 0), 16)

        if (!Number.isNaN(high) && !Number.isNaN(low)) {
          byte = (high << 4) | low
          this.pos += 2
        }
      }

      out += String.fromCharCode(byte)
      this.pos++
    }

    return new PdfName(out)
  }

  private literalString (): Uint8Array {
    this.pos++

    const out: number[] = []
    let open = 1

    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos++]!

      if (byte === 0x5c) {
        const next = this.bytes[this.pos++]

        if (next === undefined) break

        if (next === 0x6e) out.push(0x0a)
        else if (next === 0x72) out.push(0x0d)
        else if (next === 0x74) out.push(0x09)
        else if (next === 0x62) out.push(0x08)
        else if (next === 0x66) out.push(0x0c)
        else if (next >= 0x30 && next <= 0x37) {
          // Up to three octal digits.
          let code = next - 0x30

          for (let i = 0; i < 2 && this.bytes[this.pos]! >= 0x30 && this.bytes[this.pos]! <= 0x37; i++) {
            code = (code << 3) | (this.bytes[this.pos++]! - 0x30)
          }

          out.push(code & 0xff)
        } else if (next === 0x0d) {
          // A backslash before a line break continues the string; CRLF is one break.
          if (this.bytes[this.pos] === 0x0a) this.pos++
        } else if (next !== 0x0a) {
          out.push(next)
        }

        continue
      }

      if (byte === 0x28) open++

      if (byte === 0x29) {
        open--

        if (!open) break
      }

      if (open) out.push(byte)
    }

    return Uint8Array.from(out)
  }

  private hexString (): Uint8Array {
    this.pos++

    const end = this.bytes.indexOf(0x3e, this.pos)
    const stop = end < 0 ? this.bytes.length : end
    const out = asciiHex(this.bytes.subarray(this.pos, stop))

    this.pos = stop + 1

    return out
  }

  private array (depth: number): PdfValue[] {
    this.pos++

    const out: PdfValue[] = []

    for (;;) {
      this.skip()

      if (this.bytes[this.pos] === 0x5d) {
        this.pos++

        return out
      }

      if (this.pos >= this.bytes.length) return out

      out.push(this.value(depth + 1))
    }
  }

  private dictOrStream (depth: number): PdfDict | PdfStream {
    this.pos += 2

    const dict: PdfDict = new Map()

    for (;;) {
      this.skip()

      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2

        break
      }

      if (this.bytes[this.pos] !== 0x2f) {
        if (this.pos >= this.bytes.length) break

        // Junk where a key should be. Step over it rather than spin on it.
        this.pos++

        continue
      }

      const key = this.name().name

      dict.set(key, this.value(depth + 1))
    }

    this.skip()

    if (!this.word('stream')) return dict

    // The keyword is followed by CRLF or LF; a lone CR turns up from careless
    // writers and is tolerated the same way.
    if (this.bytes[this.pos] === 0x0d) this.pos++
    if (this.bytes[this.pos] === 0x0a) this.pos++

    return this.stream(dict)
  }

  private stream (dict: PdfDict): PdfStream {
    const start = this.pos
    const length = this.lengthOf(dict)

    if (length !== null && start + length <= this.bytes.length) {
      const after = new Lexer(this.bytes, start + length)

      after.skip()

      if (after.word('endstream')) {
        this.pos = after.pos

        return { dict, raw: this.bytes.subarray(start, start + length) }
      }
    }

    // The declared length was missing or a lie. `endstream` is findable
    // anyway, and a trailing line break before it belongs to the file, not
    // the data.
    let end = find(this.bytes, 'endstream', start)

    if (end < 0) end = this.bytes.length

    let stop = end

    if (this.bytes[stop - 1] === 0x0a) stop--
    if (this.bytes[stop - 1] === 0x0d) stop--

    this.pos = Math.min(end + 'endstream'.length, this.bytes.length)

    return { dict, raw: this.bytes.subarray(start, stop) }
  }

  private lengthOf (dict: PdfDict): number | null {
    let length = dict.get('Length')

    if (length instanceof PdfRef) length = this.resolveLength(length) ?? undefined

    return typeof length === 'number' && length >= 0 ? Math.trunc(length) : null
  }

  private numberOrRef (): number | PdfRef {
    const first = this.number()

    if (!Number.isInteger(first) || first < 0) return first

    // `12 0 R` — two integers and an R. Anything else backtracks to the number.
    const save = this.pos

    this.skip()

    if (isDigit(this.bytes[this.pos])) {
      const gen = this.number()

      if (Number.isInteger(gen) && gen >= 0) {
        this.skip()

        if (this.word('R')) return new PdfRef(first, gen)
      }
    }

    this.pos = save

    return first
  }

  private number (): number {
    const start = this.pos

    if (this.bytes[this.pos] === 0x2b || this.bytes[this.pos] === 0x2d) this.pos++

    while (isDigit(this.bytes[this.pos]) || this.bytes[this.pos] === 0x2e) this.pos++

    const text = ascii(this.bytes.subarray(start, this.pos))
    const value = parseFloat(text)

    if (Number.isNaN(value)) throw new Error(`not a number at ${start}`)

    return value
  }
}

/**
 * The whole file, read.
 *
 * Async for one reason: object streams — the spec's way of packing small
 * objects inside a compressed stream — have to be inflated before what is in
 * them can be seen, and inflating goes through the browser's streams.
 */
export async function parsePdf (bytes: Uint8Array, password?: string): Promise<PdfDocument> {
  const doc = new PdfDocument()
  const found = scan(bytes)

  // Definitions by number, latest file position first — later writes are
  // incremental updates and win. Parsed lazily and memoised, because a
  // stream's length can point at a number that has not been read yet.
  const places = new Map<number, number[]>()

  for (const { num, at } of found.objects) {
    const list = places.get(num) ?? []

    list.push(at)
    places.set(num, list)
  }

  const parsed = new Map<number, PdfValue | undefined>()
  const busy = new Set<number>()

  const get = (num: number): PdfValue | undefined => {
    if (parsed.has(num)) return parsed.get(num)
    if (busy.has(num)) return undefined

    busy.add(num)

    let value: PdfValue | undefined

    const offsets = places.get(num) ?? []

    for (let i = offsets.length - 1; i >= 0; i--) {
      try {
        const lexer = new Lexer(bytes, offsets[i]!, (ref) => get(ref.num))

        // Step over the `N G obj` header the scan found, then read what it
        // introduces. A header that is not one is a false hit, and throwing
        // here is what discards it.
        if (typeof lexer.value() !== 'number') throw new Error('not a header')

        const gen = lexer.value()

        if (typeof gen !== 'number') throw new Error('not a header')

        lexer.skip()

        if (!lexer.word('obj')) throw new Error('not a header')

        value = lexer.value()

        // Stamped with whose it is, which only encryption asks about. A stream
        // is always an object in its own right, so this is the one place the
        // number is known and the one place it can be recorded.
        if (isStream(value)) {
          value.num = num
          value.gen = gen
        }

        break
      } catch {
        // A false hit from the scan — some bytes inside a stream that spelled
        // `obj` — or a genuinely broken object. The next-older definition, if
        // any, gets its chance.
      }
    }

    busy.delete(num)
    parsed.set(num, value)

    return value
  }

  const at = new Map<number, number>()

  for (const [num, offsets] of places) {
    const value = get(num)

    if (value === undefined) continue

    doc.objects.set(num, value)
    at.set(num, offsets[offsets.length - 1]!)
  }

  for (const offset of found.trailers) {
    try {
      const lexer = new Lexer(bytes, offset, (ref) => doc.resolve(ref))
      const dict = lexer.value()

      if (isDict(dict)) doc.trailers.push(dict)
    } catch {
      // A trailer that will not parse tells us nothing, which is what we had.
    }
  }

  // Before anything that reads bytes rather than structure. A locked file's
  // shape is in the clear — that is how the encryption dictionary itself can
  // be found — but every stream in it, object streams included, is ciphertext
  // until this has been settled.
  await unlockIfNeeded(doc, password)

  // Objects hiding inside object streams. A child counts as being wherever
  // its container is, so an incremental update still lands on top of it.
  for (const [num, value] of [...doc.objects]) {
    if (!isStream(value) || nameOf(doc.entry(value.dict, 'Type')) !== 'ObjStm') continue

    try {
      const inside = await packed(doc, value)

      for (const child of inside) {
        const where = at.get(child.num)

        if (where !== undefined && where > at.get(num)!) continue

        doc.objects.set(child.num, child.value)
        at.set(child.num, at.get(num)!)
      }
    } catch {
      // An object stream that will not open loses only what was in it.
    }
  }

  return doc
}

/**
 * Settle whether this file is locked, and open it if it is.
 *
 * The empty password is tried before anybody is asked for one, and that is not
 * a shortcut — it is the common case. A great many "protected" PDFs carry only
 * an *owner* password: the producer set restrictions on printing or copying
 * and left the document itself readable, so every reader opens it without
 * asking and this one should too. Only a file that will not open with nothing
 * is a file worth interrupting somebody over.
 */
async function unlockIfNeeded (doc: PdfDocument, password?: string) {
  const dict = encryptionOf(doc)

  if (!dict) {
    // A file that says it is encrypted and then does not say how. Carrying on
    // as though it were plaintext is the one thing not to do: every stream in
    // it would inflate to noise and the file would be reported as having no
    // images in it, which is both wrong and unhelpful.
    if (declaresEncryption(doc)) {
      throw new Error('This PDF says it is encrypted, but its encryption details are missing or damaged.')
    }

    return
  }

  const opened = await unlock(dict, firstId(doc), password ?? '', (value) => doc.resolve(value))

  // Wrong, rather than broken. The caller turns this into a prompt the first
  // time and into "that didn't work" every time after.
  if (!opened) throw new PdfPasswordError(password !== undefined)

  doc.decryptor = opened

  // Strings are encrypted too, and a palette arrives as one — an indexed
  // image whose lookup table is still ciphertext comes out as confetti. The
  // encryption dictionary is left alone: what is in it is the lock itself, and
  // it was never encrypted.
  const skip = doc.trailers.map((trailer) => trailer.get('Encrypt'))
    .concat([...doc.objects.entries()]
      .filter(([, value]) => isStream(value) && nameOf(doc.entry(value.dict, 'Type')) === 'XRef')
      .map(([, value]) => (value as PdfStream).dict.get('Encrypt')))
    .filter((value): value is PdfRef => value instanceof PdfRef)
    .map((ref) => ref.num)

  for (const [num, value] of doc.objects) {
    if (skip.includes(num)) continue

    await decryptStrings(doc, value, num, new Set())
  }
}

/** Every string under a value, decrypted where it sits. */
async function decryptStrings (doc: PdfDocument, value: PdfValue, num: number, seen: Set<PdfValue>) {
  if (!value || typeof value !== 'object' || seen.has(value)) return

  seen.add(value)

  const one = async (entry: PdfValue | undefined) => {
    if (entry instanceof Uint8Array) return doc.decryptor!.string(entry, num, 0)

    if (entry) await decryptStrings(doc, entry, num, seen)

    return null
  }

  if (Array.isArray(value)) {
    for (const [i, entry] of value.entries()) {
      const plain = await one(entry)

      if (plain) value[i] = plain
    }

    return
  }

  // A stream's own dictionary can hold strings as well, and its bytes are
  // handled elsewhere — see `PdfDocument.bytes`.
  const dict = isStream(value) ? value.dict : isDict(value) ? value : null

  if (!dict) return

  for (const [key, entry] of dict) {
    const plain = await one(entry)

    if (plain) dict.set(key, plain)
  }
}

/** Whether anything in the file claims encryption, readable or not. */
function declaresEncryption (doc: PdfDocument): boolean {
  return doc.trailers.some((trailer) => trailer.has('Encrypt'))
    || [...doc.objects.values()].some((value) =>
      isStream(value)
      && nameOf(doc.entry(value.dict, 'Type')) === 'XRef'
      && value.dict.has('Encrypt'))
}

/** The `/Encrypt` dictionary, from a trailer or a cross-reference stream. */
function encryptionOf (doc: PdfDocument): PdfDict | null {
  for (let i = doc.trailers.length - 1; i >= 0; i--) {
    const found = doc.entry(doc.trailers[i], 'Encrypt')

    if (isDict(found)) return found
  }

  for (const value of doc.objects.values()) {
    if (!isStream(value) || nameOf(doc.entry(value.dict, 'Type')) !== 'XRef') continue

    const found = doc.entry(value.dict, 'Encrypt')

    if (isDict(found)) return found
  }

  return null
}

/**
 * The file's first identifier, which the older revisions hash into the key.
 *
 * Missing in files that ought to have one, and the answer there is an empty
 * string rather than a refusal — that is what produced the key when the file
 * was written, so it is what reproduces it now.
 */
function firstId (doc: PdfDocument): Uint8Array {
  const from = (dict: PdfDict | undefined) => {
    const id = doc.entry(dict, 'ID')

    if (!Array.isArray(id)) return null

    const first = doc.resolve(id[0])

    return first instanceof Uint8Array ? first : null
  }

  for (let i = doc.trailers.length - 1; i >= 0; i--) {
    const found = from(doc.trailers[i])

    if (found) return found
  }

  for (const value of doc.objects.values()) {
    if (!isStream(value) || nameOf(doc.entry(value.dict, 'Type')) !== 'XRef') continue

    const found = from(value.dict)

    if (found) return found
  }

  return new Uint8Array(0)
}

/** The objects inside an `/ObjStm`, each with the number it answers to. */
async function packed (doc: PdfDocument, stream: PdfStream) {
  const data = await decodeStream(doc, stream)
  const count = doc.int(stream.dict, 'N')
  const first = doc.int(stream.dict, 'First')
  const header = new Lexer(data)
  const out: { num: number, value: PdfValue }[] = []
  const spots: { num: number, at: number }[] = []

  for (let i = 0; i < count; i++) {
    const num = header.value()
    const rel = header.value()

    if (typeof num !== 'number' || typeof rel !== 'number') break

    spots.push({ num, at: first + rel })
  }

  for (const spot of spots) {
    try {
      out.push({ num: spot.num, value: new Lexer(data, spot.at).value() })
    } catch {
      // One bad entry, not a bad stream.
    }
  }

  return out
}

/**
 * A stream's bytes with every filter undone — for streams that carry
 * structure (object streams, palettes). Image codecs like DCT never get
 * here: `extract.ts` peels those off itself, because their encoded bytes
 * are the very thing it is after.
 */
export async function decodeStream (doc: PdfDocument, stream: PdfStream): Promise<Uint8Array> {
  const resolve = (value: PdfValue | undefined) => doc.resolve(value)

  let data = await doc.bytes(stream)

  for (const { name, parms } of filtersOf(stream.dict, resolve)) {
    data = await applyFilter(name, data, parms, resolve)
  }

  return data
}

/** The filter chain, normalised: a lone name and a lone parms dict are lists of one. */
export function filtersOf (dict: PdfDict, resolve: (value: PdfValue | undefined) => PdfValue | undefined): { name: string, parms: PdfDict | null }[] {
  const filter = resolve(dict.get('Filter'))
  const parms = resolve(dict.get('DecodeParms') ?? dict.get('DP'))

  const names = filter instanceof PdfName
    ? [filter]
    : Array.isArray(filter) ? filter.map((entry) => resolve(entry)) : []

  const settings = isDict(parms)
    ? [parms]
    : Array.isArray(parms) ? parms.map((entry) => resolve(entry)) : []

  return names
    .filter((name): name is PdfName => name instanceof PdfName)
    .map((name, i) => ({
      name: name.name,
      parms: isDict(settings[i]) ? settings[i] as PdfDict : null,
    }))
}

/** One filter, applied. Throws on codecs this does not do, naming them. */
export async function applyFilter (
  name: string,
  data: Uint8Array,
  parms: PdfDict | null,
  resolve: (value: PdfValue | undefined) => PdfValue | undefined,
): Promise<Uint8Array> {
  const setting = (key: string, fallback: number) => {
    const value = resolve(parms?.get(key))

    return typeof value === 'number' ? value : fallback
  }

  const predicted = (bytes: Uint8Array) => unpredict(
    bytes,
    setting('Predictor', 1),
    setting('Colors', 1),
    setting('BitsPerComponent', 8),
    setting('Columns', 1),
  )

  if (name === 'FlateDecode' || name === 'Fl') return predicted(await inflate(data))
  if (name === 'LZWDecode' || name === 'LZW') return predicted(lzw(data, setting('EarlyChange', 1)))
  if (name === 'RunLengthDecode' || name === 'RL') return runLength(data)
  if (name === 'ASCIIHexDecode' || name === 'AHx') return asciiHex(data)
  if (name === 'ASCII85Decode' || name === 'A85') return ascii85(data)

  throw new Error(`unsupported filter ${name}`)
}

/**
 * Everywhere in the file an object or a trailer announces itself.
 *
 * The scan is honest about being a scan: bytes inside a compressed stream can
 * spell `obj` too, and those hits simply fail to parse later. `indexOf` does
 * the running — a native memchr — so a hundred-megabyte chapter is a moment,
 * not a wait.
 */
function scan (bytes: Uint8Array) {
  const objects: { num: number, at: number }[] = []
  const trailers: number[] = []

  for (let i = 0; ;) {
    // The `j` of `obj` — the rarest byte of the keyword to go hunting for.
    i = bytes.indexOf(0x6a, i)

    if (i < 0) break

    if (bytes[i - 2] === 0x6f && bytes[i - 1] === 0x62 && isBoundary(bytes[i + 1])) {
      const spot = backtrack(bytes, i - 2)

      if (spot) objects.push(spot)
    }

    i++
  }

  for (let i = 0; ;) {
    i = find(bytes, 'trailer', i)

    if (i < 0) break

    if (isBoundary(bytes[i - 1]) && isBoundary(bytes[i + 7])) trailers.push(i + 7)

    i++
  }

  return { objects, trailers }
}

function isBoundary (byte: number | undefined) {
  return isSpace(byte) || isDelim(byte)
}

/** From the `o` of `obj`, back over `N G ` to where the object starts. */
function backtrack (bytes: Uint8Array, from: number): { num: number, at: number } | null {
  let i = from - 1

  while (isSpace(bytes[i]) && i >= 0) i--

  const genEnd = i

  while (isDigit(bytes[i]) && i >= 0) i--

  if (i === genEnd) return null

  while (isSpace(bytes[i]) && i >= 0) i--

  const numEnd = i

  while (isDigit(bytes[i]) && i >= 0) i--

  if (i === numEnd) return null
  if (!isBoundary(bytes[i]) && i >= 0) return null

  const num = parseInt(ascii(bytes.subarray(i + 1, numEnd + 1)), 10)

  return Number.isNaN(num) ? null : { num, at: i + 1 }
}

function find (bytes: Uint8Array, text: string, from: number) {
  const first = text.charCodeAt(0)

  for (let i = from; ;) {
    i = bytes.indexOf(first, i)

    if (i < 0 || i + text.length > bytes.length) return -1

    let hit = true

    for (let k = 1; k < text.length; k++) {
      if (bytes[i + k] !== text.charCodeAt(k)) {
        hit = false

        break
      }
    }

    if (hit) return i

    i++
  }
}

function ascii (bytes: Uint8Array) {
  let out = ''

  for (const byte of bytes) out += String.fromCharCode(byte)

  return out
}
