/**
 * Delete and Backspace, on whatever is selected.
 *
 * The key everybody reaches for and the one thing the canvas did not answer:
 * blocks could be selected, dragged, retyped and joined, and taking one off the
 * page meant finding a button for it. Every editor in this family deletes with
 * this key and a reader will press it before they look for anything else.
 *
 * ## Blocks, not everything that has a selection
 *
 * There is more than one thing on screen that can be "selected" — a layer row
 * is highlighted in the panel, a page is current in the strip — and the key
 * deliberately reaches only the blocks. Two reasons, and the second is the
 * important one.
 *
 * A layer already has a delete button that says what it will take with it, and
 * the rule about which rows may go at all lives behind it (`layerRemovable`
 * refuses anything holding a plate). A key that quietly did the same thing
 * would be a key that sometimes deletes a sheet of paint and sometimes does
 * nothing, with no way to tell which from the keyboard.
 *
 * And the selection on the canvas is the only one a reader thinks of as "what
 * is selected". It is drawn with handles around it; the others are a
 * highlighted row. Making one key mean both would make it mean neither.
 *
 * ## What it refuses
 *
 * Anything typed into. Backspace inside a text field is how you correct a
 * word, and a shortcut that ate a balloon because the caret was in the
 * translation box would be the worst kind of bug — destructive, invisible in
 * its cause, and triggered by the most ordinary keystroke there is.
 *
 * Modifiers too. Cmd+Backspace is "delete to the start of the line" on a Mac
 * and a browser shortcut elsewhere, and neither of them means this.
 *
 * Locked and hidden plates need no check here: the selection is already pruned
 * to what the stack leaves open — see the watcher in `useComic` that takes
 * blocks out of the selection when their layer is shut — so anything still
 * selected is something a tool may touch.
 */
/**
 * Whether this keystroke means "delete what is selected".
 *
 * Pulled out of the listener and exported so it can be tested, because it is
 * the half with teeth: everything it refuses is a case where firing would
 * destroy something the reader was in the middle of, and none of those cases
 * announces itself in the running app — a shortcut that eats a balloon while
 * somebody edits a translation looks like the app losing work at random.
 */
export function deletesSelection (event: KeyboardEvent): boolean {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return false

  // Cmd+Backspace is "delete to the start of the line" on a Mac and a browser
  // shortcut elsewhere. Neither of them means this.
  if (event.metaKey || event.ctrlKey || event.altKey) return false

  const target = event.target as HTMLElement | null

  // Backspace inside a text field is how you correct a word.
  if (target?.isContentEditable) return false

  return !/^(?:input|textarea|select)$/i.test(target?.tagName ?? '')
}

export function useDeleteShortcut () {
  const { selection, removeBlock } = useComic()

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (!deletesSelection(event)) return

    if (!selection.value.length) return

    /*
     * Held down, this repeats — and that is wanted rather than tolerated. The
     * selection shrinks as blocks go, so a held key walks through what was
     * selected and then finds nothing left and stops, which is what a reader
     * leaning on the key expects. There is nothing to guard against: it cannot
     * run past the end.
     */
    event.preventDefault()

    // A copy, because `removeBlock` prunes the selection as it goes — the
    // watcher that keeps ids pointing at blocks that exist runs underneath
    // this, and iterating the live array would skip every other one.
    for (const id of [...selection.value]) removeBlock(id)
  })
}
