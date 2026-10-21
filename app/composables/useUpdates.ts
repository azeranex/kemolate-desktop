/**
 * The app's own update, as the window sees it — desktop only; the main process
 * does the work (`electron/updates.ts`).
 *
 * One state for the app, heard from the main process as it moves, and one
 * toast when a release has come down: "Restart to update". Never a restart
 * nobody asked for — a toast dismissed leaves the update to install on the next
 * quit, and Settings › Updates says so and offers the restart again.
 */
import type { UpdateState } from '../../electron/preload'

let listening = false

export function useUpdates () {
  const bridge = typeof window === 'undefined' ? undefined : window.kemolate?.updates
  const state = useState<UpdateState | null>('app-update', () => null)

  /** Start hearing the main process — once, from `App.vue`. */
  function listen () {
    if (!bridge || listening) return

    listening = true

    bridge.state().then((now) => { state.value = now }).catch(() => {})

    bridge.onChanged((now) => {
      const was = state.value?.status

      state.value = now

      if (now.status === 'ready' && was !== 'ready') {
        toast.success(`Kemolate ${now.next} is ready`, {
          id: 'app-update',
          duration: Infinity,
          description: 'Restart to update now, or it installs the next time you quit.',
          action: { label: 'Restart', onClick: () => { bridge.install() } },
        })
      }
    })
  }

  async function check () {
    if (bridge) state.value = await bridge.check().catch(() => state.value)
  }

  const install = () => bridge?.install()

  return { state, listen, check, install, available: Boolean(bridge) }
}
