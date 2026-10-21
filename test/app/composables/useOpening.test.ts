import { beforeEach, describe, expect, it } from 'vitest'

import { useOpening } from '~/composables/useOpening'

/**
 * What the status bar says while a chapter opens.
 *
 * The rule worth pinning is the order. Opening is a chain — a page's cleaning
 * cannot be looked up before the page is identified — so when two stages are
 * running the bar has to name the earlier one, which is what everything after
 * it is waiting on. Naming the later one would say "restoring cleaning" over a
 * page that has not been hashed yet, which is the same misleading answer this
 * whole indicator exists to replace.
 */
describe('useOpening', () => {
  beforeEach(() => {
    const { stages } = useOpening()

    stages.value = {}
  })

  it('says nothing once every stage has ended', () => {
    const { begin, end, current } = useOpening()

    begin('cleaning', 3)
    end('cleaning')

    expect(current.value).toBeNull()
  })

  it('names the earliest stage still running', () => {
    const { begin, end, current } = useOpening()

    begin('opening')
    begin('cleaning', 10)
    begin('identify', 4)

    expect(current.value?.stage).toBe('identify')

    end('identify')

    expect(current.value?.stage).toBe('cleaning')
  })

  it('counts a stage up to its total', () => {
    const { begin, step, current } = useOpening()

    begin('cleaning', 3)
    step('cleaning')
    step('cleaning')

    expect(current.value).toMatchObject({ stage: 'cleaning', done: 2, total: 3 })
  })

  it('ignores a step for a stage that has already ended', () => {
    // A read that lands after its run gave up must not bring the line back.
    const { begin, step, end, current } = useOpening()

    begin('cleaning', 3)
    end('cleaning')
    step('cleaning')

    expect(current.value).toBeNull()
  })
})
