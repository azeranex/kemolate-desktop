/**
 * The color scheme: the choice the user made, and what it currently resolves to.
 *
 * Migrated from the web build, where the choice lived in a cookie so the server
 * could render with it. Here it is local storage: read synchronously, so the
 * watcher below puts the `dark` class on `<html>` during the app's own setup,
 * before the first paint — what the web build needed an inline script in
 * nuxt.config for. `useLocalStorage` also follows writes from other windows.
 *
 * The window's native surfaces follow it too (`window.kemolate.theme`): the
 * frame, the scrollbars Chromium draws and the background shown before the page
 * has painted are Electron's, and would otherwise keep to the system's choice.
 *
 * Style against `.dark` rather than branching on `resolved` in a template — the
 * class is the one thing every surface reads the same way.
 */
export type ColorScheme = 'system' | 'light' | 'dark'

export function useColorScheme () {
  const preference = useLocalStorage<ColorScheme>('color-scheme', 'system')

  const prefersDark = usePreferredDark()
  const motion = usePreferredReducedMotion()

  /** What a scheme looks like on this machine right now. */
  function resolve (scheme: ColorScheme) {
    if (scheme !== 'system') return scheme

    return prefersDark.value ? 'dark' : 'light'
  }

  const resolved = computed(() => resolve(preference.value))

  // Synchronous on purpose: a View Transition only captures the DOM its own
  // callback touched, and a queued watcher would run after that window has
  // already closed — the wipe would then reveal the theme it started from.
  watch(resolved, (scheme) => {
    const root = document.documentElement

    root.classList.toggle('dark', scheme === 'dark')
    // Native surfaces — scrollbars, form controls, the overscroll gutter —
    // read this rather than our classes.
    root.style.colorScheme = scheme
  }, { immediate: true, flush: 'sync' })

  // And Electron's own, which read neither: the choice itself, `system`
  // included, so the frame keeps following the OS where that was asked for.
  watch(preference, (scheme) => window.kemolate?.theme.set(scheme), { immediate: true })

  /**
   * Switch schemes. Given a point to start from, the new theme arrives as a
   * circle opening out of it across the whole document rather than as a cut:
   * the old and new views are two layers of one View Transition, so the page
   * is never caught half-repainted, and no colour has to cross-fade through
   * the muddy middle between the two palettes.
   *
   * Everything about that is optional — an unsupported browser, someone who
   * asked for less motion, or a switch that lands on the same rendered theme
   * (System → Dark at night) just takes the plain assignment.
   */
  async function set (scheme: ColorScheme, origin?: { x: number, y: number }) {
    const wipe = origin
      && motion.value !== 'reduce'
      && resolve(scheme) !== resolved.value
      && typeof document.startViewTransition === 'function'

    if (!wipe) {
      preference.value = scheme

      return
    }

    const { x, y } = origin
    const transition = document.startViewTransition(() => {
      preference.value = scheme
    })

    try {
      await transition.ready
    } catch {
      // Skipped — another switch overtook this one, and owns the animation now.
      return
    }

    // Out to the furthest corner, so the circle finishes off-screen instead of
    // stopping short and showing its own edge.
    const reach = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    )

    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${reach}px at ${x}px ${y}px)`,
        ],
      },
      {
        duration: 620,
        easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    )
  }

  return { preference, resolved, set }
}
