/**
 * Whether a key press has already been spoken for by whatever it landed on.
 *
 * Every shortcut in this app is bound on the window, which is the only place
 * that works for a tool rail and a canvas that are rarely the thing with focus.
 * The cost of that is this function: a listener on the window hears *every*
 * press, including the ones meant for something specific, and a shortcut that
 * fires anyway is a shortcut that goes off while you are using something else.
 *
 * Two kinds of target are already spoken for:
 *
 * - **Somewhere text is being written.** A field, a text area, anything
 *   contenteditable — where a letter is a letter.
 * - **An open list, menu or dialog.** These are the ones a tag name cannot
 *   catch: a select from the component kit is a button and a list of divs, not
 *   a `<select>`, so a press inside it looked like a press on the page. With
 *   the language list open, typing "p" to jump to Portuguese jumped to it *and*
 *   put the Patch tool out; an arrow to move down the list also turned the page
 *   underneath it. Both are worse the longer the list, which is what made a
 *   list of twenty-six languages the thing that found it.
 *
 * The menubar joins them for the same reason: after a click, focus sits on the
 * menu's own trigger rather than inside the open menu, and the arrow that moves
 * from File to Edit turned the page underneath instead.
 */
export function claimed (event: Event) {
  const target = event.target as HTMLElement | null

  if (!target) return false

  if (target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)) return true

  return Boolean(target.closest?.('[role="listbox"],[role="dialog"],[role="menu"],[role="menubar"],[role="grid"],[aria-modal="true"]'))
}
