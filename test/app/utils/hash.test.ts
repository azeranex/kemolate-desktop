import { createHash } from 'node:crypto'

import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashFile, rememberedHashes } from '~/utils/hash'

/**
 * The memo that stops a chapter being read twice to learn what it already knew.
 *
 * **Needs the nuxt project** for the IndexedDB shim; the hashing itself is
 * `crypto.subtle` and needs nothing.
 *
 * A scan's SHA-256 is the identity everything derived hangs off — thumbnails,
 * cleaned patches, the reading, and which page a peer is asking for. Working it
 * out means reading every byte of the file, so it is remembered under
 * `hash:<name>:<size>:<mtime>` and not worked out twice.
 *
 * That key is the whole risk. It is a *guess* that three cheap facts identify a
 * file, which is true often enough to be worth it and false in exactly one
 * direction that matters: two different files agreeing on all three would be
 * served each other's identity, and the page would inherit another page's
 * reading, its repairs and its place in the swarm. The mtime is what makes that
 * unlikely, which is why an edited file must produce a different key rather
 * than a stale hit.
 *
 * Seam: the hashing entry point and the memo around it.
 */

/** The memo, in a map: `hash.ts` reaches the store through the `idb` auto-import. */
const { memo } = vi.hoisted(() => ({ memo: new Map<string, unknown>() }))

mockNuxtImport('idb', () => ({
  get: async (key: string) => memo.get(key),
  set: async (key: string, value: unknown) => { memo.set(key, value) },
  getMany: async (keys: string[]) => keys.map((key) => memo.get(key)),
}))

beforeEach(() => memo.clear())

/*
 * Opening a chapter asks the memo for every page at once (`rememberedHashes`)
 * and hashes only what it did not know — and `hashFile` then asked it again, a
 * file at a time, queued behind whatever else the opening was writing to the
 * store. `recall: false` is the caller saying it has already asked.
 */
describe('hashing what the memo has just said it does not know', () => {
  const bytes = new TextEncoder().encode('a page of a chapter')
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  it('reads the file, not the memo, and remembers what it found', async () => {
    const file = new File([bytes], '001.jpg', { lastModified: 1 })

    // Whatever the memo holds is not consulted: had it been, this is the answer.
    memo.set(`hash:001.jpg:${bytes.byteLength}:1`, 'what the memo said')

    expect(await hashFile(file, { recall: false })).toBe(sha256)
    expect(await rememberedHashes([file])).toEqual([sha256])
  })

  it('gives the SHA-256 of the bytes, the same digest asked either way', async () => {
    const file = new File([bytes], '002.jpg', { lastModified: 2 })

    expect(await hashFile(file)).toBe(sha256)
    expect(await hashFile(new File([bytes], '003.jpg', { lastModified: 3 }), { recall: false })).toBe(sha256)
  })
})

describe('the memo', () => {
  it.todo('reads a file once and answers from memory after that')
  it.todo('answers the same digest for the same file across a reload')
  it.todo('hashes again when the file has been edited since')
  it.todo('hashes again when the size changed under the same name')
  it.todo('keeps two files with the same name in different folders apart')
})

describe('the digest itself', () => {
  it.todo('agrees with the content hash the server and the swarm use')
  it.todo('gives two identical files the same digest, whatever they are called')
  it.todo('survives a file that cannot be read, without poisoning the memo')
})
