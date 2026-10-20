/**
 * Pointer quirks the interface has to answer to. Pure: events in, decisions
 * out, nothing reached for and nothing written.
 */

/** Whether this is an Apple keyboard, where Cmd does what Ctrl does elsewhere. */
const APPLE = import.meta.client
  && /mac|iphone|ipad|ipod/i.test(navigator.userAgent)

/**
 * Whether a click means "add this to the selection" rather than "select only
 * this" — Cmd on a Mac, Ctrl everywhere else.
 *
 * Reading Ctrl on a Mac as well sounds harmless and is not. macOS turns
 * Ctrl+click into the secondary click: the browser sends `pointerdown`, then
 * `contextmenu`, and never sends `click` or `pointerup` at all. A handler on
 * `click` therefore never runs — and worse, anything begun on `pointerdown` is
 * left waiting for a release that is not coming, so the next drag has nowhere
 * to start from. The modifier the platform actually uses is the one to ask
 * about, and asking about both is how that bug gets in.
 */
export const addsToSelection = (event: { metaKey: boolean, ctrlKey: boolean }): boolean =>
  (APPLE ? event.metaKey : event.ctrlKey)

/**
 * What a segmented control was set to, or what it was already on.
 *
 * A single-choice toggle group lets go of its value when you press the item
 * that is already pressed — which is right for a filter, where "none of them"
 * is a state, and wrong for a mode, where it is not. Pressing Add while Add is
 * out should leave Add out rather than leave the brush doing nothing.
 */
export function pick<T> (next: unknown, current: T): T {
  return (next as T) || current
}
