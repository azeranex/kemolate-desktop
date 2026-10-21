/**
 * Where a workspace's cleaned balloons are kept on disk — desktop.
 *
 * In the web build `repairs.ts` keeps each repair's PNG through Nitro's
 * `useStorage('repairs')`, an unstorage mount on `.data/repairs`. This is the
 * same thing for the main process, without Nitro: the four calls the service
 * makes, over one folder of files named by their SHA-256. The folder is the
 * app's (`<userData>/repairs`, set at start by `electron/database.ts`); tests set
 * their own.
 *
 * Files are shared by content, as in the web build: a row going leaves its file,
 * and `repairs.sweep` takes the files no row names.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

let root: string | null = null

/** The folder repairs are kept in — called once, before the first repair is written or read. */
export function keepRepairsIn (folder: string) {
  root = folder
}

function where (key: string) {
  if (!root) throw new Error('No folder has been set for repairs.')
  if (!/^[\w.-]+$/.test(key)) throw new Error(`Not a repair file name: ${key}`)

  return path.join(root, key)
}

export const repairStore = {
  async setItemRaw (key: string, bytes: Uint8Array) {
    await mkdir(root!, { recursive: true })
    await writeFile(where(key), bytes)
  },
  async getItemRaw<T = Buffer> (key: string): Promise<T | null> {
    return await readFile(where(key)).catch(() => null) as T | null
  },
  async getKeys (): Promise<string[]> {
    return root ? (await readdir(root).catch(() => [])).filter((name) => name.endsWith('.png')) : []
  },
  async getMeta (key: string): Promise<{ mtime?: Date }> {
    const info = await stat(where(key)).catch(() => null)

    return { mtime: info?.mtime }
  },
  async removeItem (key: string) {
    await rm(where(key), { force: true })
  },
}
