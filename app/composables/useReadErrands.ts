/**
 * Reading a page because somebody else asked — the browser half of
 * `request_page_read`.
 *
 * ## Why an agent should not be doing the detecting
 *
 * It can. `get_page_image` will hand a vision model the scan and it will come
 * back with boxes and text, and that was the first shape of this. What it costs
 * is worth writing down, because the answer looks fine until you letter it: a
 * model eyeballing a downscaled page estimates boxes that trace the *columns of
 * source text*, so an English line set into one comes out running vertically
 * down a strip five characters wide. It also spends a page image on every page
 * to arrive at a worse answer than the detector already on the machine.
 *
 * This browser has a comic detector and a recogniser, tuned for exactly this,
 * running locally on the file it already holds. Nothing crosses the wire but
 * the request and a one-line report. So the division of labour that actually
 * makes sense is: **the pipeline finds and reads the lettering, the agent
 * translates it** — and the agent looks at the picture only when it wants to,
 * for tone, or to settle a character the recogniser was unsure of.
 *
 * ## Nothing here is conditional on anyone still waiting
 *
 * `run` writes its blocks through the ordinary endpoint, exactly as pressing
 * Read page does. So a first reading that spends two minutes downloading a
 * model is not wasted when the asker's HTTP request has long since given up:
 * the blocks land, and the next `read_page` finds them. The report at the end
 * is a courtesy, not the delivery.
 *
 * Called once, from the workspace page, beside `useLiveSync`. It has to be
 * somewhere with a Nuxt context and the open chapter to hand, which is the
 * whole reason the socket hands the errand on rather than doing it — see
 * `onSwarmErrand`.
 */
export function useReadErrands () {
  const { readScans, running, error } = useOcr()

  // The workspace open here, taken once: the workspace page is made again for
  // every address, so this composable only ever belongs to one.
  const open = String(useRoute().params.workspaceId ?? '')

  onSwarmErrand(async (workspace, errand) => {
    /**
     * Tell the server how it went, best effort.
     *
     * A report that cannot be delivered costs the asker its timeout and costs
     * this browser nothing — the reading is already saved. Not worth a line in
     * a translator's console.
     */
    const report = (body: { ok: boolean, read?: number, blocks?: number, error?: string }) =>
      $fetch(`/api/workspaces/${workspace}/reading/${errand.request}`, {
        method: 'POST',
        body,
        headers: peerHeader(workspace),
      }).catch(() => {})

    // Only for the chapter open here. This tab can be in another workspace's
    // room as a holder of its files, and `readScans` finds pages by hash in
    // whatever chapter is open — so two workspaces made from the same scans
    // would have one's reading written over the other's blocks, translations
    // and all, and reported as done for the one that asked.
    if (workspace !== open) {
      await report({ ok: false, error: 'This browser has another chapter open.' })

      return
    }

    // One reading at a time is `useOcr`'s rule and a good one — two would fight
    // over the same models and the same processor for no gain. Said back
    // immediately rather than queued, because the asker can retry and a queue
    // here would be a second scheduler nobody can see.
    if (running.value) {
      await report({ ok: false, error: 'This browser is already reading. Try again in a moment.' })

      return
    }

    const found = await readScans(errand.hashes)

    if (found === null) {
      await report({
        ok: false,
        // Both causes read the same to the asker and neither is this tab's
        // fault: the chapter open here may simply not be that one.
        error: error.value ?? 'This browser is not holding those pages.',
      })

      return
    }

    // Read, but not saved: `persist` says so in `error` and lets the run go on,
    // which is right for a person watching the page and wrong to report as
    // done — the asker reads the reading back through the API, and would find
    // the old one or none, then translate blocks that are not there.
    if (error.value) {
      await report({ ok: false, read: found.read, blocks: found.blocks, error: error.value })

      return
    }

    await report({ ok: true, read: found.read, blocks: found.blocks })
  })
}
