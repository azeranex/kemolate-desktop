/**
 * Project files the operating system handed the app — a `.kemolate` double-
 * clicked, dropped on the app's icon, or named on the command line. Desktop
 * only; the main process's half is `electron/opening.ts`.
 *
 * Each goes where the web build sends a project dropped on the workspace list:
 * into a **new** workspace, parked there with `useProjectFile.handOver` and
 * claimed by the workspace page once it has stood up. Never into the workspace
 * on screen — opening a project replaces a chapter, and a double-click in the
 * file manager is not a reader choosing to replace this one.
 *
 * One at a time. The parking holds one file (see `handOver`), so where several
 * arrive together the first is opened and the reader is told about the rest,
 * which can be opened from File › Open project… — better than two navigations
 * racing and one import landing on nothing.
 */

/** The app's own origin, where the main process serves a handed-over file — see `opening.ts`. */
const APP_ORIGIN = 'https://app.kemolate.invalid'

export function useOpenedFiles () {
  const { create } = useWorkspaces()
  const { handOver } = useProjectFile()

  /** Open what is waiting, if anything; says whether something was. */
  async function openWaiting (): Promise<boolean> {
    const bridge = typeof window === 'undefined' ? null : window.kemolate?.files

    if (!bridge) return false

    const list = await bridge.pending().catch(() => [])
    const first = list[0]

    if (!first) return false

    try {
      const response = await fetch(`${APP_ORIGIN}/opened/${encodeURIComponent(first.token)}`)

      if (!response.ok) throw new Error(`The file could not be read (${response.status}).`)

      const file = new File([await response.blob()], first.name, { type: 'application/zip' })
      const id = create()

      handOver(id, file)
      await navigateTo(`/w/${id}`)
    } catch (error) {
      toast.error(`“${first.name}” could not be opened`, {
        description: error instanceof Error ? error.message : String(error),
      })

      return false
    }

    if (list.length > 1) {
      toast.info(`Opened “${first.name}”`, {
        description: `${list.length - 1} more ${list.length === 2 ? 'was' : 'were'} handed over at the same time — open ${list.length === 2 ? 'it' : 'them'} with File › Open project….`,
      })
    }

    return true
  }

  /** Open each file the OS hands over from now on. Returns the unsubscribe. */
  function listen (): () => void {
    return window.kemolate?.files.onOpened(() => { openWaiting() }) ?? (() => {})
  }

  return { openWaiting, listen }
}
