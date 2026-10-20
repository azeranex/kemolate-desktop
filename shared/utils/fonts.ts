/**
 * The faces a page may be lettered in.
 *
 * A block stores a *key* — `dialogue`, `sfx` — and never a CSS family. Two
 * reasons, and both have bitten this kind of list before. A stored family is a
 * promise about a file: rename the face, drop it for one with better coverage,
 * and every page already lettered in it silently falls back to Times. And a
 * stack is a fallback chain, so storing one would mean every block carrying its
 * own copy of a decision that belongs in a single place — which is here.
 *
 * Every face is bundled with the app rather than fetched (`app/assets/css/fonts.css`),
 * which is why the list is short: each entry is a file the app ships, and the
 * three generics at the end cost nothing because they are whatever the reader's
 * machine already has.
 *
 * `note` is the face's real name, for a menu that has to say what `Retro FX`
 * actually is without making the label that long.
 *
 * It lives in `shared/` for the reason `lettering.ts` does: a page has to come
 * out the same wherever it is set, and anything that renders lettering without
 * reading this list would show you one page and write another.
 */

export type FontKey =
  | 'dialogue'
  | 'sfx'
  | 'retro'
  | 'casual'
  | 'marker'
  | 'hand'
  | 'poster'
  | 'sans'
  | 'serif'
  | 'mono'

export interface Font {
  key: FontKey
  label: string
  /** The CSS family list. Never stored on a block — see the header. */
  stack: string
  /** What the face is actually called, for the line under the label. */
  note: string
}

/**
 * Anime Ace first because it is the one a page is lettered in — see `faceOf`.
 *
 * Every Latin-only face names something broader behind it. Anime Ace and Outrun
 * Future have no glyphs outside Latin at all, and a translation into Russian or
 * Vietnamese set in either would come out as a row of boxes; Shantell Sans and
 * Caveat carry Cyrillic and Vietnamese, and Bangers is the display face to fall
 * back on when the display face in front of it has nothing to draw. A missing
 * glyph should land on another comic face, not on the browser's serif.
 */
export const FONTS: Font[] = [
  {
    key: 'dialogue',
    label: 'Dialogue',
    stack: '"Anime Ace 3", "Shantell Sans Variable", sans-serif',
    note: 'Anime Ace 3',
  },
  { key: 'sfx', label: 'Sound FX', stack: '"Bangers", sans-serif', note: 'Bangers' },
  {
    key: 'retro',
    label: 'Retro FX',
    stack: '"Outrun Future", "Bangers", sans-serif',
    note: 'Outrun Future',
  },
  {
    key: 'casual',
    label: 'Casual',
    stack: '"Comic Neue", "Shantell Sans Variable", sans-serif',
    note: 'Comic Neue',
  },
  {
    key: 'marker',
    label: 'Marker',
    stack: '"Permanent Marker", "Bangers", sans-serif',
    note: 'Permanent Marker',
  },
  {
    key: 'hand',
    label: 'Handwriting',
    stack: '"Caveat Variable", "Caveat", cursive',
    note: 'Caveat',
  },
  {
    key: 'poster',
    label: 'Poster',
    stack: '"Luckiest Guy", "Bangers", sans-serif',
    note: 'Luckiest Guy',
  },
  { key: 'sans', label: 'Sans', stack: 'ui-sans-serif, system-ui, sans-serif', note: 'System sans' },
  { key: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, serif', note: 'System serif' },
  { key: 'mono', label: 'Mono', stack: 'ui-monospace, Menlo, monospace', note: 'System mono' },
]

export const FONTS_BY_KEY = new Map(FONTS.map((font) => [font.key, font]))

/**
 * Which face a block is actually set in, once everything has had its say.
 *
 * The letterer's choice where they have made one, and otherwise the block's own
 * kind: a sound effect is drawn, not spoken, and setting it in the dialogue
 * face is the single most obvious thing a lettered page can get wrong. Null
 * therefore means "as the page would letter it" rather than "no face" — the
 * same grammar `vertical` uses in `Lettering`, and for the same reason. A block
 * retyped from dialogue to sound effect turns with it, and a block whose face
 * was chosen by hand stays where it was put.
 *
 * `type` is a `BlockType`, but taken as a string: the type lives in
 * `useComic` on the app side, and `shared/` cannot reach up into it.
 */
export function faceOf (font: FontKey | null, type: string): FontKey {
  if (font) return font

  return type === 'sfx' ? 'sfx' : 'dialogue'
}

/** The CSS family list for a key. Unknown keys letter as dialogue would. */
export function fontStack (key: FontKey): string {
  return (FONTS_BY_KEY.get(key) ?? FONTS[0]!).stack
}
