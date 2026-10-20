/**
 * Who is in a comic — the rules for keeping the list, without the storage.
 *
 * A cloud workspace's cast lives on the server (`server/services/cast.ts`) and a
 * local workspace's in the browser (`useCast`). Both follow these rules, so a
 * character proposed by a page is folded in the same way wherever the chapter
 * is kept: a pinned entry is never touched, an unpinned one only has its blanks
 * filled, and one person proposed twice in a reply is still one row.
 */

/**
 * How many characters a chapter may name.
 *
 * The earlier build's thirty, and for its reason: this list is prepended to
 * every page of a two-hundred-page run, so each entry is paid for two hundred
 * times. Thirty named characters is more than any one chapter has on stage.
 */
export const MAX_CAST = 30

/** Room enough for a page's worth of standing instruction, and no more. */
export const MAX_NOTES = 1200

export const MAX_CAST_TAGS = 6

/** Long enough for a full name with a title, short enough not to be a line. */
export const MAX_CAST_LENGTH = 80

export const CAST_GENDERS = ['male', 'female', 'nb', 'unknown'] as const

export type CastGender = typeof CAST_GENDERS[number]

export const isCastGender = (value: unknown): value is CastGender => CAST_GENDERS.includes(value as CastGender)

export const cleanCastText = (value: unknown) => String(value ?? '').trim().slice(0, MAX_CAST_LENGTH)

/** Two spellings of one name — case and stray spacing are not a difference. */
export const castKey = (value: string) => value.trim().toLowerCase()

export const castTags = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .map((tag) => String(tag ?? '').trim().slice(0, 60))
  .filter(Boolean)
  .slice(0, MAX_CAST_TAGS)

/** A member as either store holds one. */
export interface CastEntry {
  source: string
  names: Record<string, string> | null
  gender: CastGender
  tags: string[] | null
  pinned: boolean
}

/** One member as a person edits them. */
export interface CastDraft {
  source: string
  names?: Record<string, string> | null
  gender?: string
  tags?: string[] | null
}

/**
 * The list a person saved, cleaned: no empty or repeated names, bounded, and
 * every entry pinned by whoever stores it — looking at a row and leaving it is
 * a decision.
 */
export function normaliseCast (drafts: readonly CastDraft[]): { source: string, names: Record<string, string>, gender: CastGender, tags: string[] }[] {
  const seen = new Set<string>()
  const wanted: { source: string, names: Record<string, string>, gender: CastGender, tags: string[] }[] = []

  for (const draft of drafts) {
    const source = cleanCastText(draft.source)

    // A row with no source name is one somebody started and abandoned.
    if (!source || seen.has(castKey(source)) || wanted.length >= MAX_CAST) continue

    seen.add(castKey(source))

    const names: Record<string, string> = {}

    for (const [locale, name] of Object.entries(draft.names ?? {})) {
      const spelling = cleanCastText(name)

      if (spelling) names[locale.slice(0, 16)] = spelling
    }

    wanted.push({ source, names, gender: isCastGender(draft.gender) ? draft.gender : 'unknown', tags: castTags(draft.tags) })
  }

  return wanted
}

/**
 * What a page's proposals do to the cast: members to add, and changes to make
 * to members already there.
 *
 * Matched by source or by any spelling already recorded. A pinned member is
 * left alone; an unpinned one gets a spelling in this language only where it
 * has none, a gender only where it had `unknown`, and tags only while there is
 * room. The changes name the member object they apply to, so each store can
 * write them back however it keys its rows.
 */
export function foldCast<Row extends CastEntry> (
  rows: readonly Row[],
  learned: readonly { name?: unknown, tr?: unknown, gender?: unknown, tags?: unknown }[],
  locale: string,
): { made: CastEntry[], changed: { row: Row, values: Partial<CastEntry> }[] } {
  const byName = new Map<string, CastEntry>()

  for (const row of rows) {
    byName.set(castKey(row.source), row)

    for (const spelling of Object.values(row.names ?? {})) byName.set(castKey(spelling), row)
  }

  const made: CastEntry[] = []
  const changed: { row: Row, values: Partial<CastEntry> }[] = []

  let count = rows.length

  for (const raw of learned) {
    const source = cleanCastText(raw?.name)

    if (!source) continue

    const name = cleanCastText(raw?.tr)
    const gender = isCastGender(raw?.gender) ? raw.gender : 'unknown'
    const tags = castTags(raw?.tags)

    const found = byName.get(castKey(source)) ?? (name ? byName.get(castKey(name)) : undefined)

    if (!found) {
      if (count >= MAX_CAST) continue

      const fresh: CastEntry = { source, names: name ? { [locale]: name } : {}, gender, tags, pinned: false }

      made.push(fresh)
      // Into the index as well, so two proposals for one person in the same
      // reply do not become two rows.
      byName.set(castKey(source), fresh)
      if (name) byName.set(castKey(name), fresh)
      count += 1

      continue
    }

    // A member made earlier in this same reply is already in `made` as it will
    // be written; only rows the store handed in are changed after the fact.
    if (found.pinned || !rows.includes(found as Row)) continue

    const values: Partial<CastEntry> = {}
    const names = { ...(found.names ?? {}) }

    if (name && !names[locale]) {
      names[locale] = name
      values.names = names
    }

    if (found.gender === 'unknown' && gender !== 'unknown') values.gender = gender

    const have = found.tags ?? []
    const added = tags.filter((tag) => !have.some((held) => castKey(held) === castKey(tag)))

    if (added.length && have.length < MAX_CAST_TAGS) values.tags = [...have, ...added].slice(0, MAX_CAST_TAGS)

    if (Object.keys(values).length) changed.push({ row: found as Row, values })
  }

  return { made, changed }
}
