/**
 * Asking somebody for a PDF's password, from code that has no business
 * knowing there is a screen.
 *
 * The reader is several layers down — a generator, inside a worker, inside a
 * folder walk — and it is the only thing that can know a password is wanted,
 * because that is where the file's own bytes say so. It cannot put up a
 * dialog. So it asks *here*, and what it gets back is a promise; the dialog
 * lives in `PdfPassword.vue`, watches this, and is what eventually settles it.
 *
 * Module level rather than a composable, deliberately. `images.ts` is a plain
 * util and reaches this the way it reaches any other, and the single pending
 * request is genuinely global — two books wanting passwords at once would be
 * two dialogs fighting over one screen, and the reader takes books one at a
 * time precisely so that cannot happen.
 *
 * Nothing typed here is kept. The password goes to the reader, opens the file,
 * and is dropped with the rest of the attempt; it is never written to storage,
 * never sent anywhere, and never put in a page's name.
 */

export interface PasswordRequest {
  /** The book being opened, so the dialog can say which. */
  name: string
  /** Whether the last attempt was refused — the difference between a first
   * ask and "that wasn't it". */
  again: boolean
  /** Answer the request. `null` gives up on this book. */
  answer: (password: string | null) => void
}

/**
 * The request on screen, if there is one. Read by the dialog and by nothing
 * else; written only by the two functions below.
 */
export const passwordWanted = shallowRef<PasswordRequest | null>(null)

/**
 * Ask for a password, and wait however long it takes.
 *
 * No timeout on purpose. The person may be going to find the password, and a
 * dialog that gave up after thirty seconds would be a dialog that wasted the
 * trip.
 */
export function askForPassword (name: string, again: boolean): Promise<string | null> {
  // Whatever was being asked before is answered as a refusal rather than left
  // hanging — its promise is somebody's `await`, and dropping it on the floor
  // would hang the read it belongs to for ever.
  passwordWanted.value?.answer(null)

  return new Promise((resolve) => {
    passwordWanted.value = {
      name,
      again,
      answer: (password) => {
        // Cleared first, so an answer cannot arrive twice — a double-click on
        // Open, or a close that follows a submit.
        passwordWanted.value = null
        resolve(password)
      },
    }
  })
}

/** Give up on whatever is being asked, from outside — a closed dialog. */
export function stopAsking () {
  passwordWanted.value?.answer(null)
}
