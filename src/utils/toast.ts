/**
 * Toasts, with the ones that carry bad news given long enough to be read — and
 * the ones that carry a way out given as long as it takes.
 *
 * Sonner's own default is a few seconds for everything, which is right for
 * "3 pages arrived" and wrong for every error in this app. What goes wrong
 * here goes wrong while somebody is looking somewhere else — a folder being
 * copied in, a book being read in the background, a page failing to fetch from
 * a peer — and a sentence explaining why, shown for four seconds beside the
 * canvas they were working on, is a sentence nobody reads. Worse, half of them
 * carry the way out with them: "Reopen folder", "Reload". An action button
 * that removes itself before it can be pressed is not an offer.
 *
 * Every one of them used to stay until dismissed, for exactly that reason, and
 * that stopped being true the day the bell arrived: a toast is no longer the
 * only copy of what was said, so a toast going away no longer loses it. What it
 * costs to keep them is not nothing, either. Errors accumulate over a session —
 * they are the ones nobody clicks — and sonner fans its whole stack out when the
 * pointer crosses it, so an afternoon of them unfurls up the side of the screen
 * on the way past, over the canvas, in a corner people move through rather than
 * look at.
 *
 * So bad news lingers — four times the default, long enough to look up and read
 * twice — and then leaves, because the bell has it. What still waits without a
 * timer is a toast with something to press: an offer has to be there when the
 * hand arrives, and the bell cannot hold an offer, only the sentence that came
 * with it.
 *
 * This is a drop-in for `vue-sonner`'s own export, and the only one anything in
 * the app should use — it is auto-imported, so calling `toast.error(…)` needs
 * no import at all. A call that wants something else can still say so:
 * `toast.error('…', { duration: Infinity })` overrides any of this.
 *
 * Everything raised through here is also filed in the bell in the header, on
 * its way past — see `useNotifications`, which is where the reasoning for that
 * lives. Nothing at a call site changes: the toast is still the event, and the
 * bell is only the app remembering it said something.
 */
import { toast as sonner } from 'vue-sonner'

import type { ExternalToast } from 'vue-sonner'

/** Whatever sonner takes as the body of a toast — a string, or a component. */
type Message = Parameters<typeof sonner.error>[0]

/**
 * How long a failure stands there with nothing to press. Four times what
 * anything else gets, which is the difference between noticing a toast and
 * reading one, and still short enough that a bad run does not leave a wall.
 */
const LINGER = 20_000

/** Sonner reads `Infinity` as "no timer at all" rather than a very long one. */
function lasting (options?: ExternalToast): ExternalToast {
  return { duration: options?.action ? Infinity : LINGER, ...options }
}

/**
 * Show it, and keep it.
 *
 * Only toasts made of text are kept. A body or a description passed as a
 * component is something sonner draws into the toast it belongs to, and the
 * bell has nowhere to draw it a second time — a line reading `[object Object]`
 * is worse than no line at all. The toast itself is unaffected either way.
 *
 * Sonner's id travels with it, which is what lets the two be dismissed as one
 * thing and what makes a toast raised again under the same id amend its line
 * rather than pile up beside it.
 */
function raise (level: NotificationLevel, message: Message, options?: ExternalToast) {
  const id = level === 'default' ? sonner(message, options) : sonner[level](message, options)

  if (typeof message === 'string') {
    useNotifications().notify({
      toast: id,
      level,
      title: message,
      description: typeof options?.description === 'string' ? options.description : undefined,
    })
  }

  return id
}

export const toast = Object.assign(
  // The bare `toast(…)` call, kept callable and kept plain: an untyped message
  // with no level is not news about a failure, so it times out as it always did.
  ((message: Message, options?: ExternalToast) => raise('default', message, options)) as typeof sonner,
  sonner,
  {
    success: (message: Message, options?: ExternalToast) => raise('success', message, options),
    info: (message: Message, options?: ExternalToast) => raise('info', message, options),
    error: (message: Message, options?: ExternalToast) => raise('error', message, lasting(options)),
    warning: (message: Message, options?: ExternalToast) => raise('warning', message, lasting(options)),
    // Sonner's own alias for the bare call — the same toast by another name, so
    // it takes the same path rather than a second one that could drift from it.
    message: (message: Message, options?: ExternalToast) => raise('default', message, options),
  },
)

// `promise` and `loading` are deliberately left as sonner's own. Both are a job
// in progress rather than news about one — the sentence changes under you and
// the last version of it is the only one worth keeping, which is what the
// success or error call at the end of the job is for.
