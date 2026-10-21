import { describe, expect, it } from 'vitest'

import { claimed } from '~/utils/keys'

/**
 * A key press that landed on something that owns it is not a shortcut.
 *
 * The one added here: the File/Edit/View menubar. After a click the focus sits
 * on the menu's trigger, inside `role="menubar"` but outside the open
 * `role="menu"`, and the arrow meant to move from File to Edit turned the page
 * underneath instead.
 *
 * Seam: `claimed`, over key events dispatched from real elements.
 */
function pressOn (element: HTMLElement): KeyboardEvent {
  document.body.appendChild(element.closest('[data-root]') ?? element)

  let heard: KeyboardEvent | null = null

  element.addEventListener('keydown', (event) => { heard = event }, { once: true })
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))

  return heard!
}

function inside (role: string): HTMLElement {
  const root = document.createElement('div')
  const child = document.createElement('button')

  root.dataset.root = ''
  root.setAttribute('role', role)
  root.appendChild(child)

  return child
}

describe('which key presses are already spoken for', () => {
  it('leaves a press on the menubar\'s own triggers to the menubar', () => {
    expect(claimed(pressOn(inside('menubar')))).toBe(true)
  })

  it('still leaves presses inside an open menu or a list to them', () => {
    expect(claimed(pressOn(inside('menu')))).toBe(true)
    expect(claimed(pressOn(inside('listbox')))).toBe(true)
  })

  it('does not claim a press on the page itself', () => {
    const button = document.createElement('button')

    expect(claimed(pressOn(button))).toBe(false)
  })
})
