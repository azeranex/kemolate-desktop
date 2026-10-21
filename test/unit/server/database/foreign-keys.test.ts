import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { reset } from '../harness'

import { client } from '~~/server/database'
import * as schema from '~~/server/database/schema'

/**
 * What every foreign key does when its parent row goes — read from the schema
 * the migrations actually build, and pinned to a table written out by hand.
 *
 * **Needs the database harness**, for the reason the harness exists: it
 * replays the real migrations, so what is read here is what `pnpm db:migrate`
 * leaves in production rather than what `schema.ts` hopes for.
 *
 * ## Why a table, and why by hand
 *
 * A drizzle-kit table rebuild — `CREATE __new_x`, copy, `DROP TABLE x`,
 * rename — writes the table out again from the schema, and nothing about it
 * promises to write the same foreign keys back. One that lost a cascade would
 * apply cleanly, report success, and leave every later delete orphaning rows
 * that used to go with their parent; one that *kept* it ran its `DROP TABLE`
 * with foreign keys live, because SQLite ignores `PRAGMA foreign_keys` inside
 * the migrator's transaction, and on 2026-08-01 that took every `surfaces` row
 * and then every `strokes` row. See the drizzle gotcha in CLAUDE.md.
 *
 * So both halves are checked: the actions, against a list a person wrote and
 * can argue with — derived from the schema, it would agree with whatever the
 * schema had become — and the migrations themselves, for the rebuild that
 * would fire them.
 */

// Counted `../`s, for the reason the harness gives: no alias reaches a
// directory. From `test/unit/server/database/` to the root is four.
const MIGRATIONS = fileURLToPath(new URL('../../../../server/database/migrations', import.meta.url))

/**
 * Every foreign key, as `table.column` → `parent.column ON DELETE action`.
 *
 * Grouped by what a delete means, because that is the question each line
 * answers and the thing to think about before changing one.
 */
const EXPECTED: Record<string, string> = {
  // Desktop: no `users` table, so none of the web build's keys onto it — a
  // person's own things, a workspace's owner, and authorship. The author and
  // user columns are kept without a key (see `schema.ts`), and are always null.

  // A workspace takes its chapter and its record.
  'cast_members.workspace_id': 'workspaces.id ON DELETE CASCADE',
  'glossaries.workspace_id': 'workspaces.id ON DELETE CASCADE',
  'layers.workspace_id': 'workspaces.id ON DELETE CASCADE',
  'logs.workspace_id': 'workspaces.id ON DELETE CASCADE',
  'pages.workspace_id': 'workspaces.id ON DELETE CASCADE',

  // A page takes what was found on it and done to it.
  'blocks.page_id': 'pages.id ON DELETE CASCADE',
  'layers.page_id': 'pages.id ON DELETE CASCADE',
  'repairs.page_id': 'pages.id ON DELETE CASCADE',
  'surfaces.page_id': 'pages.id ON DELETE CASCADE',

  // A block takes its words and its cleaning — and a balloon its columns,
  // which is why `release` and `compound` re-point them before a parent goes.
  'blocks.parent_id': 'blocks.id ON DELETE CASCADE',
  'repairs.block_id': 'blocks.id ON DELETE CASCADE',
  'surfaces.block_id': 'blocks.id ON DELETE CASCADE',
  'translations.block_id': 'blocks.id ON DELETE CASCADE',

  // The paint chain the 2026-08-01 rebuild fired: a layer takes its surfaces,
  // a surface its strokes, and a group its children.
  'layers.parent_id': 'layers.id ON DELETE CASCADE',
  'strokes.surface_id': 'surfaces.id ON DELETE CASCADE',
  'surfaces.layer_id': 'layers.id ON DELETE CASCADE',

  // A list takes its entries.
  'glossary_terms.glossary_id': 'glossaries.id ON DELETE CASCADE',
  'translation_revisions.translation_id': 'translations.id ON DELETE CASCADE',
}

/**
 * Migrations allowed to drop a table, and why that was safe.
 *
 * None yet. A deliberate one needs the rehearsal CLAUDE.md describes — against
 * a copy of `.data/kemolate.db`, inside an explicit `BEGIN`/`COMMIT` — and the
 * reason it could not take anybody's rows with it written here.
 */
const DROPS: Record<string, string> = {}

const tables = () => client
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'test_migrations' ORDER BY name`)
  .all()
  .map((row) => row.name as string)

/** What the migrated database says, in `EXPECTED`'s terms. */
function migrated (): Record<string, string> {
  const found: Record<string, string> = {}

  for (const table of tables()) {
    for (const key of client.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
      found[`${table}.${key.from as string}`] = `${key.table as string}.${key.to as string} ON DELETE ${key.on_delete as string}`
    }
  }

  return found
}

/** What `schema.ts` declares, in the same terms — what the next `db:generate` would build. */
function declared (): Record<string, string> {
  const found: Record<string, string> = {}

  // Everything `schema.ts` exports — tables, enums, types' runtime shadows —
  // narrowed to the tables by drizzle's own brand check.
  const exported: unknown[] = Object.values(schema)

  for (const table of exported.filter((value): value is SQLiteTable => is(value, SQLiteTable))) {
    const { name, foreignKeys } = getTableConfig(table)

    for (const key of foreignKeys) {
      const { columns, foreignColumns, foreignTable } = key.reference()
      const child = `${name}.${columns.map((column) => column.name).join(',')}`
      const parent = `${getTableConfig(foreignTable).name}.${foreignColumns.map((column) => column.name).join(',')}`

      found[child] = `${parent} ON DELETE ${(key.onDelete ?? 'no action').toUpperCase()}`
    }
  }

  return found
}

/** Every statement of every migration, by migration, with SQL comments taken out. */
function statements (): { migration: string, sql: string }[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((sql) => ({ migration: entry.name, sql: sql.replace(/--[^\n]*/g, '').trim() }))
      .filter((one) => one.sql))
}

/** A statement that is a table rebuild, or a piece of one. */
const REBUILD = [/__new_/i, /\bDROP\s+TABLE\b/i, /\bPRAGMA\s+foreign_keys\b/i]

beforeEach(reset)

describe('foreign keys', () => {
  it('delete exactly as this table says, and there are no others', () => {
    expect(migrated()).toEqual(EXPECTED)
  })

  /**
   * The other half of the same promise. A schema that has moved on from its
   * migrations is a rebuild waiting for the next `db:generate` — changing a
   * foreign key is one of the edits SQLite can only make by rebuilding the
   * table — so the disagreement is worth hearing about before the migration
   * that would act on it exists.
   */
  it('are declared in schema.ts exactly as the migrations built them', () => {
    expect(declared()).toEqual(migrated())
  })

  /**
   * SQLite ignores foreign keys unless each connection asks for them, and
   * without that every cascade above is decoration: a deleted page would leave
   * its blocks, its paint and its translations behind, pointing at nothing.
   */
  it('are enforced by the connection the server opens', () => {
    expect(client.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })
})

describe('the migrations', () => {
  it('can be read, so the check below is looking at something', () => {
    // Desktop: its own history, which began on 2026-10-21 with one migration.
    expect(new Set(statements().map((one) => one.migration)).size).toBeGreaterThanOrEqual(1)
  })

  it('rebuild no table, since a rebuild runs its DROP TABLE with every cascade live', () => {
    const rebuilds = statements()
      .filter((one) => !DROPS[one.migration] && REBUILD.some((pattern) => pattern.test(one.sql)))
      .map((one) => `${one.migration}: ${one.sql.split('\n')[0]}`)

    expect(rebuilds).toEqual([])
  })
})
