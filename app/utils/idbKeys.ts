/**
 * Every name this app files a record under in IndexedDB, in one place.
 *
 * They were written out where each was used — thirty-odd template strings in
 * fourteen files — and the list of which of them belong to a workspace, which
 * deleting one sweeps, was a second copy kept by hand in `useWorkspaces`. It
 * drifted twice: `blocks:` and `usage:` were once missing from it, and so was
 * `repairs-shown:` when the repair record arrived, so a deleted workspace left
 * those behind with nothing that would ever read them.
 *
 * The strings themselves must never change: a record is found by its name, and
 * a builder that spelled one differently would orphan every record written
 * before it. `test/nuxt/utils/idbKeys.test.ts` pins each of them for that reason.
 *
 * Two kinds, and the difference matters to deleting. *Workspace-owned* records
 * are named after the workspace and go with it — `WORKSPACE_OWNED`. The rest
 * are named after content — the hash memo, a page's retouching, the measured
 * lettering sizes — and are shared by every workspace that holds the same
 * picture, so nothing workspace-shaped may delete them.
 */
export const idbKey = {
  /** Which chapter is open here and how it is kept — see `useLibrary`. */
  workspace: (workspace: string) => `workspace:${workspace}`,
  /** The reader's own page order and names. */
  pages: (workspace: string) => `workspace:${workspace}:pages`,
  /** The language the chapter is being translated into, in this browser. */
  target: (workspace: string) => `workspace:${workspace}:target`,
  /** Which way the chapter reads, in this browser. */
  direction: (workspace: string) => `workspace:${workspace}:direction`,
  /** The chapter's standard lettering size, in this browser — see `useLetteringStandard`. */
  lettering: (workspace: string) => `workspace:${workspace}:lettering`,
  /** The page this browser was last on — see `usePagePosition`. */
  position: (workspace: string) => `workspace:${workspace}:at`,
  /** The AI ledger — see `useAiUsage`. */
  usage: (workspace: string) => `usage:${workspace}`,
  /** A local workspace's reading of one scan — see `useBlockCache`. */
  blocks: (workspace: string, hash: string) => `blocks:${workspace}:${hash}`,
  /** A local workspace's layer stack for one scan — see `useLayerCache`. */
  layers: (workspace: string, hash: string) => `layers:${workspace}:${hash}`,
  /** A local workspace's glossary in one language — see `useGlossary`. */
  glossary: (workspace: string, locale: string) => `glossary:${workspace}:${locale}`,
  /** A local workspace's cast — see `useCast`. */
  cast: (workspace: string) => `cast:${workspace}`,
  /** A page's parked translation history — see `utils/history.ts`. */
  history: (workspace: string, pageId: string) => `history:${workspace}:${pageId}`,
  /** The repairs a page last showed — see `useClean.showKept`. */
  repairsShown: (workspace: string, hash: string) => `repairs-shown:${workspace}:${hash}`,
  /** The scans a workspace keeps page previews of — see `raster/previews.ts`. */
  previews: (workspace: string) => `previews:${workspace}`,
  /** One surface's retouching, by `<scan hash>:<surface>` — see `usePaintCache`. Shared, not owned. */
  paint: (surface: string) => `paint:${surface}`,
}

/** The prefix every record of one kind for one workspace starts with, for `idb.keys`. */
export const idbPrefix = {
  glossaries: (workspace: string) => `glossary:${workspace}:`,
  histories: (workspace: string) => `history:${workspace}:`,
  /** Every surface retouched on one scan. */
  paint: (hash: string) => `paint:${hash}:`,
}

/**
 * What deleting a workspace sweeps: every kind above named after a workspace,
 * as the prefix its keys open with. A kind added above that is named after a
 * workspace is added here as well, and the test checks the two agree.
 */
export const WORKSPACE_OWNED = ['workspace:', 'blocks:', 'usage:', 'history:', 'glossary:', 'cast:', 'layers:', 'repairs-shown:', 'previews:'] as const
