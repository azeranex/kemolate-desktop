/**
 * The measurements the layer panel's rows are set out on.
 *
 * Here rather than in the components because two of them draw rows into the
 * same tree — `PanelLayerRow` and `PanelBlockRow` — and a tree whose halves
 * disagree about the size of a step is a tree that only looks nested. They did
 * disagree, by two pixels, for exactly as long as each kept its own copy.
 */

/** One level of nesting. */
export const TREE_STEP = 16

/**
 * The column every row keeps for whatever marks it: the twirl on a group, the
 * kind on an adjustment, the number on a block, nothing on a plain plate.
 *
 * `size-4` in the markup, and a number here because the guide line is drawn
 * down the middle of it.
 */
export const TREE_MARKER = 16

/**
 * How far in the marker column starts: the eye, and the gap after it.
 *
 * The eye is outside the indent and always in the same place, however deep a
 * row sits — see the note on it in `PanelLayerRow`. Everything that *is*
 * indented is measured from the end of it.
 */
export const TREE_LEAD = 4 + 16 + 6

/**
 * Where a row's children hang their guide line, measured from the row's left
 * edge: down the middle of the parent's own marker.
 *
 * The line is what makes nesting legible without pushing content further and
 * further right. Depth used to be readable only by comparing where two names
 * began — which failed the moment two rows at one depth carried different
 * markers, since one began at its icon and the other at its name.
 */
export const guideAt = (indent: number) => TREE_LEAD + indent + TREE_MARKER / 2
