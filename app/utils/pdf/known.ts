/**
 * Every page this browser and this workspace already hold something under —
 * what a PDF's pages are checked against before one of them takes the new
 * road (`identity.ts`, whose header is the reason).
 *
 * "Something" is every store in the app filed by a scan's hash:
 *
 * - IndexedDB `blocks:` and `layers:` (a local workspace's reading and stack),
 *   `repairs-shown:` (its cleaning as last shown) and `paint:` (retouching and
 *   mask corrections, on any workspace);
 * - OPFS `thumbs/` and `previews/`, filed by the full hash, and `patches/`,
 *   whose keys open with the first sixteen characters of it (`patchKey`);
 * - the workspace's own page rows, where it is a cloud workspace — which is
 *   what a second computer, holding none of the above, is recognised by, and
 *   what a peer asks for pages by.
 *
 * Across every workspace, not only the one open: all but the first two stores
 * are shared by content (`idbKeys.ts` says why), so a book opened the old way
 * in one workspace is read the old way when it is dropped into another, and
 * the retouching and cleaning filed under its pages are found there too.
 *
 * Thumbnails are the store doing most of the work. One is made for every page
 * that is hashed, on the way in, and nothing sweeps them — so they name every
 * page this browser has opened, visited or not, read or not.
 *
 * Only the names are read, never a file: a listing each, and every key of four
 * kinds. Anything shaped like sixteen or more hex characters in a name is taken
 * as a hash, since nothing else these stores are named by is — a workspace id
 * is a uuid, whose longest run is twelve.
 */
import { opfsNames } from '../opfs'

import { PREFIX } from './identity'

import type { Known } from './identity'

/** A page row of the workspace open here, as much of one as this needs. */
export interface KnownRow { path: string, hash: string | null }

/**
 * Where the workspace's page rows come from — `useLibrary` says, since only a
 * composable can see the workspace record. Until it has, there are none.
 */
let rowsOf: () => Promise<readonly KnownRow[]> = async () => []

/**
 * Tell this file how to read the workspace's rows. The source is expected to
 * wait for a record still being fetched, since a chapter restored on the way
 * in is opened at the same time as the record is asked for, and deciding
 * without it is deciding as a stranger to the workspace.
 */
export function knowRowsBy (source: () => Promise<readonly KnownRow[]>) {
  rowsOf = source
}

const HASHES = /[0-9a-f]{16,}/g

/** Every hash-looking run in these names, as prefixes. */
function prefixes (names: readonly string[], into: Set<string>) {
  for (const name of names) {
    for (const found of name.match(HASHES) ?? []) into.add(found.slice(0, PREFIX))
  }
}

/**
 * What is known of the book at `book` (its path, `chapter.pdf` or
 * `volume/chapter.pdf`) before its pages are read.
 *
 * `reopening` is a chapter coming back from its kept folder: a book in it was
 * opened here before by definition, so it is held and never given up on — see
 * `identity.ts`. The same holds for a book whose name the workspace's rows
 * carry as a folder of pages.
 *
 * Every source fails on its own and to nothing. A store that will not open is
 * one whose records cannot be found by any page however it is read.
 */
export async function knownFor (book: string, { reopening = false }: { reopening?: boolean } = {}): Promise<Known> {
  const quietly = <T>(work: Promise<T[]>) => work.catch((): T[] => [])

  const [blocks, layers, shown, paint, thumbs, previews, patches, rows] = await Promise.all([
    quietly(idb.keys('blocks:')),
    quietly(idb.keys('layers:')),
    quietly(idb.keys('repairs-shown:')),
    quietly(idb.keys('paint:')),
    quietly(opfsNames('thumbs')),
    quietly(opfsNames('previews')),
    quietly(opfsNames('patches')),
    quietly((async () => [...await rowsOf()])()),
  ])

  const scans = new Set<string>()

  prefixes([...blocks, ...layers, ...shown, ...paint, ...thumbs, ...previews, ...patches], scans)
  prefixes(rows.flatMap((row) => (row.hash ? [row.hash] : [])), scans)

  // The book's own name as a folder in a row's path: `chapter.pdf/001.png`,
  // wherever the drop put `chapter.pdf`.
  const name = `/${book.split('/').pop()}/`
  const named = rows.some((row) => `/${row.path}`.includes(name))

  return { scans, held: reopening || named }
}
