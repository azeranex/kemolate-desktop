/**
 * Writing a chapter out as one file, and reading one back in.
 *
 * The format and the argument for it are in `utils/project.ts`; this is the
 * gathering and the applying, which is where all the difficulty is. Both halves
 * exist because the work is scattered across three stores that know nothing
 * about each other — the reading and the paint in IndexedDB, the scans and the
 * placed images in OPFS, and, for a workspace somebody has shared, most of the
 * above on the server as well. No one of them is the answer.
 *
 * ## Gathering reads the live page, not the stores
 *
 * `useComic.pages` is the only place the two copies have already been
 * reconciled: `useOcr.restore` fills it from the server where there is one and
 * `useBlockCache.restore` fills what is left from this browser's own cache, in
 * that order and for that reason. So the blocks, the translations, the
 * lettering and the stacks are taken off the page in front of the reader, which
 * is also the honest definition of what an export should contain — what you can
 * see is what you get.
 *
 * Paint is the exception and has to be, because it is the one thing that
 * *leaves* the browser as it is made: a mark is laid locally, `usePaintSync`
 * sends it up in the next batch, and the local copy is forgotten once the
 * server's answer names it. A browser that has been
 * collaborating therefore holds almost none of the retouching it is displaying.
 * So the two logs are read separately and merged on `(clientId, seq)` — the
 * same pair the database's own unique index dedupes on, which is not a
 * coincidence: it is the identity of a mark.
 *
 * ## Applying is deliberately a fresh start
 *
 * An import replaces whatever chapter is open, through the ordinary
 * `useLibrary.opened` path — the same one a dropped folder takes, so the pages
 * are copied, remembered and pushed exactly as they always are. Nothing here
 * reaches into storage to reconstruct a state; it opens a chapter and then says
 * what is on each page.
 *
 * The one thing it must undo on the way in is **names**. A block's id is
 * `block:41` where a server row exists, and those numbers name rows in the
 * workspace this file came *from*. `localise` exists for precisely this failure
 * and its note is worth reading: blocks that arrive still claiming rows leave
 * the new workspace unable to create any, so nothing a reader types is ever
 * saved and every edit comes back `404 No such block`. Strokes get the same
 * treatment for the same reason — see `usePaintCache.seed`.
 */
import type { Project, ProjectGlossary, ProjectPage } from '~/utils/project'
import type { ZipEntry } from '~/utils/zip'

import { localSurface } from '~/composables/useBlockCache'
import { serverGlossaries } from '~/composables/useGlossary'
import { serverStacks } from '~/composables/useLayerSync'
import { download } from '~/utils/download'
import { hashFile } from '~/utils/hash'
import { idbKey } from '~/utils/idbKeys'
import { listPatches, patchScan, readPatch, writePatch } from '~/utils/ocr/patches'
import { localPaint, mergePaint, remotePaint } from '~/utils/paint/gather'
import { keepPlaced, readPlacedMany } from '~/utils/placed'
import {
  IMAGES_DIR,
  MANIFEST,
  PAGES_DIR,
  PATCHES_DIR,
  PROJECT_VERSION,
  projectFilename,
  readManifest,
} from '~/utils/project'
import { safeName, unzip, zip } from '~/utils/zip'

/** And for its history — see `translations.everyRevision`. */
interface RemoteRevisions {
  uid: string
  blocks: { blockId: number, position: number, lines: ProjectLine[] }[]
}

/**
 * The glossary is merged a hundred terms at a time, because that is the bound
 * `glossaryMergeSchema` puts on one request. A chapter of a long series can
 * carry more.
 */
const TERMS_PER_REQUEST = 100

export function useProjectFile () {
  const route = useRoute()

  const { pages, title, epoch, setBlocks } = useComic()
  const { opened } = useLibrary()
  const { shared, syncPages, pageRowOf } = useShared()
  const { target, set: setTarget } = useTargetLanguage()
  const { direction, set: setDirection } = useReadingDirection()
  const { referenced, restore: restorePlaced } = usePlacedImages()
  const { seed } = usePaintCache()
  const { restore: restoreUsage } = useAiUsage()

  /*
   * Reached through its own accessor rather than by calling `useClean`, which
   * calls `useComic` and so registers a watcher — see `useCleanSettings`, and
   * `useWorkspaceReset` for what a duplicated `useComic` watcher costs. Both
   * fields are part of what a repair is *named*, so they travel with the
   * repairs or the repairs arrive unfindable.
   */
  const cleanSettings = useCleanSettings()

  /*
   * Reached through its own accessor rather than by calling `useLayerSync`,
   * which would register a second copy of that composable's watchers — see
   * `useLayerClaims`, and `useWorkspaceReset` for what duplicated watchers do.
   * Taken here, during setup, because `useState` wants a Nuxt instance and
   * `load` runs from a click.
   */
  const layerClaims = useLayerClaims()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** What is happening, while it is. A chapter is not written in a frame. */
  const busy = useState<string | null>('project-busy', () => null)

  /**
   * A project file dropped somewhere that cannot open it, waiting for the
   * workspace that can.
   *
   * The collection page is the case. Dropping a project there has to *make* a
   * workspace and open the file in it, and none of the machinery `load` needs —
   * `useComic`, `useLibrary`, a workspace in the address — exists on that page.
   * So the drop mints an id, parks the file here and navigates, and the
   * workspace page claims it once its own restore has settled.
   *
   * Held in memory rather than written down, which is the right lifetime: this
   * survives a client-side navigation because the document does, and a reload
   * part-way through is somebody who has abandoned the import. A file quietly
   * replayed into a workspace on the next visit would be a chapter arriving
   * from nowhere.
   *
   * **Keyed by the workspace it was meant for**, and that is not decoration. A
   * reader who drops a project and then clicks a different workspace before the
   * navigation lands would otherwise have the import replace *that* chapter —
   * a destructive act aimed at the wrong target, from a gesture that was not
   * about it.
   */
  const arriving = useState<{ workspace: string, file: File } | null>('project-arriving', () => null)

  /** Park a file for a workspace that is about to be opened. */
  function handOver (id: string, file: File) {
    arriving.value = { workspace: id, file }
  }

  /**
   * Take delivery of anything left for this workspace, and say whether there
   * was any.
   *
   * Cleared before the import rather than after, so a failure is not a file
   * that tries again on the next thing that calls this.
   */
  async function claim (): Promise<boolean> {
    const waiting = arriving.value

    if (!waiting || waiting.workspace !== workspace.value) return false

    arriving.value = null

    return load(waiting.file)
  }

  /* ---------- out ---------- */

  /** The chapter's glossaries, one per language it has been carried into. */
  async function gatherGlossaries (): Promise<ProjectGlossary[]> {
    // A local workspace's are all in this browser, one per language.
    if (!shared.value) return localGlossaries(workspace.value)

    // Every language the chapter has a glossary in, where the server will say;
    // the one being worked in otherwise, which is what this carried before.
    const every = await serverGlossaries(workspace.value)

    if (every) return every

    if (!target.value) return []

    const found = await serverGlossary(workspace.value, target.value)

    return found ? [found] : []
  }

  async function gatherCast (): Promise<Project['cast']> {
    const answered = shared.value ? await serverCast(workspace.value) : await localCast(workspace.value)

    return (answered?.members ?? []).map(({ source, names, gender, tags, pinned }) => ({ source, names, gender, tags, pinned }))
  }

  /**
   * Every line's history in the chapter, by page uid and block position.
   *
   * Server-only, like the glossary and for a stronger reason: revisions are a
   * table and a chapter nobody has claimed has never had one. A local export
   * simply carries no history, which is the truth about it rather than a
   * shortfall — there was none to carry.
   */
  async function gatherRevisions (): Promise<Map<number, ProjectLine[]>> {
    const out = new Map<number, ProjectLine[]>()

    if (!shared.value) return out

    const answered = await $fetch<RemoteRevisions[]>(`/api/workspaces/${workspace.value}/revisions`)
      .catch(() => null)

    if (!answered) return out

    // Flattened to one map by row id. The page grouping the server sends is for
    // a reader's benefit rather than this one's — a block row is unique across
    // the chapter, and every block that has one carries it in its own name.
    for (const page of answered) {
      for (const block of page.blocks) out.set(block.blockId, block.lines)
    }

    return out
  }

  /**
   * One page's history, keyed by each block's index in the array being written.
   *
   * The translation between the two ways of naming a block, and the only place
   * it happens. The server answers by row id because that is what both ends
   * hold right now; the file is keyed by index because a row id means nothing
   * in the workspace it will be opened in.
   *
   * Walks the same tree in the same order the blocks are written in, children
   * included — a balloon's members are rows of their own and may have been
   * translated before somebody joined them.
   */
  function revisionsOf (blocks: Block[], held: Map<number, ProjectLine[]>): Record<number, ProjectLine[]> {
    const out: Record<number, ProjectLine[]> = {}

    blocks.forEach((block, index) => {
      const row = rowOf(block)
      const lines = row === null ? undefined : held.get(row)

      if (lines?.length) out[index] = lines
    })

    return out
  }

  /**
   * This browser's AI ledger for the chapter — see `ProjectUsage`.
   *
   * Read straight out of storage rather than through `useAiUsage`, which holds
   * one workspace's rows at a time and would have to be pointed at this one.
   * The record is a whole value under one key; there is nothing to assemble.
   */
  async function gatherUsage (): Promise<ProjectUsage | undefined> {
    const held = await idb.get<ProjectUsage>(idbKey.usage(workspace.value)).catch(() => null)

    return held?.entries?.length || Object.keys(held?.carried ?? {}).length ? held! : undefined
  }

  /**
   * Write the open chapter out, and hand it to the browser to save.
   *
   * The archive is assembled as a list of `Blob` parts rather than as bytes —
   * see the memory note in `utils/zip` — so a three hundred megabyte chapter
   * never exists in the heap. What it does cost is a read of every file, for
   * the checksums the format wants in its headers — once a session for a scan
   * or a placed image, whose sums are remembered by their hashes, so saving the
   * chapter again reads only the repairs and the manifest. Measured on eight
   * 3732 × 5197 scans, 154 MB: a save took 0.97 s with eight long tasks on the
   * page; now the first of a session takes 0.45 s and the next 0.10 s.
   */
  async function save (): Promise<boolean> {
    if (!pages.value.length) {
      toast.warning('There is no chapter open to export.')

      return false
    }

    if (busy.value) return false

    busy.value = 'Gathering…'

    try {
      const painted = await remotePaint(shared.value ? workspace.value : null)
      const remembered = await gatherRevisions()

      // A cloud workspace's stacks as the server keeps them. Only the pages
      // this session turned to have theirs in memory; every other page holds
      // the default it opened with, and a file made from those carried the
      // defaults as if they were the chapter's. Where the server will not say,
      // what is in memory is still the best there is.
      const stacks = shared.value ? await serverStacks(workspace.value, pages.value, pageRowOf) : null
      const entries: ZipEntry[] = []
      const written: ProjectPage[] = []

      for (const [index, page] of pages.value.entries()) {
        const path = pathOfPage(page)
        const scan = page.scan

        // The hash off the file where there is one, since a page opened a
        // moment ago may not have been identified yet — and the hash is what
        // every derived thing on the other end is filed under.
        const hash = scan?.hash ?? (scan ? await hashFile(scan.file).catch(() => null) : null)

        const size = pageSize(page)

        // Both logs, merged — see `mergePaint`. A page with no hash has no
        // paint filed under it either, since a surface is named by the scan.
        const paint = hash
          ? mergePaint(await localPaint(hash), page.uid ? painted.get(page.uid) : undefined)
          : {}

        written.push({
          ...(page.uid ? { uid: page.uid } : {}),
          path,
          name: page.name,
          position: index,
          ...(hash ? { hash } : {}),
          ...(size.width && size.height ? { width: size.width, height: size.height } : {}),
          ...(scan ? { file: `${PAGES_DIR}${path}` } : {}),
          // Copied out of Vue's reactive proxies, which is what everything
          // leaving this composable has to do — `JSON.stringify` on the archive
          // would manage it, but the shapes are handed around before that.
          blocks: JSON.parse(JSON.stringify(page.blocks)) as Block[],
          // Against the live blocks rather than the copy above, because it is
          // the live ones that carry `block:41` in their names — and keyed by
          // the index in the array being written, which is the same walk.
          ...(remembered.size
            ? (() => {
                const revisions = revisionsOf(page.blocks, remembered)

                return Object.keys(revisions).length ? { revisions } : {}
              })()
            : {}),
          ...((stacks?.get(page.id) ?? page.stack) ? { stack: JSON.parse(JSON.stringify(stacks?.get(page.id) ?? page.stack)) as StackLayer[] } : {}),
          ...(Object.keys(paint).length ? { paint } : {}),
        })

        // Named by what the scan *is*, so its checksum is worked out once a
        // session rather than on every save — the scan goes in stored, and its
        // bytes never change. See `ZipEntry.digest`.
        if (scan) entries.push({ name: `${PAGES_DIR}${path}`, data: scan.file, ...(hash ? { digest: hash } : {}) })

        busy.value = `Reading page ${index + 1} of ${pages.value.length}…`
      }

      busy.value = 'Collecting cleaned balloons…'

      /*
       * Every repair belonging to this chapter's scans, and nothing else.
       *
       * Narrowed by `patchScan`, exactly as the swarm narrows what it
       * announces: the patch store is content-addressed and shared across
       * every workspace this browser has ever opened, so an unnarrowed sweep
       * would put another chapter's cleaning in this chapter's file.
       *
       * Keyed by the repair's own name on the way in and out, so nothing here
       * has to know which block a patch belongs to — the key already says, and
       * `useClean` looks them up by recomputing it.
       */
      const mine = new Set(
        written.map((page) => page.hash).filter(Boolean).map((hash) => hash!.slice(0, 16)),
      )

      for (const key of await listPatches().catch(() => [])) {
        if (!mine.has(patchScan(key))) continue

        const patch = await readPatch(key).catch(() => null)

        if (patch) entries.push({ name: `${PATCHES_DIR}${key}.png`, data: patch })
      }

      busy.value = 'Collecting placed images…'

      for (const [hash, file] of await readPlacedMany(referenced())) {
        const reference = referenced().find((image) => image.hash === hash)

        // Filed under its own SHA-256 (`keepPlaced` checks), which is exactly
        // what a checksum can be remembered by.
        if (reference) entries.push({ name: `${IMAGES_DIR}${hash}.${reference.ext}`, data: file, digest: hash })
      }

      const project: Project = {
        v: PROJECT_VERSION,
        app: 'kemolate',
        exported: Date.now(),
        title: title.value,
        targetLocale: target.value || null,
        direction: direction.value ?? null,
        pages: written,
        glossaries: await gatherGlossaries(),
        cast: await gatherCast(),
        usage: await gatherUsage(),
        // Not a preference riding along: these two are stamped into every
        // patch key, so without them the repairs above arrive under names the
        // other end never computes. See `Project.clean`.
        clean: { model: cleanSettings.value.model, segmenter: cleanSettings.value.segmenter },
      }

      busy.value = 'Packing…'

      // The manifest first, so a reader that streams the archive front to back
      // knows what it is holding before the three hundred megabytes of scans.
      // The only entry worth deflating: it is JSON, and the rest is already
      // compressed picture data.
      entries.unshift({ name: MANIFEST, data: new Blob([JSON.stringify(project)]), deflate: true })

      const archive = await zip(entries)

      download(archive, projectFilename(title.value))

      toast.success('Project exported', {
        description: `${written.length} ${written.length === 1 ? 'page' : 'pages'}, ${formatBytes(archive.size)}.`,
      })

      return true
    } catch (error) {
      console.error('[kemolate] export failed', error)
      toast.error('That chapter could not be exported.', {
        description: error instanceof Error ? error.message : String(error),
      })

      return false
    } finally {
      busy.value = null
    }
  }

  /* ---------- in ---------- */

  /**
   * Open a project file, replacing whatever is in this workspace.
   *
   * Destructive by construction — `useLibrary.opened` replaces the chapter —
   * so the caller is expected to have asked. It refuses rather than half-opens
   * where the archive has no pages with files in it: a project whose scans were
   * all elsewhere has records this browser cannot found a chapter on, and
   * saying so is better than an empty canvas.
   */
  async function load (file: File): Promise<boolean> {
    if (busy.value) return false

    busy.value = 'Opening the project…'

    try {
      const held = await unzip(file)
      const manifest = held.get(MANIFEST)

      if (!manifest) {
        toast.error('That file is not a project', { description: 'It has no manifest in it.' })

        return false
      }

      const read = readManifest(await manifest.text())

      if ('refused' in read) {
        toast.error('That project could not be opened', { description: read.refused })

        return false
      }

      const { project } = read

      // Pages in the order the manifest gives them, which is the reader's own
      // ordering rather than whatever the archive's index happened to hold.
      const ordered = [...project.pages].sort((a, b) => a.position - b.position)

      const images: PickedImage[] = []
      const carried = new Map<string, ProjectPage>()

      for (const page of ordered) {
        if (!page.file || !safeName(page.file)) continue

        const bytes = held.get(page.file)

        if (!bytes) continue

        images.push({ file: new File([bytes], page.name, { type: bytes.type }), path: page.path })
        carried.set(page.path, page)
      }

      if (!images.length) {
        toast.error('That project has no pages in it', {
          description: 'Its scans were on another machine when it was exported.',
        })

        return false
      }

      const absent = ordered.length - images.length

      busy.value = 'Restoring placed images…'

      // Placed images before the pages that name them, so a stack row arrives
      // at a canvas that can already draw it rather than to a gap that fills
      // in. Ahead of `opened` for the same reason `dress` is inside it: this is
      // the last moment before the chapter starts existing.
      for (const [name, bytes] of held) {
        if (!name.startsWith(IMAGES_DIR) || !safeName(name)) continue

        const [hash, ext] = name.slice(IMAGES_DIR.length).split('.')

        if (!hash || !ext) continue

        await keepPlaced({ hash, ext: ext as PlacedExtension }, bytes)
      }

      /*
       * The repairs, back into the store they came out of, under their own
       * names — and the settings that make those names computable again.
       *
       * Settings first, because `patchKey` reads them: a browser whose cleaner
       * is set to something else would look up keys that name its inpainter
       * rather than the one these were made with, find nothing, and show a page
       * that has plainly been cleaned as though it never had been.
       *
       * Only where the file carries them. A project written before this existed
       * has no repairs to find, and silently changing somebody's cleaner on
       * their behalf would be a worse answer than leaving it.
       */
      if (project.clean) {
        cleanSettings.value = {
          // Kept rather than carried: `remote` names a machine on this
          // reader's network, and is not the chapter's to bring or replace.
          ...cleanSettings.value,
          model: project.clean.model as typeof cleanSettings.value.model,
          segmenter: project.clean.segmenter,
        }
      }

      let repairs = 0

      for (const [name, bytes] of held) {
        if (!name.startsWith(PATCHES_DIR) || !safeName(name) || !name.endsWith('.png')) continue

        const key = name.slice(PATCHES_DIR.length, -'.png'.length)

        if (!key) continue

        await writePatch(key, bytes)
        repairs++
      }

      /**
       * What each page already is, said in the one tick where saying it counts.
       *
       * Handed to `opened` rather than run after it, and that note explains
       * why at length: `syncPages` mints a `uid` for every page that has not
       * got one and `useLayerSync.pull` founds a stack from `DEFAULT_STACK`
       * and reads it back over the client's, both on the tick after the pages
       * land. Doing this afterwards lost the imported stack and the imported
       * uids on any workspace with a server record — which, since a dropped
       * project mints one for a signed-in reader, is the ordinary case.
       *
       * Synchronous throughout, necessarily. Paint is the one thing left out
       * and the one thing that can be: it is filed under the scan's hash
       * rather than against a row, so nothing server-side is racing for it.
       */
      const dress = () => {
        const staked: string[] = []

        for (const page of pages.value) {
          const carriedPage = carried.get(pathOfPage(page))

          if (!carriedPage) continue

          // The names are dropped, and that is the one transformation on the
          // way in — see the note at the top of this file, and `localise`,
          // which exists for this exact failure.
          if (carriedPage.blocks.length) setBlocks(page.id, localise(carriedPage.blocks))

          if (carriedPage.uid && !page.uid) page.uid = carriedPage.uid

          if (!carriedPage.stack) continue

          page.stack = structuredClone(carriedPage.stack)
          staked.push(page.id)
        }

        /*
         * Assigning the stack is not enough on a workspace with a server
         * record, and this is the half that was missing.
         *
         * `ensurePlate` founds a page's whole `DEFAULT_STACK` server-side the
         * moment a paint canvas connects — a tick after the pages appear — and
         * `useLayerSync.pull` then reads those rows back as authoritative and
         * assigns them over the imported ones. Nothing warns, because from the
         * sync's point of view it is doing exactly its job. What went missing
         * was every sheet, group, adjustment and placed image in the file, and
         * a placed image is the one row whose bytes cannot be made again.
         *
         * So the pages say so, and `pull` honours it once each — see
         * `useLayerClaims`.
         */
        if (staked.length) layerClaims.value = [...new Set([...layerClaims.value, ...staked])]
      }

      // Handed over to `useLibrary` rather than done here, so the pages are
      // copied into storage, remembered for next time and pushed to the
      // workspace exactly as a dropped folder would be. Its own progress line
      // takes over from here, which is why ours comes down first.
      busy.value = null

      if (!await opened({ handle: null, images, title: project.title || null, rest: null }, dress)) return false

      // Desktop: the chapter in the file is the workspace's name now — a name
      // the reader gave the chapter it replaced is about that chapter, and the
      // workspace page lays the kept name over every open (`Workspace.named`).
      if (project.title) await useWorkspaces().retitle(workspace.value, project.title)

      const mine = epoch.value

      busy.value = 'Restoring the work…'

      for (const page of ordered) {
        // The hash out of the manifest rather than one computed here: these are
        // the same bytes the export read, so it is the same digest, and waiting
        // for `identify` to work its way through the chapter would mean the
        // paint landing minutes after the pages.
        if (!page.hash || !page.paint) continue

        for (const [surface, strokes] of Object.entries(page.paint)) {
          // A cloud workspace's mask corrections are filed under their block's
          // row (`mask-41`), and the block arrives renamed from it (`localise`,
          // `block:41` to `read:r41`) — so the corrections go under the name the
          // block has here, which is what `useMaskEdits` asks a local
          // workspace's log for. Left under the row's name they were carried
          // and never read, and re-cleaning a balloon lost its corrections.
          await seed(page.hash, localSurface(surface), strokes)
        }
      }

      /*
       * The history is parked rather than restored, and cannot be otherwise.
       *
       * A revision hangs off a translation, which hangs off a block row on the
       * server — and at this moment the blocks on these pages are the client's
       * own, with no rows anywhere. `useTranslationSync` puts each page's
       * history back at the first instant it can, which is the settle after
       * that page's translations have gone up. See `utils/history`.
       *
       * Filed under the *live* page rather than the manifest's, because the key
       * is the client's page id and that is a thing only the open chapter has.
       */
      for (const page of pages.value) {
        const carriedPage = carried.get(pathOfPage(page))

        if (carriedPage?.revisions) await parkHistory(workspace.value, page.id, carriedPage.revisions)
      }

      /*
       * The ledger, adopted whole — see `ProjectUsage`, which is plain about
       * what that means: a file from somebody else brings their spend with it.
       *
       * Written straight to the key rather than through `useAiUsage`, which
       * would need pointing at this workspace and has no "replace the lot"
       * anyway. Nothing merges, because a fresh workspace has nothing to merge
       * with and an import into one that does is replacing its chapter outright.
       */
      if (project.usage) {
        await idb.set(idbKey.usage(workspace.value), project.usage).catch(() => {
          console.warn('[kemolate] imported AI ledger not kept')
        })

        await restoreUsage()
      }

      await restorePlaced()

      if (project.targetLocale) await setTarget(project.targetLocale)
      if (project.direction) await setDirection(project.direction)

      // The terms and the cast, into whichever store this workspace keeps them
      // in: the server for a cloud one, this browser for a local one. A local
      // workspace used to import neither — see `teach`.
      const taught = await teach(project)

      /*
       * Into a cloud workspace, the whole chapter goes up now rather than a page
       * at a time as each is shown. The syncs keep the page on screen in step,
       * and a cloud workspace keeps no copy of its reading in this browser (see
       * `useBlockCache`), so an imported page nobody turned to before the tab
       * closed would have come back empty. The page list first, because blocks
       * are filed under its rows; then the blocks, then what they say — which
       * is also what puts each page's imported history back.
       */
      if (shared.value) {
        await syncPages()
        await uploadChapterBlocks()
        await uploadChapterTranslations()
      }

      // The comic may have been closed and another opened while the archive was
      // being unpacked, in which case none of the above belongs to what is on
      // screen and the toast would be about somebody else's chapter.
      if (epoch.value !== mine) return true

      // What the file turned out to be carrying, counted from the manifest
      // rather than from what has landed — the history goes back page by page
      // as each is synced, so a count of what *has* been restored would read as
      // nought on a chapter nobody has turned a page of yet.
      const lines = ordered.reduce(
        (total, page) => total + Object.values(page.revisions ?? {}).flat().length,
        0,
      )

      toast.success('Project imported', {
        description: [
          `${images.length} ${images.length === 1 ? 'page' : 'pages'}`,
          absent ? `${absent} without files` : '',
          taught ? `${taught} glossary terms` : '',
          lines ? `${lines} translation histories` : '',
          repairs ? `${repairs} cleaned balloons` : '',
          project.usage?.entries.length ? `${project.usage.entries.length} AI calls` : '',
        ].filter(Boolean).join(', ') + '.',
      })

      return true
    } catch (error) {
      console.error('[kemolate] import failed', error)
      toast.error('That project could not be opened.', {
        description: error instanceof Error ? error.message : String(error),
      })

      return false
    } finally {
      busy.value = null
    }
  }

  /**
   * Put the chapter's terms and cast back — into the server for a cloud
   * workspace, into this browser for a local one.
   *
   * The glossary is *merged* — `glossaries.merge`, first-translation-wins — so
   * importing twice adds nothing the second time and an import into a workspace
   * that already has terms does not argue with them.
   *
   * The cast is saved whole, which pins every row. That is a real difference
   * from what was exported, where a row the model proposed is unpinned and
   * later pages may still fill its blanks — and it is the right way to be
   * wrong: an imported cast is work somebody already did, and the conservative
   * failure is a later page being unable to revise it rather than being able to.
   */
  async function teach (project: Project): Promise<number> {
    let terms = 0

    // A local workspace keeps them in this browser, by the same rules.
    if (!shared.value) {
      for (const glossary of project.glossaries ?? []) terms += await keepGlossaryLocally(workspace.value, glossary)

      if (project.cast?.length) await keepCastLocally(workspace.value, project.cast, '')

      return terms
    }

    for (const glossary of project.glossaries ?? []) {
      for (let at = 0; at < glossary.terms.length; at += TERMS_PER_REQUEST) {
        const slice = glossary.terms.slice(at, at + TERMS_PER_REQUEST)

        await $fetch(`/api/workspaces/${workspace.value}/glossary`, {
          method: 'PUT',
          body: { locale: glossary.locale, learned: slice.map(({ source, target: tr }) => ({ src: source, tr })) },
        }).catch(() => null)

        terms += slice.length
      }
    }

    if (project.cast?.length) {
      await $fetch(`/api/workspaces/${workspace.value}/cast`, {
        method: 'PUT',
        body: {
          members: project.cast.map(({ source, names, gender, tags }) => ({ source, names, gender, tags })),
          notes: '',
        },
      }).catch(() => null)
    }

    return terms
  }

  return { busy, save, load, handOver, claim }
}
