/**
 * The brush, as the person has it set: size, softness, colour.
 *
 * One set for all the paint tools rather than one per tool, which is how the
 * earlier build had it and how it feels right on a page — reaching for the
 * eraser should not change the size of the hole you make.
 *
 * `[` and `]` step the size the way every editor does. Multiplied rather than
 * added: a step that feels right at 12px is imperceptible at 200.
 */
/**
 * The diameters a brush can be set to, in page pixels.
 *
 * Here rather than at each place that sets one, because there were three and
 * they disagreed: the slider stopped at 200 while `[`, `]` and the drag went to
 * 400, so the slider sat pinned at its right-hand end for the whole top half of
 * the range and reported a size the brush was not.
 */
export const SIZE_MIN = 1
export const SIZE_MAX = 400

/** A diameter, brought inside the range and made whole. */
export function clampSize (value: number): number {
  return Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, value)))
}

/** Where the brush keeps itself between sessions, on this machine. */
const STORE = 'kemolate:brush'

let wired = false

export function usePaintSettings () {
  /** Diameter, in page pixels. */
  const size = useState('paint-size', () => 28)

  /** 0 crisp .. 1 no edge at all. */
  const softness = useState('paint-softness', () => 0.65)

  const colour = useState('paint-colour', () => '#ffffff')

  /**
   * Remembered on this machine, not on the server: a brush size is a fact
   * about this hand, this screen and this trackpad, and syncing it would
   * have two collaborators fighting over one dial.
   *
   * Restored after hydration rather than during it, because the server has
   * already rendered the defaults into the bar — swapping the values mid-
   * hydrate is a mismatch warning for every readout that shows them. Wired
   * once for the app, however many components ask for the brush.
   */
  if (import.meta.client && !wired) {
    wired = true

    onNuxtReady(() => {
      try {
        const held = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, unknown>

        if (typeof held.size === 'number') size.value = clampSize(held.size)
        if (typeof held.softness === 'number') softness.value = Math.min(1, Math.max(0, held.softness))
        if (typeof held.colour === 'string' && /^#[0-9a-f]{6}$/i.test(held.colour)) colour.value = held.colour
      } catch {
        // A broken entry reads as defaults, and the next change rewrites it.
      }

      watch([size, softness, colour], () => {
        localStorage.setItem(STORE, JSON.stringify({
          size: size.value,
          softness: softness.value,
          colour: colour.value,
        }))
      })
    })
  }

  return { size, softness, colour }
}

export function usePaintSettingShortcuts () {
  const { size } = usePaintSettings()

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const target = event.target as HTMLElement | null

    if (target?.isContentEditable || /^(?:input|textarea|select)$/i.test(target?.tagName ?? '')) return

    if (event.key !== '[' && event.key !== ']') return

    event.preventDefault()

    const factor = event.key === ']' ? 1.25 : 0.8

    size.value = clampSize(size.value * factor)
  })
}
