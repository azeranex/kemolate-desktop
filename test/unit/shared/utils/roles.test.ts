import { describe, expect, it } from 'vitest'

import { atLeast } from '#shared/utils/roles'

/**
 * The ordering is the whole point of the module, so the expectations are
 * written out as the four names rather than derived from `WORKSPACE_ROLES` —
 * a test that indexed the same array the code ranks by would agree with any
 * order at all, including a wrong one.
 */
describe('atLeast', () => {
  it('lets a higher role clear a lower bar', () => {
    expect(atLeast('owner', 'editor')).toBe(true)
    expect(atLeast('editor', 'translator')).toBe(true)
    expect(atLeast('translator', 'viewer')).toBe(true)
  })

  it('holds a lower role to a higher bar', () => {
    expect(atLeast('viewer', 'translator')).toBe(false)
    expect(atLeast('translator', 'editor')).toBe(false)
    expect(atLeast('editor', 'owner')).toBe(false)
  })

  it('counts a role as reaching its own bar', () => {
    expect(atLeast('viewer', 'viewer')).toBe(true)
    expect(atLeast('owner', 'owner')).toBe(true)
  })

  it('reads no role as a no, not as the lowest one', () => {
    expect(atLeast(null, 'viewer')).toBe(false)
    expect(atLeast(undefined, 'viewer')).toBe(false)
  })
})
