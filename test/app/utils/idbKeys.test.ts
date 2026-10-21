import { describe, expect, it } from 'vitest'

import { idbKey, idbPrefix, WORKSPACE_OWNED } from '~/utils/idbKeys'

/**
 * The names records are filed under, pinned.
 *
 * A record in IndexedDB is found by its name and by nothing else, so a builder
 * that spelled a key differently would not fail — it would find nothing, and
 * every record written before the change would sit there unread for good. These
 * are the exact strings the app has always written.
 *
 * And the list deleting a workspace sweeps must cover every kind named after a
 * workspace. It was a hand-kept copy that missed `blocks:` and `usage:` once and
 * `repairs-shown:` again.
 */
describe('idbKey', () => {
  it('spells every key the way the app has always written it', () => {
    expect(idbKey.workspace('ws')).toBe('workspace:ws')
    expect(idbKey.pages('ws')).toBe('workspace:ws:pages')
    expect(idbKey.target('ws')).toBe('workspace:ws:target')
    expect(idbKey.direction('ws')).toBe('workspace:ws:direction')
    expect(idbKey.lettering('ws')).toBe('workspace:ws:lettering')
    expect(idbKey.position('ws')).toBe('workspace:ws:at')
    expect(idbKey.usage('ws')).toBe('usage:ws')
    expect(idbKey.blocks('ws', 'h')).toBe('blocks:ws:h')
    expect(idbKey.layers('ws', 'h')).toBe('layers:ws:h')
    expect(idbKey.glossary('ws', 'en')).toBe('glossary:ws:en')
    expect(idbKey.cast('ws')).toBe('cast:ws')
    expect(idbKey.history('ws', 'p')).toBe('history:ws:p')
    expect(idbKey.repairsShown('ws', 'h')).toBe('repairs-shown:ws:h')
    expect(idbKey.previews('ws')).toBe('previews:ws')
    expect(idbKey.paint('h:bg')).toBe('paint:h:bg')
  })

  it('opens each prefix the way the keys under it open', () => {
    expect(idbKey.glossary('ws', 'en').startsWith(idbPrefix.glossaries('ws'))).toBe(true)
    expect(idbKey.history('ws', 'p').startsWith(idbPrefix.histories('ws'))).toBe(true)
    expect(idbKey.paint('h:bg').startsWith(idbPrefix.paint('h'))).toBe(true)
  })
})

describe('WORKSPACE_OWNED', () => {
  it('covers every key named after a workspace, and so goes with it', () => {
    const owned = [
      idbKey.workspace('ws'),
      idbKey.pages('ws'),
      idbKey.target('ws'),
      idbKey.direction('ws'),
      idbKey.lettering('ws'),
      idbKey.position('ws'),
      idbKey.usage('ws'),
      idbKey.blocks('ws', 'h'),
      idbKey.layers('ws', 'h'),
      idbKey.glossary('ws', 'en'),
      idbKey.cast('ws'),
      idbKey.history('ws', 'p'),
      idbKey.repairsShown('ws', 'h'),
      idbKey.previews('ws'),
    ]

    for (const key of owned) {
      expect(WORKSPACE_OWNED.some((prefix) => key.startsWith(`${prefix}ws`))).toBe(true)
    }
  })

  it('leaves what is shared between workspaces alone', () => {
    expect(WORKSPACE_OWNED.some((prefix) => idbKey.paint('h:bg').startsWith(prefix))).toBe(false)
  })
})
