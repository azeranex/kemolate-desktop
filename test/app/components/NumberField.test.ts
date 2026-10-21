import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import NumberField from '~/components/panel/NumberField.vue'

/**
 * A number that is both a handle and a text box, and never both at once.
 *
 * The one that matters is the third: once somebody is typing, a drag across
 * the field has to select text like any input, not move the value out from
 * under them. The rest pin what a press means before that — a drag scrubs, a
 * click without travel goes into typing with the number selected — that a
 * typed value lands on commit, not on each keystroke, and that a right-click
 * resets only where there is a default to reach and the browser's menu is not
 * wanted.
 *
 * Seam: the component mounted alone, driven by pointer and key events on its
 * input, reading what it emits.
 */

const press = (type: string, x: number, init: PointerEventInit = {}) =>
  new PointerEvent(type, { button: 0, pointerId: 1, clientX: x, bubbles: true, cancelable: true, ...init })

async function mount (props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(NumberField, {
    props: { label: 'Size', value: 40, step: 0.5, min: 10, max: 200, ...props },
    attachTo: document.body,
  })
  const input = wrapper.find('input').element as HTMLInputElement

  return { wrapper, input, sets: () => (wrapper.emitted('set') ?? []).map(([value]) => value) }
}

describe('a scrubbable number field', () => {
  it('scrubs when a press on the field travels, without taking focus or selecting', async () => {
    const { input, sets } = await mount()
    const down = press('pointerdown', 100)

    input.dispatchEvent(down)
    input.dispatchEvent(press('pointermove', 120))
    input.dispatchEvent(press('pointerup', 120))

    expect(down.defaultPrevented).toBe(true)
    expect(sets()).toEqual([50])
    expect(document.activeElement).not.toBe(input)
  })

  it('goes into typing, number selected, on a press that does not travel', async () => {
    const { input, sets } = await mount()

    input.dispatchEvent(press('pointerdown', 100))
    input.dispatchEvent(press('pointermove', 101))
    input.dispatchEvent(press('pointerup', 101))

    expect(sets()).toEqual([])
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length])
  })

  it('leaves a drag alone while typing, so it selects text', async () => {
    const { input, sets } = await mount()

    input.focus()
    await nextTick()

    const down = press('pointerdown', 100)

    input.dispatchEvent(down)
    input.dispatchEvent(press('pointermove', 180))
    input.dispatchEvent(press('pointerup', 180))

    expect(down.defaultPrevented).toBe(false)
    expect(sets()).toEqual([])
  })

  it('takes a typed value on Enter, not on each keystroke, and Escape puts it back', async () => {
    const { input, sets } = await mount()

    input.focus()
    await nextTick()
    input.value = '4'
    input.dispatchEvent(new Event('input'))
    input.value = '42'
    input.dispatchEvent(new Event('input'))

    expect(sets()).toEqual([])

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()

    expect(sets()).toEqual([42])

    input.focus()
    await nextTick()
    input.value = '99'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    expect(sets()).toEqual([42])
    expect(input.value).toBe('40')
  })

  it('shows mixed as empty, and scrubs from where it is told to', async () => {
    const { input, sets } = await mount({ value: null, from: 30 })

    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Mixed')

    input.dispatchEvent(press('pointerdown', 100))
    input.dispatchEvent(press('pointermove', 90))
    input.dispatchEvent(press('pointerup', 90))

    expect(sets()).toEqual([25])
  })

  it('keeps a scrub inside the range and to the decimals it keeps', async () => {
    const { input, sets } = await mount({ value: 1.15, min: 0.8, max: 2.2, step: 0.01, precision: 2 })

    input.dispatchEvent(press('pointerdown', 100))
    input.dispatchEvent(press('pointermove', 107))
    input.dispatchEvent(press('pointermove', 400))
    input.dispatchEvent(press('pointerup', 400))

    expect(sets()).toEqual([1.22, 2.2])
  })

  it('resets on a right-click where it can, sending the default when it is a number', async () => {
    const { wrapper, input, sets } = await mount({ resettable: true, defaultValue: 12 })
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

    input.dispatchEvent(menu)

    expect(menu.defaultPrevented).toBe(true)
    expect(wrapper.emitted('reset')).toHaveLength(1)
    expect(sets()).toEqual([12])
  })

  it('resets on a right-click that arrives as a real one — press first, then the menu', async () => {
    const { wrapper, input } = await mount({ resettable: true })
    const down = press('pointerdown', 100, { button: 2 })

    input.dispatchEvent(down)
    // What the browser does with a press nobody held back: focus the field.
    if (!down.defaultPrevented) input.focus()
    await nextTick()
    input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    expect(down.defaultPrevented).toBe(true)
    expect(wrapper.emitted('reset')).toHaveLength(1)
    expect(document.activeElement).not.toBe(input)
  })

  it('keeps the browser menu where there is nothing to reset, or while typing', async () => {
    const { wrapper, input } = await mount({ resettable: false })
    const idle = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

    input.dispatchEvent(idle)

    expect(idle.defaultPrevented).toBe(false)

    await wrapper.setProps({ resettable: true })
    input.focus()
    await nextTick()

    const typing = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

    input.dispatchEvent(typing)

    expect(typing.defaultPrevented).toBe(false)
    expect(wrapper.emitted('reset')).toBeUndefined()
  })
})
