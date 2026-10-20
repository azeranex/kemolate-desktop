/**
 * Which tool is out, and the list the rail is drawn from.
 *
 * A tool is a mode the pointer is in, not a command: picking one changes what
 * a press on the page means until another is picked. Only one is ever out, so
 * the whole of the state is a single id — everything else about a tool (its
 * glyph, its name, the key that reaches for it) is fixed, and lives in the
 * registry below.
 *
 * The registry is the only list of tools there is: adding one here puts it in
 * the rail and in the keyboard shortcuts without touching either.
 */
import {
  BandageIcon,
  BrushCleaningIcon,
  BrushIcon,
  EraserIcon,
  LanguagesIcon,
  LassoIcon,
  MousePointer2Icon,
  PipetteIcon,
  ScanTextIcon,
  SquareDashedIcon,
  StampIcon,
  TypeIcon,
} from '@lucide/vue'

import type { Component } from 'vue'

export type ToolId =
  | 'select'
  | 'brush'
  | 'eraser'
  /**
   * Lettering with no scan behind it — an effect the letterer draws in, a sign,
   * a credit, a note. The opposite way round from the region tools: those are
   * about *reading* what is printed, this is about setting what is not.
   */
  | 'text'
  | 'heal'
  | 'clone'
  | 'picker'
  | 'patch'
  | 'ignore'
  /**
   * Correct what the cleaning will paint out — add ink the threshold missed,
   * wipe artwork it took for lettering. It edits the *mask*, never pixels, so
   * a balloon fixed by hand improves again when the inpainter is swapped.
   */
  | 'mask'
  /**
   * Paint over lettering, and have the model read it and carry it over at once.
   *
   * A brush rather than the box every other editor draws here, and that is the
   * point of it: these tools exist for the lettering with no balloon around it,
   * which is exactly the lettering no rectangle fits — see `runRegion`.
   */
  | 'translate-region'
  /** The same stroke, read by Google Vision and left in its own language. */
  | 'read-region'

/**
 * A control a tool wants in the context bar above the canvas.
 *
 * Named rather than described, because there is exactly one control per name
 * and it is the same control wherever it appears — the brush's size is not a
 * different setting from the eraser's, it is the same number reached through a
 * different tool. See `usePaintSettings`, which is where that number lives.
 */
export type ToolOption = 'size' | 'softness' | 'colour' | 'mask-mode'

export interface Tool {
  id: ToolId
  label: string
  /** The one key that reaches for it, shown on the tooltip. */
  key: string
  icon: Component
  /**
   * What it puts in the context bar, in the order shown.
   *
   * Declared beside the glyph and the key for the same reason those are: the
   * registry is the only list of tools there is, so a tool added here arrives
   * complete — in the rail, on the keyboard, and with its own settings — and
   * there is no second place to forget.
   *
   * Absent for the tools that have no dials. A select or a region drag does
   * the same thing however the brush is set, and a bar offering settings that
   * change nothing is worse than an empty one.
   */
  options?: ToolOption[]
}

/**
 * The rail, in the groups it is drawn in: the tools that work the page
 * directly, then the two that hand a piece of it to a machine to read.
 *
 * Groups rather than a separator flag on the tool that starts one — the rail
 * draws a line between them, and a list of lists says that without every tool
 * having to know where it sits.
 */
export const TOOL_GROUPS: Tool[][] = [
  [
    { id: 'select', label: 'Select', key: 'V', icon: MousePointer2Icon },
    { id: 'brush', label: 'Brush', key: 'B', icon: BrushIcon, options: ['size', 'softness', 'colour'] },
    // No colour: an eraser lays down absence, and a swatch on it would be a
    // control that looks like it does something.
    { id: 'eraser', label: 'Eraser', key: 'E', icon: EraserIcon, options: ['size', 'softness'] },
    // No options, and that is a decision rather than an omission. Everything a
    // bar could offer here — size, weight, spacing, which way the line is set —
    // is already the Lettering panel's, working on the selection, and a text
    // block is selected the moment it is placed. A second control over the same
    // number is the second place it can disagree from; see `ToolOption`.
    { id: 'text', label: 'Text', key: 'T', icon: TypeIcon },
    { id: 'heal', label: 'Patch healing', key: 'H', icon: BandageIcon, options: ['size', 'softness'] },
    // The tools that were hardest to read: a stamp for the clone stamp, a
    // pipette for the eyedropper and a lasso for the patch — the shapes every
    // other editor uses — rather than a copy, a swatch and a crop frame.
    { id: 'clone', label: 'Clone stamp', key: 'C', icon: StampIcon, options: ['size', 'softness'] },
    { id: 'picker', label: 'Colour picker', key: 'I', icon: PipetteIcon, options: ['colour'] },
    { id: 'patch', label: 'Patch', key: 'P', icon: LassoIcon },
    { id: 'ignore', label: 'Masking', key: 'G', icon: SquareDashedIcon },
    // Mode first: it is the one setting that changes what the stroke *means*
    // rather than how wide it is, and it is the one being read at a glance.
    { id: 'mask', label: 'Mask brush', key: 'K', icon: BrushCleaningIcon, options: ['mask-mode', 'size', 'softness'] },
  ],
  [
    /*
     * Both region tools paint the same stroke; what differs is what comes back.
     * So the glyphs say the *outcome* rather than the gesture, and they say it
     * in the words this app already uses: `ScanTextIcon` is what the Detect
     * panel and both Read page buttons wear, and `LanguagesIcon` is the
     * Translate panel's own. One region of the page, put through one of those
     * two — which is exactly what these are, and a reader who has met either
     * panel has already learned the pair.
     *
     * The mouse-pointer-over-a-dashed-box that stood here was left over from
     * when these dragged a rectangle. It described the gesture, it described it
     * wrongly once the gesture became a stroke, and it said nothing at all about
     * what the tool was for — two tools whose whole difference is the answer
     * they bring back cannot part on a picture of a marquee.
     *
     * Nothing in either glyph says "brush", and that is the trade taken
     * deliberately: the pair sits alone under a divider, and picking one puts a
     * Size dial in the bar, so how it is used is said twice over. What it does
     * to the words was said nowhere.
     *
     * Size and nothing else in that bar. A softness on a selection would be a
     * dial that looks like it does something: the shape is a knockout, and a
     * knockout is in or out — see `knockOut`, where the edge is decided.
     */
    { id: 'translate-region', label: 'Translate region', key: 'R', icon: LanguagesIcon, options: ['size'] },
    { id: 'read-region', label: 'Read region', key: 'A', icon: ScanTextIcon, options: ['size'] },
  ],
]

export const TOOLS = TOOL_GROUPS.flat()

/**
 * The tools that put pixels on the cleaned plate — the ones whose press belongs
 * to the paint canvas rather than to the blocks over it.
 *
 * The picker is among them because it reads that canvas: it samples the plate it
 * would paint on, so it wants the pointer on the same terms.
 */
export const PAINT_TOOLS = new Set<ToolId>(['brush', 'eraser', 'clone', 'heal', 'picker'])

/**
 * The two that hand a painted piece of the page to a reader — see `runRegion`.
 *
 * A set rather than a comparison written out at each of the three places that
 * asks, because they are always asked about together: they mount the same
 * brush, they own the pointer on the same terms, and the only thing that parts
 * them is who reads the stroke.
 */
export const REGION_TOOLS = new Set<ToolId>(['translate-region', 'read-region'])

/**
 * The tools that own the pointer over the page, so a stroke that crosses a
 * balloon goes on stroking instead of selecting it. The mask brush is one of
 * them without being a paint tool: it draws onto the mask, not the plate, so
 * it does not want `clean` to be reachable — only for the blocks to keep out
 * of its way. The region brushes are here for that half alone as well: they
 * paint nothing that is kept, but a stroke across a balloon that picked the
 * balloon up instead would be a tool that cannot reach the lettering beside
 * one, which is most of the lettering it is for.
 */
export const STROKE_TOOLS = new Set<ToolId>([...PAINT_TOOLS, 'mask', ...REGION_TOOLS])

export function useTools () {
  /** Select, because it is the one tool that changes nothing by being out. */
  const tool = useState<ToolId>('tool', () => 'select')

  const { layers, layerSelection, inked } = useComic()

  /**
   * Whether the pointer belongs to the paint canvas right now.
   *
   * Two conditions, and the second is the layer engine's: a paint tool out, and
   * a row selected that can actually hold the mark — see `inked`, which is
   * where that question lives. Kept there rather than worked out by the canvas
   * and again by the board, which is how the two came to disagree — with the
   * cleaned plate locked, one of them made the blocks pointer-transparent
   * while the other refused the stroke, and the page took no press at all.
   *
   * It used to ask only whether the cleaned plate was open, which was the same
   * question while the cleaned plate was the only thing paint could land on.
   * With blank layers it stopped being: the brush was armed over a group, and
   * armed meant painting the repair.
   */
  const painting = computed(() => PAINT_TOOLS.has(tool.value) && Boolean(inked.value))

  /**
   * Whether any tool that draws has the pointer — see `STROKE_TOOLS`.
   *
   * Not `STROKE_TOOLS.has(tool)` outright, and that is the whole reason this is
   * written out: a paint tool only has the pointer once there is a row that
   * will take the mark, which is `painting`'s question. The mask brush and the
   * region brushes have no such gate — one paints the mask and the others paint
   * nothing at all — so having the tool out is the whole of it.
   */
  const stroking = computed(() =>
    painting.value || tool.value === 'mask' || REGION_TOOLS.has(tool.value))

  /**
   * Reaching for a tool, and — for the mask brush — the layer that goes with
   * it.
   *
   * The mask has exactly one row it could ever be painted on, so reaching for
   * its brush says which layer you are working on as plainly as clicking the
   * row would. Selecting it costs nothing and settles the question the panel
   * would otherwise be answering wrongly: the mask brush works whatever is
   * highlighted, so without this you corrected the mask while the panel said
   * you were on Dialogue.
   *
   * Deliberately only the mask. A paint tool has as many possible homes as
   * there are sheets and no way to know which you meant, so it waits to be
   * told — which is the whole reason the selection gates it.
   *
   * The row is selected whether or not it will take the stroke. A locked mask
   * refuses the brush, and highlighting it is how you find out why rather than
   * being left with a tool that does nothing for no visible reason.
   */
  function setTool (id: ToolId) {
    tool.value = id

    if (id !== 'mask') return

    const row = inkLayer(layers.value, 'mask')

    if (row) layerSelection.value = row.id
  }

  return { tool, painting, stroking, setTool }
}

/**
 * A tool per key, the way every editor does it.
 *
 * Bare keys only: a shortcut with a modifier on it belongs to the browser or
 * to the command it is named after, and a tool grabbing one would take away
 * an undo or a page reload. Typing is not reaching for a tool either, so
 * anything with a caret in it keeps its letters.
 */
export function useToolShortcuts () {
  const { setTool } = useTools()

  const byKey = new Map(TOOLS.map((t) => [t.key.toLowerCase(), t.id]))

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return

    // Not while something else has the press — a field, or an open list whose
    // own type-ahead these letters belong to. See `claimed`.
    if (claimed(event)) return

    const id = byKey.get(event.key.toLowerCase())

    if (!id) return

    event.preventDefault()
    setTool(id)
  })
}
