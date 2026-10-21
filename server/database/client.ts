import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { drizzle } from 'drizzle-orm/node-sqlite'

import { relations } from './relations'

import type { Logger } from 'drizzle-orm/logger'

class QueryLogger implements Logger {
  logQuery (query: string, _params: unknown[]): void {
    try {
      const event = useEvent()
      if (event) {
        event.context.dbQueryCount = (event.context.dbQueryCount || 0) + 1

        // Extract table names from FROM / JOIN clauses for debugging
        if (import.meta.dev) {
          // Filter out SQL keywords/functions the regex may capture — relational
          // queries read from `json_each(...)` and friends, not just real tables.
          const SQL_KEYWORDS = new Set(['select', 'values', 'json_each', 'json_tree', 'pragma'])
          const tables = [...query.matchAll(/(?:from|join)\s+["`]?(\w+)["`]?/gi)]
            .map((m) => m[1]!.toLowerCase())
            .filter((t) => !SQL_KEYWORDS.has(t))
          const counts: Record<string, number> = event.context.dbQueryTables ?? {}
          for (const t of tables) counts[t] = (counts[t] ?? 0) + 1
          event.context.dbQueryTables = counts
        }
      }
    } catch {
      // Ignore if outside of request context
    }
  }
}

/** How often the planner statistics are refreshed — see `createClient`. */
const OPTIMIZE_EVERY_MS = 60 * 60 * 1000

function createClient () {
  // A file path, not a connection string — read straight from `process.env` so
  // scripts running outside Nuxt can import this module too.
  const url = process.env.DATABASE_URL

  if (!url) {
    throw new Error('Missing DATABASE_URL in .env file')
  }

  // `:memory:` has no directory to create.
  if (url !== ':memory:') {
    mkdirSync(dirname(resolve(url)), { recursive: true })
  }

  const client = new DatabaseSync(url)

  // Better concurrency + durability defaults for a server process.
  client.exec('PRAGMA journal_mode = WAL;')
  // SQLite ignores foreign keys unless this is switched on per connection.
  client.exec('PRAGMA foreign_keys = ON;')

  /*
   * NORMAL, not the FULL that node:sqlite's build defaults to under WAL. FULL
   * fsyncs on every commit, and every save here is its own commit — measured
   * on the dev machine, 300 single-row updates took 34–75 ms under FULL and
   * 4.7 ms under NORMAL. The trade is the one SQLite documents for WAL: the
   * database cannot be corrupted either way, but a power cut (not a crash of
   * this process) can lose the last commits before the next checkpoint. For
   * edits a reader makes in a browser that is still holding them, that is the
   * right side of the line.
   */
  client.exec('PRAGMA synchronous = NORMAL;')

  /*
   * SQLite allows one writer at a time; wait instead of throwing SQLITE_BUSY —
   * but not for long. node:sqlite is synchronous, so a wait here is the whole
   * server's event loop standing still, every request with it. The only other
   * writers are tools (Drizzle Studio, a script), and a second is plenty to
   * outlast one of their writes; five used to freeze the app for five.
   */
  client.exec('PRAGMA busy_timeout = 1000;')

  /*
   * Planner statistics. There were none — no `sqlite_stat1` at all — which is
   * the condition under which SQLite guesses its way into a bad index choice
   * (the one schema.ts documents around `translations`). `optimize` with this
   * mask analyses only the tables that need it, cheaply, and is what SQLite
   * recommends running when a long-lived connection opens and now and then
   * after. `unref` so a script that imports this module still exits.
   */
  client.exec('PRAGMA optimize = 0x10002;')
  setInterval(() => {
    try {
      client.exec('PRAGMA optimize;')
    } catch (error) {
      console.warn('[kemolate] PRAGMA optimize failed', error)
    }
  }, OPTIMIZE_EVERY_MS).unref()

  return client
}

function createDb (client: DatabaseSync) {
  return drizzle({ client, relations, logger: new QueryLogger() })
}

// Store the connection on globalThis — Nitro re-evaluates this module during HMR,
// and each evaluation would otherwise open another handle to the same file.
const globalForDb = globalThis as unknown as {
  sqliteClient: DatabaseSync | undefined
  sqliteDb: ReturnType<typeof createDb> | undefined
}

export const client = (globalForDb.sqliteClient ??= createClient())
export const db = (globalForDb.sqliteDb ??= createDb(client))
