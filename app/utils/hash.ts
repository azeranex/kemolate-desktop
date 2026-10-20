/**
 * What a page *is*, said in a way two machines can agree on without having
 * agreed on anything first.
 *
 * A filename cannot do this. Chapters get renamed, re-sorted and re-downloaded,
 * and work filed under a path goes missing every time — the earlier build keyed
 * every one of its caches off the image's content instead, and was right to. It
 * is also the only identity a peer can match against: two people who opened the
 * same chapter have the same bytes, and nothing else about their two folders is
 * guaranteed to look alike.
 *
 * SHA-256, because it is what `crypto.subtle` offers and the cost is not in the
 * algorithm — it is in reading the file. Which is why nothing here is on the
 * path that opens a comic: pages are drawn first and identified afterwards.
 */

/** How the digest is written down: lowercase hex, the way every tool prints it. */
function hex (buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A file that would have to be held in memory whole to be hashed, and is big
 * enough that doing so is a real cost.
 *
 * `crypto.subtle` has no streaming digest, so a hash means the entire file in
 * one buffer. A comic page is a megabyte and nobody notices; something has gone
 * wrong if a page is a hundred, and refusing is better than a tab that dies
 * partway through a chapter with no explanation.
 */
const TOO_BIG = 256 * 1024 * 1024

/**
 * What identifies a file well enough to trust a hash we worked out before.
 *
 * Not a hash itself — that is the thing being avoided. The three facts the
 * browser hands over for free, which together change whenever the bytes do in
 * any case that is not deliberate.
 */
function cacheKey (file: File) {
  return `hash:${file.name}:${file.size}:${file.lastModified}`
}

/**
 * The content hash of some bytes, worked out afresh every time.
 *
 * The uncached half of the pair, for blobs that are not files: the memo below
 * is keyed on a name, a size and a modified time, and a `Blob` has only one of
 * the three — so asking it to remember one would file every anonymous blob of
 * the same length under the same name and hand back the first one's digest.
 *
 * That is not a hypothetical saving forgone. The caller is `keepPlaced`, which
 * hashes bytes out of an archive *in order to check them against the name they
 * arrived under* — a memo that answered from a previous file would defeat the
 * only reason the check exists.
 */
export async function hashBytes (bytes: Blob): Promise<string | null> {
  if (bytes.size > TOO_BIG) return null

  try {
    return hex(await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer()))
  } catch {
    return null
  }
}

/**
 * The hashes this browser already worked out for these files, from one read.
 *
 * `hashFile` asks the memo a file at a time, which is right for a file nobody
 * has seen and wrong for a chapter opened again: every page is in the memo, and
 * asking fifty times in turn put the last page's hash twelve seconds behind the
 * first. Everything keyed by a page's content — its cleaning, its thumbnail, its
 * match on the server — waits on that hash, so the chapter came back a few
 * pages at a time. See `useLibrary.identify`, which asks this first and hashes
 * only what it could not answer.
 *
 * Nothing for a file the memo does not hold, or when storage will not open.
 */
export async function rememberedHashes (files: File[]): Promise<(string | null)[]> {
  const held = await idb.getMany<string>(files.map(cacheKey)).catch(() => files.map(() => undefined))

  return held.map((hash) => hash ?? null)
}

/**
 * The content hash of a file, computed once and remembered.
 *
 * Remembering matters more than it looks. A chapter opened from a folder handle
 * is re-read from disk on every visit, so without a cache every reload spends
 * its first few seconds hashing two hundred files to arrive at exactly the
 * answers it had yesterday.
 *
 * `recall: false` skips asking the memo, for a caller that has just asked it
 * for these files at once (`rememberedHashes`) and been told it has nothing:
 * asking again was a read per file, queued behind whatever else is writing to
 * the store while a chapter opens. The answer is remembered either way.
 */
export async function hashFile (file: File, { recall = true }: { recall?: boolean } = {}): Promise<string | null> {
  if (file.size > TOO_BIG) return null

  const key = cacheKey(file)

  const remembered = recall ? await idb.get<string>(key).catch(() => null) : null

  if (remembered) return remembered

  try {
    const digest = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))

    // Failing to write the cache costs time later and nothing now, so it is not
    // worth failing the hash over.
    await idb.set(key, digest).catch(() => {})

    return digest
  } catch {
    // A file that has gone since the folder was listed, or one the browser will
    // not read. Not knowing what a page is, is survivable; the page still draws.
    return null
  }
}
