import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it, vi } from 'vitest'

import type { Backup } from '~~/electron/preload'

/**
 * The database file's guard rails — `electron/database.ts`.
 *
 * Two of them can be held to account without an app: which backups the
 * retention rule keeps, and what counts as a whole database. The second is the
 * one a reader's work depends on — a file that fails it is moved aside and
 * replaced from a backup, so it must say no to a damaged or emptied file and
 * yes to a sound one, including an empty sound one. Opening, migrating and
 * restoring are driven against the built app on a test profile instead.
 */

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

const { healthy, kept } = await import('~~/electron/database')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 21, 12)

/** Backups at these ages, newest first, as `listBackups` gives them. */
const aged = (...ages: number[]): Backup[] => ages
  .map((age) => ({ name: `b-${age}`, at: NOW - age, bytes: 1 }))
  .sort((a, b) => b.at - a.at)

describe('kept', () => {
  it('keeps every backup of the last day, up to 24', () => {
    const backups = aged(...Array.from({ length: 30 }, (_, n) => n * 40 * 60 * 1000))
    const keep = kept(backups, NOW)
    const ofLastDay = backups.filter((each) => NOW - each.at < DAY)

    expect(ofLastDay.filter((each) => keep.has(each.name))).toHaveLength(24)
  })

  it('keeps the newest of each older day, for 30 days', () => {
    const keep = kept(aged(0, 2 * DAY + HOUR, 2 * DAY + 2 * HOUR, 3 * DAY + HOUR, 3 * DAY + 5 * HOUR, 5 * DAY), NOW)

    // The first three always; then one more for the third day back.
    expect([...keep].sort()).toEqual(['b-0', `b-${2 * DAY + HOUR}`, `b-${2 * DAY + 2 * HOUR}`, `b-${3 * DAY + HOUR}`, `b-${5 * DAY}`].sort())
  })

  it('lets go of a month-old backup — but never of the newest three', () => {
    expect(kept(aged(40 * DAY, 41 * DAY, 42 * DAY, 43 * DAY), NOW)).toEqual(new Set([`b-${40 * DAY}`, `b-${41 * DAY}`, `b-${42 * DAY}`]))
  })
})

describe('healthy', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'kemolate-db-'))

  function aDatabase (name: string) {
    const file = path.join(folder, name)
    const db = new DatabaseSync(file)

    db.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY, name TEXT)')
    db.exec(`INSERT INTO pages (name) VALUES ${Array.from({ length: 500 }, (_, n) => `('page ${n}')`).join(',')}`)
    db.close()

    return file
  }

  it('says yes to a sound database', () => {
    expect(healthy(aDatabase('sound.db'))).toBe(true)
  })

  it('says no to a file that is not there, or is empty', () => {
    const empty = path.join(folder, 'empty.db')

    writeFileSync(empty, '')

    expect(healthy(path.join(folder, 'absent.db'))).toBe(false)
    expect(healthy(empty)).toBe(false)
  })

  it('says no to a database whose header was overwritten', () => {
    const file = aDatabase('header.db')
    const bytes = new Uint8Array(100).fill(7)

    writeFileSync(file, bytes, { flag: 'r+' })

    expect(healthy(file)).toBe(false)
  })
})
