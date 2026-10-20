/**
 * Items made one at a time and finished several at once, handed back in the
 * order they were asked for — the shape of an export.
 *
 * An export is two kinds of work with different homes. Drawing a page — the
 * stack walked, the lettering laid out by the browser as HTML — needs the
 * document, so it happens on the main thread, a page at a time (`make`).
 * Encoding the drawn page needs neither and goes to a worker (`finish`). So
 * page N+1 is drawn while page N is being encoded, and the export takes about
 * as long as the drawing does rather than the drawing plus the encoding.
 *
 * What bounds it is memory rather than threads. A drawn page waiting to be
 * finished is a whole bitmap — 78 MB at 3732 × 5197 — so no more than
 * `inFlight` of them are ever handed on and unfinished. The page drawn next
 * waits for a place, and nothing is drawn while it waits: a fast drawer ahead
 * of slow encoders would otherwise fill memory with pages in a queue.
 *
 * Order is kept by index, not by arrival. Pages finish in whatever order their
 * encoders do, and each result is filed where its page is.
 */

export interface PipelineOptions<Made, Done> {
  /** How many made items may be being finished at once; at least one. */
  inFlight: number
  /** Make item `index` — one at a time, in order. Null where there is nothing to make. */
  make: (index: number) => Promise<Made | null>
  /** Finish what `make` made. Up to `inFlight` of these run at once. */
  finish: (made: Made, index: number) => Promise<Done>
  /** Give back something made that will now not be finished. */
  drop?: (made: Made) => void
  /** Asked before each item and after each wait: true to make nothing more. */
  stopped?: () => boolean
  /** Told once, if everything is made and only finishing is left. */
  settling?: () => void
}

/**
 * Every item made and finished — in order, null where there was nothing to
 * make — or null when stopped. A failure, of either half, is thrown once
 * everything already handed on has settled, so nothing is left running behind
 * the error or holding what it was given.
 */
export async function pipeline<Made, Done> (count: number, options: PipelineOptions<Made, Done>): Promise<(Done | null)[] | null> {
  const { make, finish, drop, stopped = () => false, settling } = options
  const places = Math.max(1, options.inFlight)
  const done: (Done | null)[] = Array.from({ length: count }, () => null)
  const running = new Set<Promise<void>>()

  let failed: { error: unknown } | null = null

  for (let index = 0; index < count && !failed && !stopped(); index++) {
    let made: Made | null

    try {
      made = await make(index)
    } catch (error) {
      failed = { error }

      break
    }

    if (made === null) continue

    // A place frees up however a task ends, a failure included, so this wait
    // always ends; what it ended on is asked straight after.
    while (running.size >= places) await Promise.race(running)

    if (failed || stopped()) {
      drop?.(made)

      break
    }

    const task: Promise<void> = finish(made, index)
      .then((result) => { done[index] = result }, (error: unknown) => { failed ??= { error } })
      .finally(() => { running.delete(task) })

    running.add(task)
  }

  if (running.size) settling?.()

  await Promise.all(running)

  if (failed) throw failed.error

  return stopped() ? null : done
}
