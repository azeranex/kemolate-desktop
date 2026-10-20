/**
 * The bell: what the app has said, kept after it has stopped saying it, in
 * every window this browser has open.
 *
 * Toasts are this app's whole voice, and they all have the same shape — a
 * sentence about something that happened while you were looking somewhere
 * else. Each one goes away in its own time (see `utils/toast.ts`), and that is
 * exactly where it runs out: it is read once, by whoever was at the keyboard,
 * and then the sentence is gone. "How many pages actually arrived?" and "what
 * did it say was missing from that folder?" have no answer half a minute later.
 *
 * This file is what let those timers exist at all. Bad news used to stand there
 * until somebody dismissed it, because there was nowhere else for it to be.
 *
 * So every toast is filed here on its way to the screen, and the bell in the
 * header is that file. Nothing else adds to it: the toast *is* the event, and a
 * second way in would be a second thing to keep in step with the first.
 *
 * In memory, at module level, and gone on reload. Module scope for the same
 * reason the swarm's rooms are there — what has been said belongs to the
 * session rather than to any page, and opening a chapter replaces the page
 * under it — and it is safe for the same reason: nothing here is ever written
 * on the server, so the refs render empty during SSR and only the client fills
 * them. Not persisted, because a warning about a folder this browser can no
 * longer reach, read back tomorrow, is not news; it is litter.
 *
 * ## Across tabs
 *
 * A window is not the unit any of this is about. This app is routinely two or
 * three tabs of one chapter, and the work moves between them: a fetch announced
 * in one is a fetch that finished for all of them, and a bell that only knows
 * what its own window happened to witness is a record with holes in it — you
 * close the tab that was told, and the telling goes with it.
 *
 * So the file is shared over a `BroadcastChannel`, and a tab opening asks the
 * others for what they already hold. What is *not* shared is the toast: the
 * sentence appears in the window where the thing happened, and shouting it into
 * every other window would be the same news four times. Only the record travels.
 *
 * Clearing a line is the one thing that reaches back across: a toast is torn
 * down by the window it is in, told to by whichever window the line was cleared
 * from. Otherwise clearing the bell in one tab leaves the toasts it stands for
 * — the ones with something to press wait indefinitely — over the canvas in the
 * next.
 */

/** Sonner's kinds under their own names — what a line in the bell is drawn as. */
export type NotificationLevel = 'default' | 'success' | 'info' | 'warning' | 'error'

export interface AppNotification {
  /**
   * `tab:toast` — unique across every window, which the toast's own id is not.
   * Sonner numbers its toasts from one per page, so two windows both a minute
   * old are both holding a toast 3, and a shared list keyed on that alone would
   * take one for an amendment of the other.
   */
  id: string
  /** Which window raised it, and so which one can still take it off a screen. */
  tab: string
  /** Sonner's id, meaningful only in that window. */
  toast: string | number
  level: NotificationLevel
  title: string
  /** The sentence under the title, when the toast had one and it was text. */
  description?: string
  at: number
  read: boolean
}

/**
 * How many are kept.
 *
 * Deep enough to hold everything a busy chapter says in one sitting, shallow
 * enough that the list is never something to be searched — anything older than
 * fifty toasts ago is being looked for in the wrong place.
 */
const LIMIT = 50

/** This window. Short, because it is only ever compared, never read by anyone. */
const TAB = crypto.randomUUID().slice(0, 8)

const items = ref<AppNotification[]>([])

const unread = computed(() => items.value.reduce((n, item) => n + (item.read ? 0 : 1), 0))

/** Everything one tab says to the others. */
type Wire =
  | { kind: 'add', item: AppNotification }
  | { kind: 'dismiss', id: string }
  | { kind: 'read' }
  | { kind: 'clear' }
  /** "I have just opened — does anybody have the list?" */
  | { kind: 'hello' }
  | { kind: 'state', items: AppNotification[] }

let channel: BroadcastChannel | null = null

function speak (message: Wire) {
  channel?.postMessage(message)
}

/* ---------- what happens to the list, wherever the news came from ---------- */

function file (item: AppNotification) {
  const held = items.value.find((entry) => entry.id === item.id)

  // An id already in the list is one toast being changed under you rather than
  // a second thing happening — sonner treats it that way and so does this.
  // Left where it is, because it is still the same event, and unread again,
  // because what it says now has not been seen.
  if (held) {
    Object.assign(held, item)

    return
  }

  items.value.unshift(item)

  if (items.value.length > LIMIT) items.value.length = LIMIT
}

/**
 * Take the toast down with the line, if this is the window it is showing in.
 * Sonner's ids are per-page counters, so anywhere else this is somebody else's
 * toast number, and dismissing it would close whatever happens to hold it here.
 *
 * `toast` is the app's own — this module and that one do import each other,
 * which is a circle only on paper: neither reaches for the other while the
 * modules are being evaluated, and nothing can be dismissed before there is
 * something to dismiss.
 */
function hush (item: AppNotification) {
  if (item.tab === TAB) toast.dismiss(item.toast)
}

function forget (id: string) {
  const held = items.value.find((item) => item.id === id)

  if (held) hush(held)

  items.value = items.value.filter((item) => item.id !== id)
}

function empty () {
  for (const item of items.value) hush(item)

  items.value = []
}

function seen () {
  for (const item of items.value) item.read = true
}

function hear (message: Wire) {
  switch (message.kind) {
    case 'add': file(message.item); break
    case 'dismiss': forget(message.id); break
    case 'read': seen(); break
    case 'clear': empty(); break

    // Somebody has just opened. `toRaw`, because what goes over the channel is
    // structured-cloned, and a reactive proxy is not something the browser will
    // clone.
    case 'hello': speak({ kind: 'state', items: items.value.map((item) => toRaw(item)) }); break

    // Only while there is nothing of our own to lose. Two tabs answer a hello
    // and the second answer arrives after the first has already been taken;
    // later, a tab that has been collecting for an hour must not be emptied by
    // a window that has just opened somewhere and said hello to everybody.
    case 'state': if (!items.value.length) items.value = message.items; break
  }
}

// A channel is opened once, when this module is first pulled in, which on the
// client is as soon as anything can raise a toast. `onmessage` is never the
// sender's own — a BroadcastChannel does not echo — so nothing here has to
// guard against hearing itself.
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel('kemolate:notifications')
  channel.onmessage = (event: MessageEvent<Wire>) => hear(event.data)

  speak({ kind: 'hello' })
}

export function useNotifications () {
  /** What `toast` files as it shows something; see the note at the top. */
  function notify (entry: Pick<AppNotification, 'toast' | 'level' | 'title' | 'description'>) {
    const item: AppNotification = { ...entry, id: `${TAB}:${entry.toast}`, tab: TAB, at: Date.now(), read: false }

    file(item)
    speak({ kind: 'add', item })
  }

  /**
   * Everything has been seen. Called when the bell closes rather than when it
   * opens: marking on the way in clears the highlight out from under the eye
   * that came to read it.
   *
   * Said to the other tabs too. It is one record, so reading it is one act —
   * a badge left standing in the next window would be counting news that has
   * already been read.
   */
  function markRead () {
    seen()
    speak({ kind: 'read' })
  }

  function dismiss (id: string) {
    forget(id)
    speak({ kind: 'dismiss', id })
  }

  function clear () {
    empty()
    speak({ kind: 'clear' })
  }

  return { items, unread, notify, markRead, dismiss, clear }
}
