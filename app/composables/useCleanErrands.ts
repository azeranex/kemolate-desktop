/**
 * Cleaning blocks an agent changed — the window half of `server/utils/cleaning.ts`.
 * Desktop.
 *
 * `join_blocks` and `split_block` make blocks no repair covers; this cleans
 * them with the window's own `cleanBlock`, one at a time, as a press of Clean on
 * a block would — the cache first, the model only for a box it has not seen.
 *
 * The change notice that announced the blocks and this request leave the
 * server together, and the page is re-read a moment after the notice
 * (`useLiveSync` settles), so the blocks asked about may not be here yet: they
 * are waited for, briefly. So is a cleaning already running, which `cleanBlock`
 * would otherwise skip without a word.
 *
 * Only for the chapter open here, as the other errands. Called once, from the
 * workspace page.
 */
// By hand, so a dev server already running picks up the new exports.
import { onCleanErrand } from '~/composables/useSwarm'
import { rowOf } from '~/utils/ocr/blocks'

/** How long to wait for the blocks to arrive, and for a running cleaning to finish. */
const ARRIVAL = 15_000
const BUSY = 90_000
const POLL = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function useCleanErrands () {
  const { pages } = useComic()
  const { cleanBlock, patchFor, repairs, running, skipped } = useClean()

  const open = String(useRoute().params.workspaceId ?? '')

  /** The page's blocks with these rows, once every one of them is here — or null on giving up. */
  async function arrived (hash: string, rows: number[]) {
    for (const until = Date.now() + ARRIVAL; Date.now() < until; await sleep(POLL)) {
      const page = pages.value.find((candidate) => candidate.scan?.hash === hash)
      const found = rows.map((row) => page?.blocks.find((block) => rowOf(block) === row))

      if (page && found.every(Boolean)) return { page, blocks: found as Block[] }
    }

    return null
  }

  onCleanErrand(async (workspace, errand) => {
    const report = (body: Record<string, unknown>) =>
      $fetch(`/api/workspaces/${workspace}/clean/${errand.request}`, { method: 'POST', body }).catch(() => {})

    if (workspace !== open) {
      await report({ ok: false, error: 'Kemolate has another chapter open.' })

      return
    }

    if (!repairs.value) {
      await report({ ok: false, error: 'No cleaner is chosen in Kemolate (Detect panel › Cleaner).' })

      return
    }

    const found = await arrived(errand.hash, errand.blockIds)

    if (!found) {
      await report({ ok: false, error: 'Kemolate did not see the new blocks on the page in time.' })

      return
    }

    const cleaned: number[] = []
    const left: { blockId: number, why: string }[] = []

    try {
      for (const block of found.blocks) {
        for (const until = Date.now() + BUSY; running.value && Date.now() < until;) await sleep(POLL)

        if (block.type === 'garbage' || block.hidden) {
          left.push({ blockId: rowOf(block)!, why: 'Marked rubbish or hidden — not cleaned, as on a press of Clean.' })

          continue
        }

        await cleanBlock(found.page, block)

        const why = skipped.value.find((item) => item.pageId === found.page.id && item.blockId === block.id)?.why

        if (patchFor(found.page, block)) cleaned.push(rowOf(block)!)
        else left.push({ blockId: rowOf(block)!, why: why ?? 'The cleaner left it as it was.' })
      }

      await report({ ok: true, cleaned, skipped: left })
    } catch (error) {
      await report({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
