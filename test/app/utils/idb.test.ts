import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'

import { unproxied } from '~/utils/idb'

/**
 * What `idb.set` hands IndexedDB: something structured clone will take.
 *
 * The report: the AI ledger had never once been saved. `useAiUsage.persist`
 * wrote `{ entries: entries.value, … }`, whose arrays are Vue proxies, and
 * structured clone throws `DataCloneError` on a proxy — swallowed, because a
 * write that cannot be kept is not worth interrupting anybody over. The record
 * of a page's repairs failed the same way. So the store strips proxies itself.
 *
 * `structuredClone` stands in for the store, because it is exactly the clone
 * `put` runs and it throws the same error on the same values.
 */
describe('unproxied', () => {
  it('makes a record built from reactive state storable', () => {
    const entries = ref([{ pageId: 'p1', tokens: 10 }])
    const carried = ref<Record<string, { tokens: number }>>({ p0: { tokens: 3 } })
    const record = { entries: [...entries.value, { pageId: 'p2', tokens: 4 }], carried: carried.value }

    expect(() => structuredClone(record)).toThrow()

    const kept = structuredClone(unproxied(record))

    expect(kept).toEqual({
      entries: [{ pageId: 'p1', tokens: 10 }, { pageId: 'p2', tokens: 4 }],
      carried: { p0: { tokens: 3 } },
    })
  })

  it('leaves a file exactly as it is, for the record that holds one', () => {
    const file = new File(['bytes'], '001.jpg')
    const record = reactive({ file, name: 'chapter' })

    const bare = unproxied(record) as { file: File, name: string }

    expect(bare.file).toBe(file)
    expect(bare.name).toBe('chapter')
  })

  it('copies nothing that held no proxy', () => {
    const record = { entries: [{ pageId: 'p1' }], carried: {} }

    expect(unproxied(record)).toBe(record)
  })
})
