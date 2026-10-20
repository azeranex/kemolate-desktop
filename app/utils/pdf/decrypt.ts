/**
 * The standard security handler — what "this PDF has a password" actually
 * means, and how to get past it with one.
 *
 * A protected PDF is not scrambled as a file. Its structure is in the clear —
 * which is why the parser can read the shape of one it cannot yet open — and
 * what is encrypted is every string and every stream in it, each under a key
 * of its own derived from the file's key and the number of the object it sits
 * in. So decryption is not a step at the start; it is something applied to
 * each stream on the way past, and this hands back the thing that does it.
 *
 * Four revisions are in the wild and all four are here, because a reader does
 * not get to pick what it is handed:
 *
 * - **R2** — RC4, 40-bit. Old, and still what a scanner from 2003 emits.
 * - **R3** — RC4, up to 128-bit.
 * - **R4** — RC4 or AES-128, chosen per crypt filter.
 * - **R5/R6** — AES-256. R5 was Adobe's draft and R6 is the standard that
 *   replaced it; they differ only in how hard the password is hashed.
 *
 * Two passwords open a file and either will do here. The **user** password is
 * the one a reader asks for; the **owner** password is the one that also lifts
 * the restrictions. We want neither privilege — we want the pages — so both
 * are tried and whichever verifies is used.
 *
 * The permission bits are read and then ignored, deliberately. They are a
 * request made *of a reader* about printing and copying, enforced by nothing;
 * honouring them would mean refusing to show somebody a book they have both
 * the file and the password for. Every real reader treats them the same way.
 */
import { aesDecrypt, aesDecryptRaw, aesEncryptRaw, join, md5, rc4, same, sha } from './crypto'
import { isDict, nameOf } from './objects'

import type { PdfDict, PdfValue } from './objects'

/**
 * The 32 bytes every short password is padded out with, straight from the
 * spec. It is a constant, not a secret — every PDF ever written shares it.
 */
const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

/** Raised when a file cannot be opened with the password we have (or none). */
export class PdfPasswordError extends Error {
  /** Whether a password was tried and rejected, as against none being given. */
  readonly wrong: boolean

  constructor (wrong: boolean) {
    super(wrong
      ? 'That password didn’t open this PDF.'
      : 'This PDF is password-protected.')

    this.name = 'PdfPasswordError'
    this.wrong = wrong
  }
}

/** What the parser applies to each encrypted thing it comes across. */
export interface Decryptor {
  /** A stream's bytes, for the object it belongs to. */
  stream: (data: Uint8Array, num: number, gen: number) => Promise<Uint8Array>
  /** A string's bytes, likewise — palettes arrive as these. */
  string: (data: Uint8Array, num: number, gen: number) => Promise<Uint8Array>
}

type Cipher = 'rc4' | 'aes' | 'none'

/**
 * Work out whether the given password opens this file, and hand back the means
 * to read it if so. `null` means the password is wrong — not that anything
 * failed.
 */
export async function unlock (
  encrypt: PdfDict,
  id: Uint8Array,
  password: string,
  resolve: (value: PdfValue | undefined) => PdfValue | undefined,
): Promise<Decryptor | null> {
  const filter = nameOf(resolve(encrypt.get('Filter')))

  // Public-key handlers (`/Adobe.PubSec`) and anything bespoke are somebody
  // else's certificate store, not a password we could ask for.
  if (filter && filter !== 'Standard') throw new Error(`unsupported security handler ${filter}`)

  const number = (key: string, fallback: number) => {
    const value = resolve(encrypt.get(key))

    return typeof value === 'number' ? Math.trunc(value) : fallback
  }

  const bytes = (key: string) => {
    const value = resolve(encrypt.get(key))

    return value instanceof Uint8Array ? value : new Uint8Array(0)
  }

  const version = number('V', 0)
  const revision = number('R', version < 2 ? 2 : 3)
  const owned = bytes('O')
  const used = bytes('U')
  const permissions = number('P', -1)
  const metadata = resolve(encrypt.get('EncryptMetadata')) !== false

  const { cipher, bits } = cipherOf(encrypt, resolve, version, number('Length', 40))

  if (cipher === 'none') return passthrough()

  const key = version >= 5
    ? await modernKey(revision, password, owned, used, bytes('OE'), bytes('UE'))
    : await legacyKey(revision, bits, password, owned, used, permissions, id, metadata)

  if (!key) return null

  return keyed(key, cipher, version)
}

/** Which cipher the file uses, and how long its key is. */
function cipherOf (
  encrypt: PdfDict,
  resolve: (value: PdfValue | undefined) => PdfValue | undefined,
  version: number,
  length: number,
): { cipher: Cipher, bits: number } {
  // Before crypt filters existed there was one cipher and it was RC4.
  if (version < 4) return { cipher: 'rc4', bits: length }

  const named = nameOf(resolve(encrypt.get('StmF'))) ?? 'Identity'

  // `/Identity` means the streams are not encrypted at all — rare, but it is
  // how a file encrypts its strings and leaves its images alone.
  if (named === 'Identity') return { cipher: 'none', bits: length }

  const filters = resolve(encrypt.get('CF'))
  const chosen = isDict(filters) ? resolve(filters.get(named)) : undefined
  const method = isDict(chosen) ? nameOf(resolve(chosen.get('CFM'))) : null

  // A crypt filter states its own key length in *bytes*, unlike `/Length`
  // above, which is in bits. Both spellings turn up in real files.
  const own = isDict(chosen) ? resolve(chosen.get('Length')) : undefined
  const stated = typeof own === 'number' ? (own <= 40 ? own * 8 : own) : length

  if (method === 'AESV3') return { cipher: 'aes', bits: 256 }
  if (method === 'AESV2') return { cipher: 'aes', bits: 128 }
  if (method === 'None') return { cipher: 'none', bits: stated }

  return { cipher: 'rc4', bits: stated }
}

/**
 * The file key for revisions 2 to 4 — algorithm 2, then checked with 6 or 7.
 *
 * The password is tried as the user's first and as the owner's second, since
 * either opens the file and only the file's own bytes can say which it was.
 */
async function legacyKey (
  revision: number,
  bits: number,
  password: string,
  owned: Uint8Array,
  used: Uint8Array,
  permissions: number,
  id: Uint8Array,
  metadata: boolean,
): Promise<Uint8Array | null> {
  const size = revision === 2 ? 5 : Math.max(5, Math.min(16, bits >> 3))

  const derive = (padded: Uint8Array) => {
    const perms = new Uint8Array(4)

    // Signed, and little-endian: the permission flags are a negative number in
    // every real file, and getting the sign wrong changes the key.
    new DataView(perms.buffer).setInt32(0, permissions, true)

    const parts = [padded, owned, perms, id]

    // A file that leaves its metadata in the clear says so *inside the key*,
    // which is as odd as it sounds and is exactly what the spec asks for.
    if (revision >= 4 && !metadata) parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))

    let hash = md5(...parts)

    // Fifty more rounds, to make guessing fifty times slower. This is the
    // whole of the work factor in these revisions.
    if (revision >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, size))

    return hash.subarray(0, size)
  }

  const asUser = derive(padded(password))

  if (checksOut(asUser, revision, used, id)) return asUser

  // Not the user password. It may still be the owner's, which is stored as the
  // user password encrypted under itself — so decrypting `/O` with a key made
  // from this password gives back the user password, if this was the owner's.
  let hash = md5(padded(password))

  if (revision >= 3) for (let i = 0; i < 50; i++) hash = md5(hash)

  const ownerKey = hash.subarray(0, size)

  let candidate = owned

  if (revision === 2) {
    candidate = rc4(ownerKey, candidate)
  } else {
    // Twenty rounds, counting down, each under the key with the round number
    // mixed into every byte.
    for (let i = 19; i >= 0; i--) candidate = rc4(ownerKey.map((byte) => byte ^ i), candidate)
  }

  const asOwner = derive(candidate)

  return checksOut(asOwner, revision, used, id) ? asOwner : null
}

/** Algorithm 6: does this key reproduce the `/U` the file carries? */
function checksOut (key: Uint8Array, revision: number, used: Uint8Array, id: Uint8Array): boolean {
  if (revision === 2) return same(rc4(key, PAD), used, 32)

  let check = rc4(key, md5(PAD, id))

  for (let i = 1; i <= 19; i++) check = rc4(key.map((byte) => byte ^ i), check)

  // Only the first sixteen bytes are the check; the rest is padding the spec
  // says to ignore, and some writers fill it with whatever was lying about.
  return same(check, used, 16)
}

/**
 * The file key for revisions 5 and 6 — AES-256, where the key is not derived
 * from the password at all.
 *
 * It is a random key the file was encrypted under, wrapped twice: once for the
 * user password and once for the owner's. The password only unwraps it. That
 * is why these files can have their password changed without re-encrypting
 * every page, and why a wrong password here fails a hash check outright rather
 * than quietly producing rubbish.
 */
async function modernKey (
  revision: number,
  password: string,
  owned: Uint8Array,
  used: Uint8Array,
  ownerWrapped: Uint8Array,
  userWrapped: Uint8Array,
): Promise<Uint8Array | null> {
  // UTF-8, and cut at 127 bytes. The spec asks for SASLprep first, which
  // matters only for passwords with unusual Unicode in them; the encoding is
  // what matters for the rest.
  const secret = new TextEncoder().encode(password).subarray(0, 127)

  const validation = (salt: Uint8Array, extra: Uint8Array) => hash2B(revision, secret, salt, extra)

  // The user password: its own hash is checked against the first half of `/U`.
  if (used.length >= 48 && same(await validation(used.subarray(32, 40), new Uint8Array(0)), used, 32)) {
    const intermediate = await validation(used.subarray(40, 48), new Uint8Array(0))

    return aesDecryptRaw(intermediate, userWrapped)
  }

  // The owner password, whose hashes are salted with `/U` as well — which is
  // what stops an owner hash being lifted from one file into another.
  if (owned.length >= 48 && used.length >= 48
    && same(await validation(owned.subarray(32, 40), used.subarray(0, 48)), owned, 32)) {
    const intermediate = await validation(owned.subarray(40, 48), used.subarray(0, 48))

    return aesDecryptRaw(intermediate, ownerWrapped)
  }

  return null
}

/**
 * Algorithm 2.B — the hardened hash the AES-256 revisions use.
 *
 * R5 was a single SHA-256, which is fast, which is the problem: a password is
 * short and a fast hash is a guessable one. R6 answers that by running at
 * least sixty-four rounds of hashing-and-encrypting whose length depends on
 * the data itself, so the work cannot be skipped or precomputed. It is
 * deliberately awkward, and the awkwardness is the point.
 */
async function hash2B (revision: number, password: Uint8Array, salt: Uint8Array, extra: Uint8Array): Promise<Uint8Array> {
  let k = await sha(256, password, salt, extra)

  if (revision === 5) return k

  let e: Uint8Array = new Uint8Array(0)

  // Sixty-four rounds at least, and then on until the last byte of the round's
  // own output says to stop.
  for (let round = 0; round < 64 || e[e.length - 1]! > round - 32; round++) {
    const once = join([password, k, extra])
    const k1 = new Uint8Array(once.length * 64)

    for (let i = 0; i < 64; i++) k1.set(once, i * once.length)

    e = await aesEncryptRaw(k.subarray(0, 16), k.subarray(16, 32), k1)

    let sum = 0

    for (let i = 0; i < 16; i++) sum += e[i]!

    const which = sum % 3

    k = await sha(which === 0 ? 256 : which === 1 ? 384 : 512, e)
  }

  return k.subarray(0, 32)
}

/** A password padded to the 32 bytes the older revisions hash. */
function padded (password: string): Uint8Array {
  const out = new Uint8Array(32)

  // One byte per character: these revisions predate the file format having an
  // opinion about Unicode, and a password with anything exotic in it was
  // already a password that travelled badly between readers.
  for (let i = 0; i < Math.min(password.length, 32); i++) out[i] = password.charCodeAt(i) & 0xff

  out.set(PAD.subarray(0, 32 - Math.min(password.length, 32)), Math.min(password.length, 32))

  return out
}

/** The decryptor itself, once the file key is known. */
function keyed (key: Uint8Array, cipher: Cipher, version: number): Decryptor {
  const one = async (data: Uint8Array, num: number, gen: number) => {
    // From revision 5 on, every object shares the file key. Before that each
    // gets its own, mixed with the object's number — so the same bytes in two
    // places do not encrypt alike.
    const object = version >= 5 ? key : objectKey(key, num, gen, cipher === 'aes')

    return cipher === 'aes' ? aesDecrypt(object, data) : rc4(object, data)
  }

  return { stream: one, string: one }
}

/** Algorithm 1: this object's key, from the file's. */
function objectKey (key: Uint8Array, num: number, gen: number, aes: boolean): Uint8Array {
  const extra = Uint8Array.from([
    num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff,
    gen & 0xff, (gen >> 8) & 0xff,
  ])

  // "sAlT", literally, and only for AES — the one place the spec puts a word
  // in the middle of a hash.
  const salt = aes ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0)

  return md5(key, extra, salt).subarray(0, Math.min(key.length + 5, 16))
}

/** For a file that declares encryption and then encrypts nothing. */
function passthrough (): Decryptor {
  const none = async (data: Uint8Array) => data

  return { stream: none, string: none }
}
