import { describe, expect, it } from 'vitest'

import { deletesSelection } from '~/composables/useDeleteShortcut'

/**
 * The guard, not the deletion.
 *
 * What is worth pinning here is every case this must *refuse*. Firing wrongly
 * takes a balloon off the page, and it does it at the exact moment a reader is
 * least able to explain what happened — mid-word, with the caret in a
 * translation box, having pressed the most ordinary key there is. The deletion
 * itself is `useComic.removeBlock`, which is undoable and has a button of its
 * own; this is the only part with no second chance.
 */
function press (key: string, opts: { target?: Partial<HTMLElement>, mods?: Partial<KeyboardEvent> } = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...opts.mods,
    target: opts.target ?? { tagName: 'DIV', isContentEditable: false },
  } as unknown as KeyboardEvent
}

describe('deletesSelection', () => {
  it('takes Delete and Backspace', () => {
    expect(deletesSelection(press('Delete'))).toBe(true)
    expect(deletesSelection(press('Backspace'))).toBe(true)
  })

  it('ignores every other key', () => {
    for (const key of ['a', 'Enter', 'Escape', 'ArrowLeft', 'd', ' ']) {
      expect(deletesSelection(press(key))).toBe(false)
    }
  })

  it('stands aside for a text field', () => {
    // The one that matters. Backspace here is how a word gets corrected, and
    // the field is where a translator spends most of their time.
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea']) {
      expect(deletesSelection(press('Backspace', { target: { tagName, isContentEditable: false } }))).toBe(false)
    }
  })

  it('stands aside for anything contenteditable', () => {
    // A lettering box is a div you can type into, so the tag name says nothing.
    const target = { tagName: 'DIV', isContentEditable: true } as Partial<HTMLElement>

    expect(deletesSelection(press('Delete', { target }))).toBe(false)
    expect(deletesSelection(press('Backspace', { target }))).toBe(false)
  })

  it('leaves the modified forms to whoever else means them', () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(deletesSelection(press('Backspace', { mods }))).toBe(false)
      expect(deletesSelection(press('Delete', { mods }))).toBe(false)
    }
  })

  it('does not treat a missing target as a text field', () => {
    // A key pressed with nothing focused still reaches the window, and that is
    // the ordinary case for somebody who has just clicked a balloon.
    expect(deletesSelection(press('Delete', { target: undefined }))).toBe(true)
  })
})
