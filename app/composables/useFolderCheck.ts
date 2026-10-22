/**
 * Desktop: a word before a folder that looks like more than a chapter is opened.
 *
 * Opening a folder reads everything under it, however deep, into one chapter —
 * which is right for a folder of pages and wrong for a Downloads folder, or for
 * a shelf of volumes, whose PDFs would be run together as one book. Both are
 * easy to pick by mistake from the same dialog, and the first a reader hears of
 * it is a long wait and a chapter of the wrong things. So between listing the
 * folder and reading it, a folder past either mark is asked about.
 *
 * Asked by `useLibrary.openFolder`, answered by `FolderCheck.vue`, mounted once
 * at the root as `PdfPassword` is, for the same reason: the question belongs to
 * the folder being read, not to whichever button chose it.
 */

/** What a folder holds, counted before anything in it is read. */
export interface FolderTally {
  name: string | null
  /** Images and PDFs, everything that would become pages or books of them. */
  files: number
  pdfs: number
}

/** More files than any one chapter has — a volume is a couple of hundred pages. */
const MANY_FILES = 300

/** More than one book: opened together, they are one chapter, in name order. */
const FEW_PDFS = 2

const asked = shallowRef<(FolderTally & { answer: (yes: boolean) => void }) | null>(null)

export function useFolderCheck () {
  /** Whether this folder is worth a question at all. */
  const worthAsking = (tally: FolderTally) => tally.files > MANY_FILES || tally.pdfs >= FEW_PDFS

  /**
   * Yes to open it, no to leave it. A folder below both marks is a yes without
   * asking; one asked about while another question is still up answers that one
   * no first, so neither waits for ever.
   */
  function ask (tally: FolderTally): Promise<boolean> {
    if (!worthAsking(tally)) return Promise.resolve(true)

    asked.value?.answer(false)

    return new Promise((resolve) => {
      const question = {
        ...tally,
        answer: (yes: boolean) => {
          if (asked.value === question) asked.value = null
          resolve(yes)
        },
      }

      asked.value = question
    })
  }

  return { asked: readonly(asked), ask }
}
