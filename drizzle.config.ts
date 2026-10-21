import { defineConfig } from 'drizzle-kit'

/**
 * The desktop's migrations, made from its own schema (`server/database/schema.ts`
 * — the web build's workspace tables without accounts and sharing) and applied
 * by the main process at start (`electron/database.ts`). `pnpm db:generate`
 * writes a new one after a schema change.
 *
 * The web build's rule holds here too, and is worth more here, where the file is
 * the reader's only copy: read every generated migration for `__new_` before it
 * ships. That is drizzle-kit rebuilding a table to change a column, and the
 * migrator runs inside a transaction, where SQLite ignores `foreign_keys = OFF` —
 * so the `DROP TABLE` in a rebuild fires every cascade under it. Doing that to
 * `layers` once deleted all the paint in the web build's database.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './server/database/schema.ts',
  out: './server/database/migrations',
  strict: true,
})
