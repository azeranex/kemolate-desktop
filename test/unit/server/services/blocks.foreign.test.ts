import { beforeEach, describe, expect, it } from 'vitest'

import { aWorkspace, reset } from '../harness'

import { client, db, repairs as repairRows } from '~~/server/database'
import { compound, release, remove, replace, update } from '~~/server/services/blocks'
import { ensurePlate } from '~~/server/services/layers'
import { sync as syncPages } from '~~/server/services/pages'
import { surfaceFor } from '~~/server/services/paint'
import { keep, withdraw } from '~~/server/services/repairs'
import { chooseRevision, putOnPage, revisions, setStatus, unpin } from '~~/server/services/translations'

/**
 * A block id from another workspace is refused, at every door that takes one.
 *
 * **Needs the database harness.**
 *
 * An ability only ever looks at the context, and a block id is just a number.
 * So every service handed one has to prove the block is this workspace's
 * before it touches it — `blockIn` in the block service, `blocksIn` in the
 * translation one, and a line of its own in repairs and paint — or edit rights
 * on your own chapter are edit rights on anybody's. That was a hole more than
 * once: `translations.put` took its page inside the body and could check only
 * the ability, and `layers.ensurePlate` took a page on trust.
 *
 * Each case below is an editor of one workspace naming a block that lives in
 * another, where they are nobody. Each is held to two things: the refusal is
 * the 404 a block that does not exist gets — a row you may not touch should
 * not be confirmed to exist by the way it refuses you — and **nothing in the
 * database changed**, which is checked against every row of every table
 * rather than the one the door was expected to write.
 *
 * `blocks.updateOnPage`, which is new and is being written as this is, is
 * pinned beside `update` in `blocks.test.ts`.
 */

const DRAFT = { cx: 0.5, cy: 0.5, w: 0.2, h: 0.1, source: '見て' }

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])
const RECT = { x: 1, y: 2, w: 3, h: 4 }

/** Every row of every table, whole. What a refusal must leave exactly as it found. */
function everything () {
  const tables = client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((row) => row.name as string)

  return Object.fromEntries(tables.map((table) => [table, client.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]))
}

/**
 * Two chapters and two people, each an editor in their own and a stranger in
 * the other's.
 *
 * Theirs holds a loose block with a translation, a balloon made of two more,
 * and a repair on the loose one — something behind every door. Mine holds two
 * blocks and a founded stack, so a door that needs a page or a layer of the
 * caller's own gets one, and the only foreign thing in the request is the
 * block.
 */
async function strangers () {
  const mine = await aWorkspace()
  const theirs = await aWorkspace()

  const [myPage] = await syncPages(mine, [{ path: '01.png', name: '01', position: 0, hash: 'sha-mine' }])
  const [theirPage] = await syncPages(theirs, [{ path: '01.png', name: '01', position: 0, hash: 'sha-theirs' }])

  const [myBlock, mySecond] = await replace(mine, myPage!.id, [DRAFT, DRAFT])
  const [theirBlock, left, right] = await replace(theirs, theirPage!.id, [DRAFT, DRAFT, DRAFT])
  const balloon = await compound(theirs, theirPage!.id, [left!.id, right!.id], DRAFT)

  await putOnPage(theirs, theirPage!.id, 'en', [{ blockId: theirBlock!.id, text: 'Theirs' }])

  const { revisions: [theirRevision] } = await revisions(theirs, theirBlock!.id, 'en')

  await db.insert(repairRows).values({ pageId: theirPage!.id, blockId: theirBlock!.id, key: 'k-theirs', hash: 'c3'.repeat(32), from: RECT, box: RECT })

  const myLayer = await ensurePlate(mine, 'clean', myPage!.id)

  return {
    mine,
    myPage: myPage!,
    myBlock: myBlock!,
    mySecond: mySecond!,
    myLayer,
    theirPage: theirPage!,
    theirBlock: theirBlock!,
    theirBalloon: balloon,
    theirRevision: theirRevision!,
  }
}

/** Refused with the stranger's 404, in these words, and nothing anywhere written. */
async function refused (attempt: () => Promise<unknown>, message: string) {
  const before = everything()

  await expect(attempt()).rejects.toMatchObject({ statusCode: 404, message })

  expect(everything()).toEqual(before)
}

beforeEach(reset)

describe('the block service', () => {
  it('will not move or retype a stranger\'s block', async () => {
    const { mine, theirBlock } = await strangers()

    await refused(() => update(mine, theirBlock.id, { source: 'mine now', cx: 0.1 }), 'No such block.')
  })

  it('will not delete one', async () => {
    const { mine, theirBlock } = await strangers()

    await refused(() => remove(mine, theirBlock.id), 'No such block.')
  })

  it('will not take a stranger\'s balloon apart', async () => {
    const { mine, theirBalloon } = await strangers()

    await refused(() => release(mine, theirBalloon.id), 'No such block.')
  })

  it('will not join a stranger\'s block into a balloon on the caller\'s page', async () => {
    const { mine, myPage, myBlock, theirBlock } = await strangers()

    await refused(() => compound(mine, myPage.id, [myBlock.id, theirBlock.id], DRAFT), 'Those blocks are not all on that page.')
  })

  it('will not join blocks on a stranger\'s page', async () => {
    const { mine, theirPage, theirBlock, theirBalloon } = await strangers()

    await refused(() => compound(mine, theirPage.id, [theirBlock.id, theirBalloon.id], DRAFT), 'No such page.')
  })
})

describe('the translation service', () => {
  it('will not write words onto a stranger\'s block filed under the caller\'s page', async () => {
    const { mine, myPage, theirBlock } = await strangers()

    await refused(() => putOnPage(mine, myPage.id, 'en', [{ blockId: theirBlock.id, text: 'Mine' }]), 'No such block.')
  })

  /**
   * The whole request, not just the foreign line: a page that half-saved would
   * be a page where some balloons say the new thing, and the caller was told
   * nothing went.
   */
  it('refuses the whole page when one line of it is a stranger\'s', async () => {
    const { mine, myPage, myBlock, theirBlock } = await strangers()

    await refused(() => putOnPage(mine, myPage.id, 'en', [
      { blockId: myBlock.id, text: 'Mine' },
      { blockId: theirBlock.id, text: 'Also mine' },
    ]), 'No such block.')
  })

  it('will not write onto a stranger\'s page by naming it', async () => {
    const { mine, theirPage, theirBlock } = await strangers()

    await refused(() => putOnPage(mine, theirPage.id, 'en', [{ blockId: theirBlock.id, text: 'Mine' }]), 'No such block.')
  })

  it('will not read out a stranger\'s history', async () => {
    const { mine, theirBlock } = await strangers()

    await refused(() => revisions(mine, theirBlock.id, 'en'), 'No such block.')
  })

  it('will not put an old wording back on a stranger\'s line', async () => {
    const { mine, theirBlock, theirRevision } = await strangers()

    await refused(() => chooseRevision(mine, theirBlock.id, 'en', theirRevision.id), 'No such block.')
  })

  it('will not un-pin a stranger\'s line', async () => {
    const { mine, theirBlock } = await strangers()

    await refused(() => unpin(mine, [theirBlock.id], 'en'), 'No such block.')
  })

  it('will not move a stranger\'s line along to final', async () => {
    const { mine, theirBlock } = await strangers()

    await refused(() => setStatus(mine, theirBlock.id, 'en', 'final'), 'No such block.')
  })
})

describe('repairs and paint', () => {
  it('will not take back a stranger\'s repair', async () => {
    const { mine, theirBlock } = await strangers()

    await refused(() => withdraw(mine, theirBlock.id), 'No such page.')
  })

  it('will not file a repair on the caller\'s page against a stranger\'s block', async () => {
    const { mine, myPage, theirBlock } = await strangers()

    await refused(() => keep(mine, {
      pageId: myPage.id,
      blockId: theirBlock.id,
      key: '0123456789abcdef-1-2-3-4-aot-m13',
      from: RECT,
      box: RECT,
    }, PNG), 'No such block on that page.')
  })

  it('will not tie a surface on the caller\'s page to a stranger\'s block', async () => {
    const { mine, myPage, myLayer, theirBlock } = await strangers()

    await refused(() => surfaceFor(mine, { pageId: myPage.id, layerId: myLayer.id, key: 'stolen', blockId: theirBlock.id }), 'No such block.')
  })
})

describe('what the refusal is about', () => {
  /** The privacy half of the rule: from outside, theirs and nobody's are one answer. */
  it('answers a stranger\'s block in the same words as a block that was never there', async () => {
    const { mine, theirBlock } = await strangers()
    const nobodys = theirBlock.id + 10_000

    const asked = async (blockId: number) => update(mine, blockId, { source: 'x' }).catch((error: { statusCode: number, message: string }) =>
      ({ statusCode: error.statusCode, message: error.message }))

    expect(await asked(theirBlock.id)).toEqual(await asked(nobodys))
  })

  /** And not about anything else in the request: the same calls pass for the caller's own blocks. */
  it('lets the caller do all of it to their own', async () => {
    const { mine, myPage, myBlock, mySecond } = await strangers()

    await update(mine, myBlock.id, { source: 'mine now' })
    await putOnPage(mine, myPage.id, 'en', [{ blockId: myBlock.id, text: 'Mine' }])
    await setStatus(mine, myBlock.id, 'en', 'final')
    await unpin(mine, [myBlock.id], 'en')

    const balloon = await compound(mine, myPage.id, [myBlock.id, mySecond.id], DRAFT)

    await release(mine, balloon.id)
    await remove(mine, mySecond.id)

    const held = client.prepare('SELECT source FROM blocks WHERE page_id = ? ORDER BY position').all(myPage.id)

    expect(held).toEqual([{ source: 'mine now' }])
    expect((await revisions(mine, myBlock.id, 'en')).revisions.map((row) => row.text)).toEqual(['Mine'])
  })
})
