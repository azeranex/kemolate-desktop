import { describe, expect, it } from 'vitest'
import { ref } from 'vue'

import { remember, remembered } from '~/utils/remember'

/**
 * Waiting for a stored setting, and the report that made it worth waiting for.
 *
 * The cleaner's model and mask source are part of every repair's name, and a
 * chapter looks its repairs up by that name once, as it opens. The settings come
 * back in an idle callback, which on a busy page or a tab not in front can land
 * *after* the chapter has opened — so the lookup ran under the defaults and a
 * chapter cleaned with anything else came back with no cleaning on it, although
 * every repair was still on disk.
 *
 * Nothing fails loudly if this regresses: the pages simply come back bare.
 */
describe('remembered', () => {
  it('holds a caller until the stored value is in the state', async () => {
    const key = 'kemolate:test-remembered'

    localStorage.setItem(key, JSON.stringify({ model: 'lama' }))

    const state = ref({ model: 'aot' })

    remember(key, state, (held) => (typeof held.model === 'string' ? { model: held.model } : {}))

    // The window the bug lived in: wired, and still showing the default.
    expect(state.value.model).toBe('aot')

    await remembered(key)

    expect(state.value.model).toBe('lama')

    localStorage.removeItem(key)
  })

  it('does not hold a caller for a key nothing has wired', async () => {
    // Nothing will ever settle it, so waiting would be waiting for ever.
    await expect(remembered('kemolate:test-never-wired')).resolves.toBeUndefined()
  })
})
