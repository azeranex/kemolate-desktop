import { describe, expect, it } from 'vitest'

import type { Measured, RoomVerdict } from '~/utils/ocr/rooms'

import { sharedRooms } from '~/utils/ocr/rooms'

/** Several lines in one balloon, found at measuring time — desktop. */

const bubble = (cx: number, cy: number): Measured => ({ kind: 'bubble', cx, cy, w: 0.05, h: 0.15 })
const roomed = (cx: number, cy: number, w: number, h: number): RoomVerdict => ({ room: { cx, cy, w, h }, reason: 'room' })

describe('blocks sharing one balloon', () => {
  it('groups blocks whose rooms overlap, and leaves a balloon of one alone', () => {
    const blocks = [bubble(0.73, 0.49), bubble(0.67, 0.56), bubble(0.31, 0.57)]
    const verdicts = [roomed(0.735, 0.490, 0.072, 0.165), roomed(0.675, 0.555, 0.075, 0.219), roomed(0.311, 0.568, 0.103, 0.209)]

    expect([...sharedRooms(blocks, verdicts, [0, 1, 2]).values()]).toEqual([[0, 1]])
  })

  it('groups blocks declined together for sharing one fence', () => {
    const blocks = [bubble(0.2, 0.2), bubble(0.15, 0.25)]
    const verdicts: RoomVerdict[] = [{ room: null, reason: 'shared' }, { room: null, reason: 'shared' }]

    expect([...sharedRooms(blocks, verdicts, [3, 3]).values()]).toEqual([[0, 1]])
  })

  it('does not group a sound effect, or blocks in two fences declined apart', () => {
    const sfx = { ...bubble(0.70, 0.5), kind: 'sfx' }
    const blocks = [bubble(0.73, 0.49), sfx, bubble(0.2, 0.2), bubble(0.15, 0.25)]
    const verdicts: RoomVerdict[] = [
      roomed(0.735, 0.490, 0.072, 0.165),
      roomed(0.72, 0.5, 0.08, 0.2),
      { room: null, reason: 'shared' },
      { room: null, reason: 'shared' },
    ]

    expect(sharedRooms(blocks, verdicts, [0, -1, 1, 2]).size).toBe(0)
  })
})
