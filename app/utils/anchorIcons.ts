/**
 * Icons for where lettering sits in its balloon — top, middle or bottom — drawn
 * to match the alignment icons beside them.
 *
 * The alignment row uses Lucide's text-align set: three strokes of a ragged
 * paragraph, flush left, centred or flush right. The anchor row used Lucide's
 * `AlignVerticalJustify*`, which are boxes on a rule — a different family,
 * drawn for arranging objects, and the two rows read as two unrelated controls
 * when they are the same decision along two axes. Lucide has no text-line icon
 * for the vertical axis, so these are the text-align strokes transposed: the
 * same three lines at the same lengths, turned to run down and hung from the
 * top, centred, or stood on the bottom.
 *
 * Through `createLucideIcon`, so size, stroke and class follow every other icon
 * in the panel rather than being restated here.
 */
import { createLucideIcon } from '@lucide/vue'

/** `text-align-start`, transposed: hung from the top edge. */
export const AnchorTopIcon = createLucideIcon('anchor-top', [
  ['path', { d: 'M5 21V3', key: 'top-1' }],
  ['path', { d: 'M12 15V3', key: 'top-2' }],
  ['path', { d: 'M19 17V3', key: 'top-3' }],
])

/** `text-align-center`, transposed: centred between the edges. */
export const AnchorMiddleIcon = createLucideIcon('anchor-middle', [
  ['path', { d: 'M5 21V3', key: 'middle-1' }],
  ['path', { d: 'M12 17V7', key: 'middle-2' }],
  ['path', { d: 'M19 19V5', key: 'middle-3' }],
])

/** `text-align-end`, transposed: stood on the bottom edge. */
export const AnchorBottomIcon = createLucideIcon('anchor-bottom', [
  ['path', { d: 'M5 21V3', key: 'bottom-1' }],
  ['path', { d: 'M12 21V9', key: 'bottom-2' }],
  ['path', { d: 'M19 21V7', key: 'bottom-3' }],
])
