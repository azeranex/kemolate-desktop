/**
 * A real database for the `server/` tests, stood up the way the app's is — the
 * web build's harness, for the desktop's schema.
 *
 * `server/database/client.ts` opens its connection at import time, so importing
 * a service *is* opening a database. `vitest.config.ts` pins `DATABASE_URL` to
 * `:memory:` for this project, so every test file's connection is an empty page
 * of memory and the reader's database is not something a test can reach.
 *
 * The tables come from **the real migrations**, replayed in folder order — the
 * SQL that will run against the reader's data — rather than from the schema, so a
 * migration that does not apply fails the suite here, and the cascades a test
 * asserts are the ones the shipped foreign keys declare.
 *
 * `createError` is installed as the main process installs it
 * (`installServerGlobals`): the services call it bare, as they do under Nitro.
 *
 * Desktop: no `aReader` or `aContributor` — there are no users, and a workspace's
 * context is always its owner's (see `server/services/access.ts`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '~~/server/services/access'

import { client, db, workspaces } from '~~/server/database'
import { contextFor } from '~~/server/services/access'
import { installServerGlobals } from '~~/server/utils/errors'

installServerGlobals()

const MIGRATIONS = fileURLToPath(new URL('../../../server/database/migrations', import.meta.url))

/** Apply every migration this connection has not seen — recorded in the database, as the web build's harness does. */
function migrate (): void {
  client.exec('CREATE TABLE IF NOT EXISTS test_migrations (tag TEXT PRIMARY KEY)')

  const applied = new Set(client.prepare('SELECT tag FROM test_migrations').all().map((row) => row.tag as string))
  const record = client.prepare('INSERT INTO test_migrations (tag) VALUES (?)')

  for (const entry of readdirSync(MIGRATIONS, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || applied.has(entry.name)) continue

    const sql = readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8')

    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()

      if (trimmed) client.exec(trimmed)
    }

    record.run(entry.name)
  }
}

/** A database with the schema and nothing in it. Call from `beforeEach`. */
export function reset (): void {
  migrate()

  const tables = client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'test_migrations'`)
    .all()

  for (const table of tables) client.exec(`DELETE FROM "${table.name as string}"`)
}

let minted = 0

/** A workspace and the `Context` a service is called with, through the real `contextFor`. */
export async function aWorkspace (options: { name?: string } = {}): Promise<Context> {
  minted += 1

  const [workspace] = await db
    .insert(workspaces)
    .values({ publicId: `w_${minted}`, name: options.name ?? `Chapter ${minted}` })
    .returning()

  const context = await contextFor(workspace!.publicId)

  if (!context) throw new Error('The workspace the harness just inserted did not resolve.')

  return context
}
