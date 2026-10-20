/**
 * A key and a value, kept across sessions. Nothing more than that.
 *
 * IndexedDB rather than local storage for one reason: a `FileSystemDirectoryHandle`
 * is not a string and cannot be made into one, and structured clone — which
 * IndexedDB stores through and local storage does not — is the only way to put
 * one somewhere it will still be there tomorrow. That is the whole argument for
 * the database being here at all, and why it holds one small record rather than
 * pages of anything.
 *
 * Deliberately not a library. The whole of what is wanted is get, set and
 * delete against a single store, and a dependency for that would be more code
 * to keep than this is.
 */

const NAME = 'kemolate'
const STORE = 'keyval'

let opening: Promise<IDBDatabase> | null = null

/**
 * How long to wait for the database before giving up on it.
 *
 * There is a state — a deletion left pending by a connection that never closed
 * — in which `indexedDB.open` fires *none* of its events: not success, not
 * error, not even blocked. It simply never answers. Without a limit the read
 * that waits on it never returns either, and a workspace that cannot find out
 * what is in it shows an empty canvas for ever, which is a far worse failure
 * than not remembering the last chapter.
 */
const PATIENCE = 5000

function database () {
  if (opening) return opening

  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(NAME, 1)
    const abandon = setTimeout(() => reject(new Error('Storage did not open in time.')), PATIENCE)

    const done = <T>(settle: (value: T) => void) => (value: T) => {
      clearTimeout(abandon)
      settle(value)
    }

    const succeed = done(resolve)
    const fail = done(reject)

    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => succeed(request.result)
    request.onerror = () => fail(request.error)

    // A version older than the one on disk — another tab of a later build, or
    // a downgrade — is the one failure that would otherwise sit there politely.
    request.onblocked = () => fail(new Error('Storage is open in another tab.'))
  })

  // A database that failed to open once may open next time, and the cache would
  // otherwise hand the same failure back for the life of the page.
  opening.catch(() => { opening = null })

  return opening
}

async function run<T> (
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const store = (await database()).transaction(STORE, mode).objectStore(STORE)

  return new Promise<T>((resolve, reject) => {
    const request = work(store)

    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error)
  })
}

/**
 * The value with Vue's proxies taken off, so structured clone will take it.
 *
 * A proxy cannot be cloned — `put` throws `DataCloneError` — and almost
 * everything worth keeping here lives in a `useState`, so almost every caller
 * is holding one. Each used to strip them itself, and the two that forgot lost
 * everything they wrote without a word, because a write that cannot be kept is
 * swallowed by design: the AI ledger had never once been saved, and the record
 * of a page's repairs was never written. Done here, once, instead.
 *
 * Only arrays and plain objects are walked, and only copied where something
 * inside them was a proxy. Anything else goes through as it is — a `File`, a
 * `Blob`, a directory handle — which is the reason this store exists at all
 * (see the top of the file), and why this is not a JSON round trip.
 */
export function unproxied (value: unknown): unknown {
  if (!value || typeof value !== 'object') return value

  const raw = toRaw(value)

  if (Array.isArray(raw)) {
    let copy: unknown[] | null = null

    raw.forEach((item, at) => {
      const bare = unproxied(item)

      if (bare !== item) (copy ??= [...raw])[at] = bare
    })

    return copy ?? raw
  }

  if (Object.getPrototypeOf(raw) === Object.prototype) {
    let copy: Record<string, unknown> | null = null

    for (const [key, item] of Object.entries(raw)) {
      const bare = unproxied(item)

      if (bare !== item) (copy ??= { ...raw })[key] = bare
    }

    return copy ?? raw
  }

  return raw
}

export const idb = {
  get: <T>(key: string) => run<T | undefined>('readonly', (store) => store.get(key)),
  set: (key: string, value: unknown) => run<IDBValidKey>('readwrite', (store) => store.put(unproxied(value), key)),
  del: (key: string) => run<undefined>('readwrite', (store) => store.delete(key)),

  /**
   * Every key under a prefix, for the one caller that has to find records it
   * cannot name.
   *
   * Retouching is filed per *surface* — `paint:<hash>:<key>`, where the key is
   * `bg`, a block's, or a sheet's — and the surfaces a page has been painted on
   * are not derivable from the page: a block since deleted, or a sheet from
   * before somebody rearranged the stack, still has marks on it. An export that
   * asked only for the surfaces it could think of would quietly leave those
   * behind, which is exactly the kind of loss a project file exists to prevent.
   *
   * A range over the prefix rather than a scan of everything: the store also
   * holds the block caches and the workspace records, and reading the lot to
   * filter it would be the whole database in memory to find a dozen names.
   */
  keys: (prefix: string) => run<string[]>('readonly', (store) => store.getAllKeys(
    // `￿` is past every character a key of ours can end with, so the range
    // is "everything that starts with this" without needing a cursor.
    IDBKeyRange.bound(prefix, `${prefix}￿`),
  )),

  /**
   * Several keys in one transaction, in the order asked; `undefined` for any
   * that is not there.
   *
   * For a caller that knows every key it wants up front. A transaction is where
   * the waiting happens — a read queues behind every write already queued on the
   * store — so fifty `get`s in turn wait fifty times, and on a chapter opening,
   * with the block cache writing, that was two hundred milliseconds apiece.
   * One transaction waits once.
   */
  getMany: async <T>(keys: string[]): Promise<(T | undefined)[]> => {
    if (!keys.length) return []

    const store = (await database()).transaction(STORE, 'readonly').objectStore(STORE)

    return Promise.all(keys.map((key) => new Promise<T | undefined>((resolve, reject) => {
      const request = store.get(key)

      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })))
  },
}
