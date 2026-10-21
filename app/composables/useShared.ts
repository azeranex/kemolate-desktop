/**
 * What the server knows about this workspace, and what that means for someone
 * who has just walked into it.
 *
 * A workspace can be in one of three states and they look identical from inside
 * the browser, which is what made joining one so confusing: local-only, yours
 * and shared, or somebody else's that you have been let into. Only the server
 * can tell them apart, so this asks — and the answer is what lets the canvas
 * say something true instead of reaching for the stand-in comic.
 *
 * The distinction that matters most is the last one. Pages are files on the
 * machine that opened them; joining a workspace gets you the *record* of a
 * chapter, not the chapter. Until the pages can be handed over peer-to-peer
 * there is nothing to draw, and saying so plainly is better than an empty
 * canvas that looks like a bug.
 */

export interface RemotePage {
  /** The server's row id — what surfaces and strokes are filed under. */
  id: number
  /** The chapter's own name for this page, the same in everybody's copy. */
  uid: string
  path: string
  name: string
  position: number
  hash: string | null
  /**
   * The scan's own size, as recorded by whoever held the file and drew it.
   *
   * Worth carrying to a browser that has no picture: a page's boxes are shares
   * of the page box, so a chapter drawn at the usual proportions when it is
   * really something else puts every balloon in the wrong place. See
   * `showMissing`, and `pageSize` in `useComic`, which is what reads it.
   */
  width: number | null
  height: number | null
}

export interface SharedState {
  workspace: {
    publicId: string
    name: string
    ownerId: number
    /**
     * What the chapter is being translated into, when the server has been told.
     * Null for a workspace claimed before anybody set one — see
     * `useTargetLanguage`, which falls back to this browser's own answer.
     */
    targetLocale: string | null
    /**
     * Which way round the chapter reads. Null for a workspace claimed before
     * anybody said — see `useReadingDirection`, which falls back the same way
     * the target language does.
     */
    direction: 'ltr' | 'rtl' | null
  }
  role: WorkspaceRole | null
  /** Whether the scans are presumably on this person's disk. */
  owner: boolean
  pages: RemotePage[]
  /** Whose workspace it is, for saying whose machine the pages are on. */
  owners: string | null
}

/**
 * The path a page is filed under, which is what its local id carries — unless
 * the page came from the workspace rather than from a folder, in which case it
 * was told, and being told beats being inferred. See `ComicPage.path`.
 */
export const pathOfPage = (page: ComicPage) =>
  page.path ?? (page.id.startsWith('scan:') ? page.id.slice('scan:'.length) : page.name)

/**
 * Which row an open page is — the one answer, used everywhere it is asked.
 *
 * By `uid` first, because that is the page saying who it is and cannot be two
 * pages at once. By hash second, but *only where the hash picks out one row*:
 * two blank pages are byte-identical, and a hash shared by two rows names
 * neither. By path last, for a page whose bytes have not been read yet.
 *
 * The ambiguity check is the whole reason this is a function rather than three
 * copies of a lookup. It used to be written out in `pageRowOf`, in `align`, in
 * `useLiveSync` and in `useMaskEdits`, each preferring the hash outright — so a
 * chapter holding one image twice mapped both pages to one row, and a block
 * re-read landed on whichever page happened to come first. Same rule as the
 * server's `rowFor`, stated on this side once.
 */
export function rowOfPage (rows: RemotePage[], page: ComicPage): RemotePage | undefined {
  if (!rows.length) return undefined

  if (page.uid) {
    const named = rows.find((row) => row.uid === page.uid)

    if (named) return named
  }

  const hash = page.scan?.hash

  if (hash) {
    const alike = rows.filter((row) => row.hash === hash)

    if (alike.length === 1) return alike[0]
  }

  return rows.find((row) => row.path === pathOfPage(page))
}

/**
 * The chapter with the workspace's own pages on it, whether or not their
 * pictures are on this computer — or null where nothing has moved.
 *
 * At module level and pure, for the same reason `rowOfPage` above is: this is a
 * rule about what the chapter *is*, it has to agree with the matching rule
 * exactly, and a rule that can only be exercised by standing a workspace up is
 * a rule nobody checks. `showMissing` is the half that assigns.
 *
 * A full reconcile rather than an append, and it has to be. A page becomes
 * absent when a collaborator adds one and stops being absent the moment a file
 * arrives for it or somebody opens the folder, so both directions have to be
 * noticed by running this again — which means running it when nothing has
 * changed must cost nothing and change nothing. That is what the null is for.
 */
export function withAbsent (rows: RemotePage[], pages: ComicPage[]): ComicPage[] | null {
  if (!rows.length) return null

  const held = pages.filter((page) => page.scan)

  /*
   * Nothing can be said until every file here knows what it is — the same
   * guard, and the same reason, as `align`. Hashes are worked out in the
   * background long after the pages are on screen, so for the first seconds of
   * every chapter no local page matches any row. Judging then would declare the
   * whole chapter absent and lay a second, empty copy of it over the one the
   * reader is already looking at.
   */
  if (held.some((page) => !page.scan!.hash)) return null

  // Which rows the files on this computer account for. Asked page-first, the
  // way everything asks — see `rowOfPage` — because two pages can share a hash
  // and "which row is this page" is the question that always has one answer.
  const claimed = new Set<number>()

  for (const page of held) {
    const row = rowOfPage(rows, page)

    if (row) claimed.add(row.id)
  }

  const byUid = new Map(rows.map((row) => [row.uid, row]))

  // What stays: everything with a file, and every absent page whose row is
  // still in the chapter and still unaccounted for. The two that go are the
  // page whose file has just turned up — it is on the list twice for an
  // instant, once as itself and once as the gap it filled — and the page
  // somebody removed from the workspace while we were looking at it.
  const kept = pages.filter((page) => {
    if (page.scan) return true

    const row = page.uid ? byUid.get(page.uid) : undefined

    return row ? !claimed.has(row.id) : false
  })

  const shown = new Set(kept.filter((page) => !page.scan).map((page) => page.uid))

  const added: ComicPage[] = rows
    .filter((row) => !claimed.has(row.id) && !shown.has(row.uid))
    .map((row) => ({
      // Its own namespace, not `scan:` — that prefix is a path in the reader's
      // folder and is read back as one in half a dozen places, and a page with
      // no file has no path *here*. It cannot be the path either way now that a
      // drop adds pages in their own right: two rows may honestly hold one
      // path, and two pages sharing an id is two pages the app cannot tell
      // apart. The uid is the one name that is unique and means the same thing
      // in everybody's copy.
      id: `page:${row.uid}`,
      uid: row.uid,
      name: row.name,
      path: row.path,
      blocks: [],
      ...(row.width && row.height ? { size: { width: row.width, height: row.height } } : {}),
    }))

  if (!added.length && kept.length === pages.length) return null

  /*
   * Where each page sits, by the one matching rule rather than by uid.
   *
   * Asking for the uid alone was wrong in the case this feature exists for, and
   * wrong in a way that looked like the chapter had been shuffled: a page read
   * off a folder has no uid until a push comes back with one, so on the way in
   * *every* page that is actually here answers "nowhere" while every absent
   * page — invented from a row, so named from birth — answers with its real
   * position. The pages that were missing sorted to the front and the pages
   * that were there piled up behind them.
   *
   * `rowOfPage` is the rule: uid, then an unambiguous hash, then path. It is
   * what `align` sorts by and what `claimed` above is built from, so a page
   * cannot be counted as accounting for a row and then filed somewhere else.
   */
  const place = (page: ComicPage) => rowOfPage(rows, page)?.position ?? Number.MAX_SAFE_INTEGER

  // Into the chapter's order rather than onto the end. `align` sorts the pages
  // this browser holds and returns early when it holds none, which is exactly
  // the chapter this exists for — so the sort is done here as well, by the same
  // rule, on the same numbers.
  return [...kept, ...added].sort((a, b) => place(a) - place(b))
}

/**
 * Make a workspace on the server, by the id the browser already minted.
 *
 * At module level and taking its id as an argument, unlike everything else
 * here, because the one caller that matters most has no route to read it from:
 * pressing New workspace makes the id and *then* navigates, and a signed-in
 * person's new workspace should exist before they arrive rather than at
 * whatever later moment something happened to save.
 *
 * The single door to `POST /api/workspaces`, so that "a workspace is created"
 * stays one act with one shape. Idempotent at the endpoint — the browser minted
 * the id — so a retry, a second tab or a reload mid-flight lands on the same
 * workspace rather than a second one.
 */
/**
 * Give a workspace a different name.
 *
 * At module level and taking its id, like `createWorkspace` and for the same
 * reason: the list on the front page renames workspaces it is not standing in,
 * so there is no route to read the id from.
 *
 * The name is the chapter's, not this reader's — `align` copies it onto the
 * open comic on every sync, so two people looking at one chapter see one title
 * for it. Which is also why this is the owner's to do; the endpoint refuses
 * anybody else (`manageWorkspace`) and this reports that rather than swallowing
 * it, because a rename that silently does nothing is worse than one that is
 * refused out loud.
 */
export async function renameWorkspace (publicId: string, name: string): Promise<boolean> {
  const done = await $fetch(`/api/workspaces/${publicId}`, {
    method: 'PATCH',
    body: { name },
    headers: peerHeader(publicId),
  }).then(() => true).catch(() => false)

  // The local index too, or the front page goes on showing the old name for a
  // workspace whose row has already changed — it is filled from both, and the
  // stale half wins for anything opened on this machine.
  if (done) await useWorkspaces().retitle(publicId, name)

  return done
}

export async function createWorkspace (publicId: string, name: string, targetLocale?: string | null) {
  await $fetch('/api/workspaces', {
    method: 'POST',
    body: { publicId, name, targetLocale: targetLocale ?? undefined },
  })
}

export function useShared () {
  const route = useRoute()

  // Once, here, rather than inside the functions below: several of them run
  // from watcher callbacks and after awaits, where a composable called is one
  // nobody owns — see `upkeep` in `useComic`.
  const { pages, open, title, at } = useComic()
  const { loggedIn } = useUserSession()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /**
   * Null while unknown *and* when the workspace is not on the server at all —
   * which is the ordinary case, and not a failure. A purely local workspace is
   * the state this app starts in and most workspaces stay in.
   */
  const shared = useState<SharedState | null>('workspace-shared', () => null)

  /**
   * Which workspace record is in hand and what this reader may do in it, as a
   * string that changes only when one of those does — for the watchers that
   * care about nothing else.
   *
   * `shared` itself is replaced whole on every refresh: every collaborator's
   * page-list notice, every rename, every change of language or direction.
   * Watched directly, each of those re-read the glossary, the cast and the
   * page's layers and re-announced this tab to the swarm, for a record whose
   * workspace and standing had not moved. Those lists hear about their own
   * changes through their own notices.
   */
  const standing = computed(() => (shared.value ? `${shared.value.workspace.publicId}:${shared.value.role}` : null))

  const asking = useState('workspace-asking', () => false)

  /** What has already been said about the open pages, so it is not said twice. */
  const warned = useState<string | null>('workspace-warned', () => null)

  async function look () {
    shared.value = null

    // Signed out, there is nobody for the server to have a workspace on behalf
    // of. Asking would only ever get a 404 and the answer would mean nothing.
    if (!loggedIn.value || !workspace.value) return

    asking.value = true

    try {
      shared.value = await $fetch<SharedState>(`/api/workspaces/${workspace.value}`)
    } catch {
      // A 404 here is "not shared", which is not an error and not worth a toast.
      shared.value = null
    } finally {
      asking.value = false
    }
  }

  /**
   * Take a page out of what the server is known to hold.
   *
   * The other half of skipping your own change notice. A browser that deletes a
   * page is left out of the notice it raises — it has already done the work —
   * but `discard` only ever removed the page from the *comic*, never from
   * `shared`, so the deleting tab went on believing the workspace still held a
   * row it had just destroyed. What that looked like was the empty canvas
   * offering to fetch the page back: "1 pages, on another computer of yours",
   * about a page nobody has any more.
   *
   * Nothing is asked of the server here. The row is gone; this is the local
   * bookkeeping that would otherwise wait for a reload.
   */
  function forgetPage (rowId: number) {
    if (!shared.value) return

    shared.value = {
      ...shared.value,
      pages: shared.value.pages.filter((row) => row.id !== rowId),
    }
  }

  /**
   * Ask again, without pretending we know nothing in the meantime.
   *
   * `look` blanks `shared` before it fetches, which is right when walking into a
   * workspace — what was on screen belonged to the last one. It is wrong for a
   * re-read: `writable` in both sync composables reads `shared`, so the blank
   * moment turns every one of them off and back on, and the watcher firing on
   * the way past re-sends a page that had not changed. The `shared` watcher on
   * the workspace page would meanwhile see null and run `syncPages` again.
   *
   * So this replaces the answer rather than clearing it, and keeps the old one
   * on a failure — a re-read that fails means the page list is stale, not that
   * the workspace has stopped being shared.
   */
  async function refresh () {
    if (!loggedIn.value || !workspace.value) return

    const state = await $fetch<SharedState>(`/api/workspaces/${workspace.value}`).catch(() => null)

    if (state) shared.value = state
  }

  /**
   * Make the open chapter and the shared one agree.
   *
   * There is a direction to this and getting it wrong is what made a mess: the
   * workspace's page list is what everybody in it has agreed the chapter is,
   * and one person's folder is a copy of it — not an amendment to it. So a
   * client whose workspace already has pages *lines up with them* rather than
   * sending its own, and only a workspace with no pages at all takes its list
   * from whoever opened one first.
   *
   * Without that rule, an editor who opened a different chapter while sitting
   * in this workspace had all of it merged in, page by page, alongside the real
   * one — two chapters in a list that claims to be one, with two pages for
   * every position.
   */
  /**
   * Give a workspace that has never been named the name of the chapter opened
   * in it.
   *
   * This exists because creation moved to the server. A workspace used to be
   * written at its first *reading* — by which time a folder had been opened and
   * `title` was already "Chapter 12", so the row was born with the right name.
   * Made up front, before there is any chapter, it can only be born `Untitled`
   * — and `align` below copies the workspace's name onto the open comic, so
   * without this the folder you just opened would be renamed to `Untitled` a
   * moment after opening it.
   *
   * Only ever from `Untitled`, so this cannot overwrite a name somebody chose,
   * and never *to* `Untitled`, so a workspace opened with nothing in it keeps
   * whatever it was called. Best effort and silent: a name is the least of what
   * a failed request costs.
   */
  async function christen () {
    if (!shared.value || !atLeast(shared.value.role, 'editor')) return
    if (shared.value.workspace.name !== UNTITLED) return
    if (!title.value || title.value === UNTITLED) return

    const name = title.value

    const done = await $fetch(`/api/workspaces/${workspace.value}`, {
      method: 'PATCH',
      body: { name },
      headers: peerHeader(workspace.value),
    }).then(() => true).catch(() => false)

    if (done && shared.value) {
      shared.value = { ...shared.value, workspace: { ...shared.value.workspace, name } }
    }
  }

  async function syncPages () {
    if (!shared.value || !atLeast(shared.value.role, 'editor')) return

    // Before anything reads the workspace's name back onto the comic — `align`
    // does exactly that, a few lines down.
    await christen()

    // The workspace has never been told what it contains, so this is the first
    // person to open it and their folder is the answer.
    if (!shared.value.pages.length) {
      await push()

      return
    }

    align()

    await fill()
  }

  /**
   * Fill in the hashes and sizes the workspace's own rows are still missing.
   *
   * A chapter is pushed the instant it is on screen and hashed for seconds
   * afterwards — see `identify` — so the rows a workspace is founded on are
   * written with `hash: null`, and every later firing of the watcher lands in
   * `align`, which only reorders. Those nulls therefore stayed null for the
   * life of the workspace, and a page with no hash is a page nobody can ask
   * for: the second computer showed the chapter as missing and answered
   * "nothing to fetch" in the same breath, because the fetch had nothing to
   * name.
   *
   * Only rows the workspace already holds, matched on path, and only ones with
   * no hash yet — this fills in a blank rather than amending the chapter.
   * Pages the workspace has never heard of stay out of it: sending them would
   * have the server add them, which is the mess `align`'s rule exists to
   * prevent.
   */
  async function fill () {
    if (!shared.value || !atLeast(shared.value.role, 'editor')) return

    const held = new Map(local().map((page) => [page.path, page]))

    // Everything but the hash is the row exactly as the server already has it,
    // so this cannot reorder or rename a chapter on its way past. Sending the
    // *open* page would put this browser's folder order on rows it is only
    // identifying — and during the hashing burst `align` has not run yet, so
    // that order is whatever the folder happened to sort as.
    // Named by `uid`, so filling a hash in cannot be mistaken for anything
    // else — a row identified by its path alone would, on a chapter holding two
    // copies of one image, hand the same hash to whichever of them matched
    // first.
    //
    // The size rides the same way and for the same reason. Every row in every
    // workspace was founded without one — pages are pushed before they have
    // been measured — so a page opened where its file is not had no shape to
    // be laid out in, and its lettering was never set at all (`dims` nought).
    const filling = (shared.value?.pages ?? [])
      .flatMap((row) => {
        const mine = held.get(row.path)
        const hash = row.hash ?? mine?.hash ?? null
        const sized = !row.width && mine?.width && mine.height

        if (!mine || ((row.hash || !hash) && !sized)) return []

        return [{
          uid: row.uid,
          path: row.path,
          name: row.name,
          position: row.position,
          hash,
          // Null leaves the server's as it is — see `pages.sync`.
          width: sized ? mine.width : null,
          height: sized ? mine.height : null,
        }]
      })

    await push(filling)
  }

  /**
   * The server's row id for an open page, where there is one.
   *
   * The rule itself is `rowOfPage` at the top of this file — uid, then an
   * unambiguous hash, then path — and lives there so that this, `align`,
   * `useLiveSync` and `useMaskEdits` cannot drift into four opinions about
   * which row a page is. (`useOcr` and `useBlockMerge` still carry their own
   * copies, written before there was anywhere shared to put it.)
   */
  function pageRowOf (target: ComicPage): number | null {
    return rowOfPage(shared.value?.pages ?? [], target)?.id ?? null
  }

  /**
   * The open pages, in the shape the server records them.
   *
   * Only the ones this browser actually holds a file for. A page whose picture
   * is elsewhere came *from* this list in the first place — see `showMissing` —
   * and sending it back would be describing the workspace to itself.
   *
   * The position is its place in the whole chapter, not its place among the
   * pages that happen to be here, and the difference is not cosmetic: a browser
   * holding pages three and seven of ten would otherwise call them nought and
   * one and move them to the front of the chapter for everybody.
   */
  function local () {
    return pages.value
      .map((page, position) => ({ page, position }))
      .filter(({ page }) => page.scan)
      .map(({ page, position }) => ({
        // What the chapter calls it, where this browser has been told. Absent
        // for a page nobody has filed yet, which is how the server knows to
        // give it a name rather than look one up.
        uid: page.uid ?? null,
        // The path inside the opened folder, which is what a page is filed
        // under — `id` carries it because the name alone collides the moment a
        // chapter has sub-folders in it.
        path: pathOfPage(page),
        name: page.name,
        position,
        hash: page.scan?.hash ?? null,
        // The picture's own size once something has measured it, so a machine
        // without the file can still lay the page out — see `fill`.
        width: page.scan?.width || null,
        height: page.scan?.height || null,
      }))
  }

  /**
   * Tell the server what this browser holds — additive on its side, so a page
   * it already knows is brought up to date and nothing is ever removed.
   *
   * Guarded here as well as at the endpoint, because it is no longer only
   * `syncPages` calling: a page reordered, renamed or added in the panel is an
   * amendment deliberately made, and comes through here to reach everybody
   * else — see `useLibrary`. From anyone who may not make one, it is a no-op
   * rather than a request the server would only refuse.
   *
   * The list is the open chapter unless a caller narrows it — `fill` sends the
   * few rows it is filling a hash in for, rather than the whole chapter, so
   * that a page the workspace has never heard of cannot ride along with it.
   */
  async function push (list = local()) {
    if (!shared.value || !atLeast(shared.value.role, 'editor')) return

    if (!list.length) return

    const written = await $fetch<RemotePage[]>(`/api/workspaces/${workspace.value}/pages`, {
      method: 'PUT',
      body: { pages: list },
      // So the change notice this raises skips this tab — see `peerHeader`. It
      // matters more here than elsewhere: the reply *is* the new page list and
      // is kept below, so a re-read would be pure waste.
      headers: peerHeader(workspace.value),
    }).catch(() => {
      // Best effort. The pages are open locally either way, and failing to tell
      // the server is not a reason to interrupt the person looking at them.
      return null
    })

    // Kept, rather than dropped on the floor. The rows come back with the ids
    // the server filed them under, and everything that hangs off a page —
    // blocks, surfaces, strokes — is filed under those. Without this the first
    // person to open a chapter had no page ids until they reloaded, so the
    // first reading of it was the one reading that could not be saved.
    if (written && shared.value) shared.value.pages = written

    if (written) adopt(written)
  }

  /**
   * Put the chapter's name for each page onto the page.
   *
   * The half of the round trip that makes `uid` worth having. A page opened
   * from a folder has no name of its own until the workspace gives it one, and
   * only the reply carries it — so without this every push would look like a
   * first mention and the matching would fall back to hashes for ever, which is
   * exactly what could not tell two blank pages apart.
   *
   * Matched by everything *except* uid, deliberately: this is the moment before
   * a page has one, so the only things to go on are the bytes and the path.
   * Once adopted, it never has to be guessed again.
   *
   * `useLibrary` keeps them, so a reload does not start this over.
   */
  function adopt (rows: RemotePage[]) {
    const byPath = new Map(rows.map((row) => [row.path, row]))

    for (const page of pages.value) {
      if (page.uid) continue

      const row = byPath.get(pathOfPage(page))

      if (row) page.uid = row.uid
    }
  }

  /**
   * Put the open pages into the workspace's order, and say so when they are not
   * the workspace's pages at all.
   *
   * Matched on hash, which is the only thing two people's folders reliably
   * share — names and sort order are whatever each of them happened to
   * download. A page the workspace does not know about is left where it is
   * rather than being added: this browser cannot tell the difference between
   * "a page the others are missing" and "a page from another chapter I opened
   * by mistake", and only one of those should change what everybody sees.
   */
  function align () {
    // The one rule — uid, then an unambiguous hash, then path. The path
    // fallback is not a nicety: a page added to a chapter that is already open
    // has a row for a moment before its hash is filled in, and without it
    // `align` counted that page a stranger, said "2 of 3 pages match this
    // workspace", and sorted the page somebody had just added to the end.
    const rowFor = (page: ComicPage) => rowOfPage(shared.value?.pages ?? [], page)

    const open = pages.value.filter((page) => page.scan)

    if (!open.length) return

    /**
     * Nothing can be said until every page knows what it is.
     *
     * Hashing happens in the background, long after the pages are on screen, so
     * for the first seconds of every chapter *none* of them has a hash and none
     * of them matches anything. Judging then declares every chapter a stranger
     * — which is exactly what it did, on every open, to the very workspace the
     * pages belonged to.
     *
     * A page with a `uid` does not wait: that is the name the workspace itself
     * handed out, `rowFor` matches it before it ever looks at a hash, and
     * `applyMeta` lays it back before this can run. Waiting for its hash anyway
     * is what put the wrong first page on screen for the whole of the hashing —
     * the chapter comes up in path order, and a chapter whose recorded order
     * disagrees with its paths (a cover added after page one) showed the wrong
     * page until the last hash landed, then snapped. The guard is only for
     * pages with no identity at all, where judging really would be guessing.
     */
    if (open.some((page) => !page.uid && !page.scan?.hash)) return

    const matched = open.filter((page) => rowFor(page))

    // Nothing in common, and now that is a fact rather than a race. Almost
    // certainly a different chapter opened while standing in this workspace,
    // which is worth saying rather than quietly showing one thing under the
    // name of another.
    if (!matched.length) {
      // Once per chapter, not once per render: the watcher fires again on every
      // page count and hash that lands, and the same warning five times reads
      // as five problems.
      const signature = `${workspace.value}:${open.map((page) => page.scan!.hash).join('')}`

      if (warned.value !== signature) {
        warned.value = signature

        toast.warning('These aren’t this workspace’s pages', {
          description: `“${shared.value?.workspace.name}” holds ${shared.value?.pages.length} other pages. Nothing has been changed for anybody else.`,
        })
      }

      return
    }

    warned.value = null

    // Some of them, but not all. Worth naming: a chapter that is nearly right
    // looks identical to one that is right until somebody reaches the odd page.
    if (matched.length < open.length) {
      const signature = `${workspace.value}:partial:${matched.length}/${open.length}`

      if (warned.value !== signature) {
        warned.value = signature

        toast.info(`${matched.length} of ${open.length} pages match this workspace`, {
          description: 'The rest are not part of it and have been left at the end.',
        })
      }
    }

    // The workspace's name wins over the folder's, so two people looking at the
    // same chapter are looking at the same title for it.
    if (shared.value?.workspace.name) title.value = shared.value.workspace.name

    pages.value = [...pages.value].sort((a, b) => {
      const left = rowFor(a)?.position
      const right = rowFor(b)?.position

      // Anything the workspace has not heard of sinks below everything it has,
      // keeping its own order among the rest.
      return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER)
    })
  }

  /**
   * Put the workspace's own pages on the chapter, whether or not their pictures
   * are on this computer.
   *
   * This is the answer to the state that used to be a dead end. A workspace
   * knows exactly what its chapter is — the pages, their order, the boxes on
   * them and what those say — and the scans stay on the machines that opened
   * them. A second computer, a colleague, a folder that has since been moved:
   * all of them arrived at an empty canvas with a sentence explaining that the
   * pages were elsewhere, and there was nothing to do about it but hope a peer
   * was awake or open the very folder that had gone missing.
   *
   * So the pages are shown. They are the real pages — the same rows, the same
   * uids, the same blocks and translations, which `useOcr.restore` fills in
   * from the workspace as it does for any other page — and only the picture is
   * absent. What that buys is somewhere to put the file back: an absent page
   * can be handed one by name, which is a gesture the empty canvas had nowhere
   * to offer. See `link` in `useLibrary`.
   *
   * `withAbsent` at the top of this file works out what the chapter should be
   * and says why; this puts it there, keeps the page being looked at under the
   * reader, and settles the chapter's own flags. Safe to run on every pass, and
   * run on most of them — see the workspace page and `useLiveSync.relist`.
   */
  function showMissing () {
    const rows = shared.value?.pages ?? []
    const looking = pages.value[at.value]?.id

    const next = withAbsent(rows, pages.value)

    if (next) {
      pages.value = next

      const still = pages.value.findIndex((page) => page.id === looking)

      at.value = still !== -1 ? still : Math.min(at.value, Math.max(0, pages.value.length - 1))
    }

    /*
     * Said on every pass, not only on the pass that changed something.
     *
     * `open` is `useComic`'s own flag and is settled by more than one thing at
     * once on the way into a workspace: `useLibrary.restore` reads this
     * browser's storage, `look` asks the server, and they finish in whichever
     * order the disk and the network happen to settle. A restore that finds
     * nothing kept here puts the flag down — correctly, as far as it can see —
     * and if it lands after this ran, a chapter that is plainly on screen would
     * be hidden behind the "No comic open" panel. Re-asserting it costs a
     * comparison and closes the race from this side.
     */
    if (rows.length && pages.value.length) {
      open.value = true

      // And the workspace's name for it, which `align` would have copied over
      // if it had had a page to work from.
      if (shared.value?.workspace.name) title.value = shared.value.workspace.name
    }
  }

  /**
   * Tell the server what the chapter is being translated into.
   *
   * Refused for anyone who may not change the workspace — the endpoint refuses
   * them too, and asking first is how the setting stops being offered rather
   * than being offered and then failing. A viewer still gets the language they
   * are shown; they simply cannot move it for everybody else.
   *
   * Best effort, like the page push: the language is already in force in this
   * browser, and a workspace the server has not heard about is the ordinary
   * case rather than a failure.
   */
  async function setTarget (locale: string) {
    if (!shared.value || !atLeast(shared.value.role, 'editor')) return false

    try {
      await $fetch(`/api/workspaces/${workspace.value}`, {
        method: 'PATCH',
        body: { targetLocale: locale },
      })

      shared.value = { ...shared.value, workspace: { ...shared.value.workspace, targetLocale: locale } }

      return true
    } catch {
      return false
    }
  }

  /**
   * Which way round the chapter reads, published for everybody working on it.
   *
   * `setTarget`'s twin, down to the editor check and the best-effort failure,
   * and for the same reason both of them are facts about the *chapter*: two
   * people sorting the same page in two directions would be two people looking
   * at the dialogue in two different orders.
   */
  async function setDirection (direction: 'ltr' | 'rtl') {
    if (!shared.value || !atLeast(shared.value.role, 'editor')) return false

    try {
      await $fetch(`/api/workspaces/${workspace.value}`, {
        method: 'PATCH',
        body: { direction },
      })

      shared.value = { ...shared.value, workspace: { ...shared.value.workspace, direction } }

      return true
    } catch {
      return false
    }
  }

  return {
    shared,
    standing,
    asking,
    look,
    refresh,
    align,
    showMissing,
    syncPages,
    fill,
    setTarget,
    setDirection,
    push,
    pageRowOf,
    forgetPage,
  }
}
