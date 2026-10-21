/**
 * The workspace database: one SQLite file the app owns, opened once in the main
 * process, checked before it is trusted and backed up on its own.
 *
 * Why this exists at all. Until 2026-10-21 everything a desktop workspace kept
 * lived in the window's IndexedDB, and Chromium answers a corrupt IndexedDB by
 * deleting it and starting empty — without a word. A reader lost a 114-page
 * chapter's reading and translation that way. So the work now lives in a file
 * this process holds (`<profile>/kemolate.db`, the web build's schema through its
 * services — see `electron/data.ts`), and this module makes sure that the same
 * thing cannot happen to it:
 *
 * - **A damaged file is never deleted.** At open it is asked `PRAGMA
 *   quick_check`; a file that fails, will not open, or is empty where a database
 *   used to be, is moved aside as `kemolate.db.corrupt-<time>` (its `-wal` and
 *   `-shm` with it) and the newest backup that passes the same check is put in
 *   its place. The window is told (`notice()`), so it never happens silently.
 * - **Backups are copies SQLite makes itself** (`VACUUM INTO`), consistent
 *   whatever is mid-write, written under a temporary name and renamed, so a
 *   backup that is listed is a whole one. One at launch if the newest is over an
 *   hour old, one before any migration, one an hour while there were writes, and
 *   one on quit. Kept: everything from the last day (at most 24), then the
 *   newest of each day for 30 days — and never fewer than the newest three.
 * - **A restore the reader asks for happens at the next launch**, before the
 *   database is opened (`restoreAtLaunch`): the file in use is moved aside as
 *   `kemolate.db.replaced-<time>` rather than overwritten, so a restore can be
 *   undone by hand.
 * - **Repair files outlive their rows for as long as a backup names them.** A
 *   repair's PNG is not in the database (`server/utils/repairStore.ts`), so a
 *   backup is only whole if the files its rows name are still on disk. The
 *   hourly sweep therefore spares every hash any backup names.
 *
 * The services read `process.env.DATABASE_URL` when `server/database` is first
 * imported, so that import is dynamic and happens only after the path is set and
 * the file has been checked — a static import would open the file before any of
 * this ran.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { app } from 'electron'

import type { Backup, DataNotice } from './preload'

import { installServerGlobals } from '~~/server/utils/errors'
import { keepRepairsIn } from '~~/server/utils/repairStore'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Everything from the last day, then one a day for a month. */
const KEEP_RECENT_MS = DAY
const KEEP_RECENT_MAX = 24
const KEEP_DAILY_MS = 30 * DAY
const KEEP_AT_LEAST = 3

const BACKUP = /^kemolate-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.db$/

const profile = () => app.getPath('userData')
export const databaseFile = () => path.join(profile(), 'kemolate.db')
export const backupsFolder = () => path.join(profile(), 'backups')
const restoreMarker = () => path.join(profile(), 'restore.json')

const stamp = (at = new Date()) => at.toISOString().replace(/\.\d+Z$/, '').replaceAll(':', '-').replace('T', '_')

let notice: DataNotice = {}
let dirty = false
let lastBackup = 0
let timers: NodeJS.Timeout[] = []
let database: typeof import('~~/server/database') | null = null

/** Whether a file is a whole SQLite database: opens, and `quick_check` says ok. */
export function healthy (file: string): boolean {
  if (!existsSync(file) || statSync(file).size === 0) return false

  try {
    const probe = new DatabaseSync(file)

    try {
      const rows = probe.prepare('PRAGMA quick_check').all() as { quick_check: string }[]

      return rows.length === 1 && rows[0]!.quick_check === 'ok'
    } finally {
      probe.close()
    }
  } catch {
    return false
  }
}

/** Move a database and its journal files out of the way, under `suffix`. Never deletes. */
function moveAside (file: string, suffix: string): string {
  const aside = `${file}.${suffix}-${stamp()}`

  for (const tail of ['', '-wal', '-shm']) {
    if (existsSync(file + tail)) renameSync(file + tail, aside + tail)
  }

  return aside
}

export function listBackups (): Backup[] {
  const folder = backupsFolder()

  if (!existsSync(folder)) return []

  return readdirSync(folder)
    .map((name) => {
      const match = BACKUP.exec(name)

      if (!match) return null

      const [, y, mo, d, h, mi, s] = match.map(Number)

      return { name, at: Date.UTC(y!, mo! - 1, d!, h!, mi!, s!), bytes: statSync(path.join(folder, name)).size }
    })
    .filter((each): each is Backup => each !== null)
    .sort((a, b) => b.at - a.at)
}

/** Put a backup in place of the database file, moving what was there aside first. */
function putInPlace (backup: string, asideAs: string): string | undefined {
  const file = databaseFile()
  const aside = existsSync(file) ? moveAside(file, asideAs) : undefined

  copyFileSync(backup, file)

  return aside
}

/** The newest backup that passes the check, or null. */
function newestHealthy (): Backup | null {
  return listBackups().find((each) => healthy(path.join(backupsFolder(), each.name))) ?? null
}

/** Ask for a backup to replace the database at the next launch. The caller relaunches. */
export function restoreAtLaunch (name: string): void {
  if (!listBackups().some((each) => each.name === name)) throw new Error(`No backup called ${name}.`)

  writeFileSync(restoreMarker(), JSON.stringify({ name }))
}

/** Before opening: a restore asked for, then the integrity check. */
function prepare (): void {
  const file = databaseFile()

  if (existsSync(restoreMarker())) {
    let name = ''

    try {
      name = JSON.parse(readFileSync(restoreMarker(), 'utf8')).name
    } catch {
      // Unreadable: no restore, and the marker goes — the database is opened as it is.
    }

    rmSync(restoreMarker(), { force: true })

    const chosen = path.join(backupsFolder(), path.basename(name))

    if (name && healthy(chosen)) {
      putInPlace(chosen, 'replaced')
      notice = { restoredFrom: path.basename(name), chosen: true }

      return
    }
  }

  // No file yet: a first launch, nothing to check.
  if (!existsSync(file) && !existsSync(`${file}-wal`)) return

  if (healthy(file)) return

  const quarantined = path.basename(moveAside(file, 'corrupt'))
  const backup = newestHealthy()

  if (backup) {
    copyFileSync(path.join(backupsFolder(), backup.name), file)
    notice = { quarantined, restoredFrom: backup.name }
  } else {
    notice = { quarantined, startedEmpty: true }
  }

  console.error('[database] the database failed its check and was moved aside', notice)
}

/** Migration folders the database has not applied yet. */
function pendingMigrations (folder: string): string[] {
  const local = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(folder, entry.name, 'migration.sql')))
    .map((entry) => entry.name)

  const file = databaseFile()

  if (!existsSync(file)) return local

  const probe = new DatabaseSync(file)

  try {
    const table = probe.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`).get()

    if (!table) return local

    const applied = new Set((probe.prepare('SELECT name FROM __drizzle_migrations').all() as { name: string | null }[]).map((row) => row.name))

    return local.filter((name) => !applied.has(name))
  } finally {
    probe.close()
  }
}

export const migrationsFolder = () => app.isPackaged
  ? path.join(process.resourcesPath, 'migrations')
  : path.join(app.getAppPath(), 'server', 'database', 'migrations')

/**
 * Open the database: restore if asked, check, back up before migrating, migrate,
 * and start the backup and sweep timers. Called once, before the window loads.
 */
export async function openDatabase (): Promise<DataNotice> {
  installServerGlobals()
  keepRepairsIn(path.join(profile(), 'repairs'))
  mkdirSync(backupsFolder(), { recursive: true })

  prepare()

  lastBackup = listBackups()[0]?.at ?? 0

  const migrations = migrationsFolder()
  const pending = pendingMigrations(migrations)
  const existed = existsSync(databaseFile())

  process.env.DATABASE_URL = databaseFile()
  database = await import('~~/server/database')

  // Before the schema changes under it: the one backup a bad migration cannot spoil.
  if (existed && pending.length) backup()

  const { migrate } = await import('drizzle-orm/node-sqlite/migrator')

  migrate(database.db, { migrationsFolder: migrations })

  if (Date.now() - lastBackup > HOUR) backup()

  timers = [
    setInterval(() => {
      if (dirty) backup()
    }, HOUR),
    // `sweepRepairs` catches its own failures.
    setTimeout(() => { sweepRepairs() }, 60 * 1000),
    setInterval(() => { sweepRepairs() }, HOUR),
  ]

  for (const timer of timers) timer.unref()

  return notice
}

/** What opening found — asked by the window once it is up. */
export const openingNotice = () => notice

/** A write went through: the next hourly backup has something to keep. */
export function written (): void {
  dirty = true
}

/** A backup, now. Synchronous: SQLite writes it, and quitting waits for it. */
export function backup (): Backup {
  if (!database) throw new Error('The database is not open.')

  const folder = backupsFolder()
  let name = `kemolate-${stamp()}.db`

  // Two in one second — a backup on quit straight after a launch's.
  for (let n = 1; existsSync(path.join(folder, name)); n++) name = `kemolate-${stamp()}-${n}.db`

  const partial = path.join(folder, `${name}.partial`)

  rmSync(partial, { force: true })
  database.client.exec(`VACUUM INTO '${partial.replaceAll('\'', '\'\'')}'`)
  renameSync(partial, path.join(folder, name))

  dirty = false
  lastBackup = Date.now()
  prune()

  return listBackups().find((each) => each.name === name)!
}

/** Which backups the retention rule keeps — pure, for the tests. `backups` newest first. */
export function kept (backups: Backup[], now = Date.now()): Set<string> {
  const keep = new Set<string>()
  const days = new Set<string>()
  let recent = 0

  for (const [index, each] of backups.entries()) {
    const age = now - each.at
    const day = new Date(each.at).toISOString().slice(0, 10)
    const take = index < KEEP_AT_LEAST
      || (age < KEEP_RECENT_MS && recent < KEEP_RECENT_MAX)
      // Newest first, so the first of a day not yet kept is that day's newest.
      || (age < KEEP_DAILY_MS && !days.has(day))

    if (!take) continue

    keep.add(each.name)
    days.add(day)

    if (age < KEEP_RECENT_MS) recent++
  }

  return keep
}

function prune (): void {
  const all = listBackups()
  const keep = kept(all)

  for (const each of all) {
    if (!keep.has(each.name)) rmSync(path.join(backupsFolder(), each.name), { force: true })
  }
}

/** Every repair hash any backup names — files a restore would need. */
function namedByBackups (): Set<string> {
  const named = new Set<string>()

  for (const each of listBackups()) {
    try {
      const probe = new DatabaseSync(path.join(backupsFolder(), each.name), { readOnly: true })

      try {
        for (const row of probe.prepare('SELECT DISTINCT hash FROM repairs').all() as { hash: string }[]) named.add(row.hash)
      } finally {
        probe.close()
      }
    } catch (error) {
      // A backup that cannot be read names nothing we can know — and so nothing is swept.
      console.warn('[database] could not read a backup to sweep against', each.name, error)

      return new Set(['*'])
    }
  }

  return named
}

async function sweepRepairs (): Promise<void> {
  try {
    const named = namedByBackups()

    if (named.has('*')) return

    const { sweep } = await import('~~/server/services/repairs')
    const gone = await sweep(Date.now(), named)

    if (gone) console.info(`[database] swept ${gone} repair file(s) nothing names`)
  } catch (error) {
    console.warn('[database] repair sweep failed', error)
  }
}

/** On quit: a backup if anything changed since the last, then close. */
export function closeDatabase (): void {
  for (const timer of timers) clearInterval(timer)

  if (!database) return

  try {
    if (dirty) backup()
  } catch (error) {
    console.error('[database] backup on quit failed', error)
  }

  try {
    database.client.close()
  } catch {
    // Quitting either way.
  }

  database = null
}
