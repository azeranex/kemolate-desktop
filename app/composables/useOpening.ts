/**
 * How far a chapter has got with opening, for the status bar.
 *
 * Why this exists is not speed. A page whose cleaning has not come back yet and
 * a page nobody ever cleaned look exactly alike, and telling them apart used to
 * take a developer: a chapter that "came back without its cleaning" was, in
 * turn, a lookup under the wrong cleaner, repairs filed under a block's old
 * name, and a restore queued behind two and a half thousand thumbnail reads.
 * Each of those looked like the other two from the chair. `WorkspaceOpening`
 * says which of "still coming" and "not there" is true, and this is what it
 * reads.
 *
 * Stages rather than one number, because opening is a chain and each link has
 * its own idea of progress: hashing counts pages, the reading is one request,
 * the cleaning counts balloons. Each reports into its own slot and the bar
 * shows the earliest one still running, which is the one everything after it is
 * waiting on.
 *
 * `opening` is the chain as a whole — see `settle` on the workspace page — and
 * has no count. It is what keeps the bar from saying "not cleaned" in the gap
 * between one stage finishing and the next beginning.
 */
export type OpeningStage = 'identify' | 'reading' | 'cleaning' | 'opening'

export interface OpeningStep {
  done: number
  /** Nought for a stage that is one piece of work rather than a count. */
  total: number
}

/** Earliest first — what the bar shows when more than one is running. */
export const OPENING_ORDER: OpeningStage[] = ['identify', 'reading', 'cleaning', 'opening']

export function useOpening () {
  const stages = useState<Partial<Record<OpeningStage, OpeningStep>>>('opening-stages', () => ({}))

  /** A stage has started, with how much of it there is where that is known. */
  function begin (stage: OpeningStage, total = 0) {
    stages.value = { ...stages.value, [stage]: { done: 0, total } }
  }

  /** One more piece of a counted stage done. Ignored once the stage has ended. */
  function step (stage: OpeningStage) {
    const held = stages.value[stage]

    if (!held) return

    stages.value = { ...stages.value, [stage]: { ...held, done: held.done + 1 } }
  }

  /** The stage is over, however it ended. */
  function end (stage: OpeningStage) {
    if (!stages.value[stage]) return

    const { [stage]: _gone, ...rest } = stages.value

    stages.value = rest
  }

  /** The earliest stage still running, or nothing once the chapter is open. */
  const current = computed(() => {
    const stage = OPENING_ORDER.find((candidate) => stages.value[candidate])

    return stage ? { stage, ...stages.value[stage]! } : null
  })

  return { stages, current, begin, step, end }
}
