/**
 * The ciphers a PDF's standard security handler is built out of.
 *
 * Only what the format actually calls for, and nothing invented: MD5 and RC4
 * because the browser will not do them and the older revisions are made of
 * them, and AES through the browser's own WebCrypto because it will. Both of
 * the first two are long dead as security — RC4 was broken before some of
 * these files were written — but a reader does not get to choose what a file
 * it is handed was encrypted with, and refusing to implement them would only
 * mean refusing to open the files.
 *
 * Nothing here is a general-purpose crypto library and none of it should be
 * used as one. It exists to open a book somebody already owns.
 */

/* ---------- MD5 ---------- */

/** Per-round left-rotation amounts. */
const ROTATES = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/** The sine table, computed rather than typed out — 64 chances to mistype. */
const SINES = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32))

/**
 * MD5 of everything passed, concatenated.
 *
 * Varargs because every hash the spec asks for is of several things joined —
 * a padded password, then a string, then four bytes of permissions — and
 * joining them at each call site is where an off-by-one hides.
 */
export function md5 (...parts: Uint8Array[]): Uint8Array {
  const message = join(parts)
  const bits = message.length * 8

  // Padded to 56 mod 64, then the original length as 64 little-endian bits.
  const padded = new Uint8Array((Math.floor((message.length + 8) / 64) + 1) * 64)

  padded.set(message)
  padded[message.length] = 0x80

  const view = new DataView(padded.buffer)

  view.setUint32(padded.length - 8, bits >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const words = new Uint32Array(16)

  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(at + i * 4, true)

    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number

      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }

      const sum = (f + a + SINES[i]! + words[g]!) >>> 0
      const rotate = ROTATES[i]!

      a = d
      d = c
      c = b
      b = (b + ((sum << rotate) | (sum >>> (32 - rotate)))) >>> 0
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)

  new DataView(out.buffer).setUint32(0, a0, true)
  new DataView(out.buffer).setUint32(4, b0, true)
  new DataView(out.buffer).setUint32(8, c0, true)
  new DataView(out.buffer).setUint32(12, d0, true)

  return out
}

/* ---------- RC4 ---------- */

/** RC4. Its own inverse, so this both encrypts and decrypts. */
export function rc4 (key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)

  for (let i = 0; i < 256; i++) s[i] = i

  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff
    ;[s[i], s[j]] = [s[j]!, s[i]!]
  }

  const out = new Uint8Array(data.length)

  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff
    j = (j + s[i]!) & 0xff
    ;[s[i], s[j]] = [s[j]!, s[i]!]

    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 0xff]!
  }

  return out
}

/* ---------- AES, by way of the browser ---------- */

const ZERO_IV = new Uint8Array(16)

async function keyFor (raw: Uint8Array, usage: KeyUsage) {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-CBC', false, [usage])
}

/**
 * AES-CBC as a PDF stores it: the initialisation vector is the first sixteen
 * bytes of the data, and the rest is padded the way WebCrypto expects, so it
 * can strip the padding itself.
 */
export async function aesDecrypt (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // A stream shorter than one block carries nothing but its own vector, if
  // that. Nothing to decrypt, and asking WebCrypto to anyway only throws.
  if (data.length <= 16) return new Uint8Array(0)

  const iv = data.subarray(0, 16)
  const body = data.subarray(16)

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    await keyFor(key, 'decrypt'),
    body as BufferSource,
  )

  return new Uint8Array(plain)
}

/**
 * AES-CBC encryption with no padding at all, which the spec asks for in the
 * hashing loop of algorithm 2.B.
 *
 * WebCrypto will not do unpadded, but it does not have to: CBC runs forward,
 * so encrypting and then discarding the trailing block WebCrypto added leaves
 * exactly what an unpadded encryption would have produced.
 */
export async function aesEncryptRaw (key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    await keyFor(key, 'encrypt'),
    data as BufferSource,
  )

  return new Uint8Array(out, 0, data.length)
}

/**
 * AES-CBC decryption with no padding, which is how the file key is wrapped
 * inside `/UE` and `/OE`.
 *
 * The other way round from the above, and it takes a trick. WebCrypto insists
 * on finding valid padding at the end and there is none, so one block is
 * *manufactured*: a block whose decryption comes out as sixteen bytes of
 * `0x10` — a full, valid pad — is appended, and WebCrypto then removes it and
 * hands back the rest untouched. Since CBC decrypts each block as
 * `D(block) XOR previous`, the block we want is `E(pad XOR last block of the
 * ciphertext)`, and we hold the key, so we can encrypt that ourselves.
 */
export async function aesDecryptRaw (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (!data.length || data.length % 16) throw new Error('not whole AES blocks')

  const pad = new Uint8Array(16).fill(16)
  const last = data.subarray(data.length - 16)
  const seed = pad.map((byte, i) => byte ^ last[i]!)

  // One block through CBC from a zero vector is one block of plain AES, which
  // is what makes this the block we are after rather than something with the
  // chaining still on it.
  const tail = await aesEncryptRaw(key, ZERO_IV, seed)

  const padded = new Uint8Array(data.length + 16)

  padded.set(data)
  padded.set(tail, data.length)

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ZERO_IV as BufferSource },
    await keyFor(key, 'decrypt'),
    padded as BufferSource,
  )

  return new Uint8Array(plain)
}

/** SHA-256, -384 or -512, whichever algorithm 2.B has arrived at. */
export async function sha (bits: 256 | 384 | 512, ...parts: Uint8Array[]): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(`SHA-${bits}`, join(parts) as BufferSource)

  return new Uint8Array(digest)
}

export function join (parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

/** Two byte strings compared for equality, in the plainest way. */
export function same (a: Uint8Array, b: Uint8Array, length = a.length): boolean {
  if (a.length < length || b.length < length) return false

  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return false

  return true
}
