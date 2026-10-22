# CLAUDE.md

Kemolate as a desktop app: the web build (`../kemolate`) migrated onto Electron, for one
machine and one user — public at [azeranex/kemolate-desktop](https://github.com/azeranex/kemolate-desktop),
released through GitHub Releases that installed copies update themselves from. No accounts and no peer-to-peer sharing — a chapter travels as a
`.kemolate` project file. A workspace's work is kept the way the web build keeps a cloud
workspace's, through the same composables and services, but in a SQLite file the main process
owns (see **The workspace database**). Read `../kemolate/CLAUDE.md` for what the app *is*;
this file is about how this repository differs from it.

## Commands

```bash
pnpm dev          # Vite + Electron; main restarts on edit, preload reloads the page
pnpm build        # vue-tsc, then renderer → dist/, main + preload → dist-electron/, then build:mcpb
pnpm build:mcpb   # the Claude Desktop bundle → out/mcpb/kemolate.mcpb (see The MCP server)
pnpm preview      # run the built app
pnpm dist         # build, then the installer (electron-builder → release/)
pnpm dist:dir     # build, then the packaged app unpacked (release/win-unpacked) — no installer
pnpm typecheck    # vue-tsc -b: app, main process and tests
pnpm lint         # eslint, the web build's rules; --fix handles most of it
pnpm test         # vitest, both projects, once
pnpm test:unit    # the node project only
pnpm test:coverage  # both, with coverage into out/coverage — and the floor in vitest.config.ts
pnpm db:generate  # a migration from server/database/schema.ts — read it for `__new_` first
```

**Lint is the web build's** — `eslint.config.mjs` is its file, rule for rule, with the
one part that came from Nuxt (`.nuxt/eslint.config.mjs`) rebuilt from `@nuxt/eslint-config`,
which runs standalone, and the auto-imports read as globals from `app/auto-imports.d.ts`. A
file carried across verbatim passes as it did there; keep it that way, so a lint failure
here always means desktop code.

**Tests are vitest, in two projects** (`vitest.config.ts`): `unit` (node, `test/unit/`, for
`shared/` and `server/`) and `app` (happy-dom, `test/app/`, for anything in `app/`). `app` is
the web build's `test/nuxt/`, carried across with one rename — there is no Nuxt here, so it
runs on the app's own Vite plugins (Vue, the auto-imports, the components), and what the tests
asked of `@nuxt/test-utils/runtime` is `test/app/support/`, aliased under that name so the
files are unchanged: `mockNuxtImport` is a transform into `vi.mock` of the module the name is
auto-imported from (`mockNuxtImport.ts`, reading `app/auto-imports.d.ts`); `mountSuspended`
mounts under `<Suspense>`; `registerEndpoint` answers `fetch`, which is also what `$fetch` uses
when there is no bridge (`composables/nuxt.ts`) — so it answers the app's requests as Nuxt's
did, and an `/api/` path nobody registered is a 404, never a connection. `setup.ts` *assigns*
`fetch` rather than `vi.stubGlobal`ging it: tests that `vi.unstubAllGlobals()` took it away
mid-file, and every later request went to the network.
Two things the Nuxt environment did that this one does by hand, and that fail quietly if lost:
`import.meta.client`/`.server`/`.dev` are written in by a transform (`nuxtFlagsInCode`, see
**Migration rules**), and `setup.ts` calls `nuxtReady()` (no `main.ts` runs, so no
`remember`ed setting ever loaded).
`test/app/tsconfig.json`, referenced from the root, is what makes `pnpm typecheck` cover them.

The sync composables' tests came back with the database (2026-10-21), as the web build has
them. What did **not** come across from `test/nuxt/` is the swarm and the accounts — `useSwarm`,
`wire`, `vault`, the auth middleware — and the payload tests: there is no
Nuxt payload here. The readers' tests name Kemolate OCR where they named Manga OCR, and say so.
The server's tests are the web build's `test/unit/server/` on the same harness (an in-memory
database, the real migrations replayed), less every case about people, roles and the swarm.
The MCP server's came across with it (2026-10-22: `relay`, `reading`, `brief`, a tool's), with
`useReadErrands`', and `test/unit/server/mcp/index.test.ts` is the desktop's own — the
registration that stands in for the toolkit, through a real SDK client.
A fix carried from the web build's tests should land at the same path here.

`electron . --smoke=out/smoke.png` opens the built window, saves a capture of it and quits —
the way to see the real window, title bar included, without anybody looking at it.

**Never start the dev server with Bash**; use the Browser preview tools (the config is
`kemolate-desktop` in `../kemolate/.claude/launch.json`). A renderer opened in the browser
pane has no `window.kemolate`, so window controls, the database and anything else on the
bridge are absent there — check those inside Electron.

**`pnpm dev` runs on the reader's real profile** (`%APPDATA%\kemolate-desktop`), the same one
the installed app uses, and only one of them can hold it at a time (see **One window per
profile**). Its window is served from `http://localhost:5173`, a different origin from the
built app's, so it has its own IndexedDB and OPFS: chapters opened in the installed app show
their pages as absent there until their folder is given again — their work is in the shared
database. To drive a dev window from a test, start a second Electron against the running dev
server on a test profile (`KEMOLATE_DEV_URL=http://localhost:5173/` with `KEMOLATE_PROFILE`);
never attach to the reader's.

## Layout — the web build's, on purpose

| Here | Web build | Notes |
| --- | --- | --- |
| `app/` | `app/` | the renderer: components, composables, utils, layouts, assets |
| `shared/` | `shared/` | pure logic both sides use; explicit relative imports |
| `test/unit/` | `test/unit/` | node, mirrors the tree it covers |
| `test/app/` | `test/nuxt/` | the app's tests — see Commands |
| `electron/` | — | main process and preload (the bridge, `window.kemolate`) |
| `mcpb/` | — | the Claude Desktop bundle: manifest, the stdio bridge, its build — see **The MCP server** |
| `plugins/kemolate/`, `.claude-plugin/` | — | the Claude Code plugin (the server's address and the Kemolate skill) and the marketplace that lists it — see **The MCP server** |
| `server/` | `server/` | the model store (`models.ts`), and the web build's data layer — `database/` (schema, relations, client, migrations) and `services/` — run by the main process, not a server; see **The workspace database**. `mcp/` and its `utils/` are the web build's MCP server; see **The MCP server** |
| `.github/workflows/` | — | CI on every push and pull request, and the release on a `v*` tag — see **Releases and updates** |

A file migrated from the web build goes to **the same path** here, so the two can be diffed
and a later fix in one can be carried to the other. Keep it that way.

## Migration rules

- **Copy, then change as little as possible.** Nuxt's auto-imports are recreated in
  `vite.config.ts` (`nuxtStyleImports`): Vue, VueUse, `app/composables`, `app/utils`,
  `shared/utils`, components by Nuxt's naming, shadcn-vue under the `U` prefix by the names
  each `components/ui/*/index.ts` exports. The aliases (`~`, `@`, `#shared`, `~~`) are the
  web build's. A ported file should need no new imports.
- **Nuxt's runtime is shimmed, so ported files stay verbatim.** `app/composables/nuxt.ts`
  provides `useState`, `useRoute`/`useRouter`/`navigateTo` (one in-memory route: `/`,
  `/w/<id>`, `/settings` or `/ocr-lab` — 34 files read `route.params.workspaceId`, which the
  last two keep), `useNuxtApp`, `useCookie` (local storage), `$fetch` (over IPC to the main process),
  `useHead`, `onNuxtReady`, and `definePageMeta` (ignored — `App.vue` decides layout and key). Do
  not hand-convert these in a ported file — the first three files ported (`usePanelDock`,
  `useTools`, `useColorScheme`) were, before the shim existed, and say so.
- **`import.meta.client`, `.server` and `.dev` are written into the code** by
  `nuxtFlagsInCode` (`vite.config.ts`), for dev, the build and Vitest alike — not left to
  `define`, which the production build applies and **the dev server and Vitest do not**. Left to
  `define`, every `import.meta.client` guard read `undefined` in dev: the page engine never
  asked for a device and no page was drawn (a grey sheet, fixed 2026-10-21); in the tests,
  `remember` never wired a setting.
- **One meaning per auto-imported name.** The auto-imports hold one export per name across
  `app/` and `shared/utils`, and a tie is a warning on every start and a bare name that means
  whichever won. Four ties were removed on 2026-10-21 by renaming the `app/` side —
  `useComic`'s `PageScan` and `PageBox` (`Scan` and `Box` in the web build) and `ocr/mask`'s
  `InkMask` (`Ink`), with its `Point` dropped for `shared/utils/raster`'s identical one. Check
  the dev server's output for "Duplicated imports" when adding an export.
- **What changes is said in the file**, in the house style (decisions, not syntax — see the
  web build's CLAUDE.md).
- **Unmigrated dependencies get stand-ins, never silent no-ops.** A stand-in is shaped so the
  original stays unchanged and reads it truthfully: things that need a chapter disable
  themselves; things that cannot, say so with a toast. Each stand-in names what replaces it.
  - Permanent: `useSwarm` (no room: `peerHeader` is `{}`, `peers` is empty, a live stroke is
    told to nobody; the only frames that arrive are an agent's — see **The MCP server**), and
    `useUserSession` (always signed in, as nobody in particular — see the database section).
  - Nuxt's `<NuxtLink>` is `components/NuxtLink.vue`: an anchor that goes through
    `navigateTo`.
  - `pages/w/[workspaceId].vue` is the desktop's page with the web build's open chain in it
    (`look`, `syncPages`, `showMissing`, the four syncs mounted, sizes filled) — not the web
    file, which also joins the swarm (the MCP errands are served here, by `useHolding` and
    `useReadErrands`). Its `composing` wait asks once
    before watching: the web build's `immediate` watch called `stop()` before `watch` had
    returned it whenever the page's reading was already there, which is every absent page —
    the web build very likely has the same bug.
  - `useLayerSync` is the web build's, with `flatten` lifted out as `layerDrafts` (for
    `useMoveIn`) and its `LayerDraft` taken from the schema: the window's project cannot load
    the services, which open the database.
  - `ProjectImport.vue` keeps the dialog's openness apart from the file it asks about. In the
    web build's version, Import closed the dialog (reka's `DialogClose` runs its own click
    first), the close cleared the file, and nothing was imported. The web build has the same
    code, so it very likely has the same bug.
  - `pages/index.vue`, the list of workspaces: the web build's script, signed in — listed
    from the database merged with the window's own index, made there first (`mint`) — and
    worded for one person: no roles, no Cloud or Local badge, no signing in. A launch lands
    in the last workspace, or the most recently changed one in the database when the window
    has no record of a last one (`App.vue`); the mark goes to the list. Leaving for the list
    unmounts the workspace as in the web build, and `useWorkspaceReset` lets go of its
    state when another is opened; Settings is drawn over the workspace instead.
  - The OCR lab (`pages/ocr-lab.vue`, verbatim but for its starting reader) is View › OCR
    lab, drawn over the workspace like Settings, inside `LabWindow` — the window's title
    bar, a way back (Escape too), and the same guard that keeps its key presses from the
    hidden chapter. The web build's lab is a URL with no layout; here that would be a
    window with no frame to move, close or leave. Its intro still quotes Manga OCR's
    download sizes, as the web build's does.
  - Readers: no Manga OCR, Manga OCR 2025 or Lab (`READERS` in `utils/ocr/readers.ts`), and
    Kemolate OCR is the default (`useOcr`). Their code is kept; an entry put back brings
    one back. Kemolate OCR's weights (`kemolate/…`, ours, never asked of the Hub) are
    downloaded from `OWN_MODELS` in `server/models.ts`, the project's Hugging Face account —
    **published 2026-10-21 as [azeranex/kemolate-ocr](https://huggingface.co/azeranex/kemolate-ocr)**
    (`KEMOLATE_MODELS_URL` overrides it, for a test's stand-in). Kemolate OCR is one
    repository, each build a tag on it that is never moved and `main` the newest, and
    `ownSource` turns the app's `kemolate-ocr-out26/resolve/main/…` into
    `kemolate-ocr/resolve/out26/…` — the build stays in the name inside the app because every
    cache trusts a path never to change. A release: the build's files and the model card in
    `out/hf/kemolate-ocr/` (prepared by hand; the card lists every tag), `hf upload
    azeranex/kemolate-ocr . . --type model`, then `hf repos tag create azeranex/kemolate-ocr
    <build> --revision <the upload's commit>`, then the app's `KEMOLATE_OCR_BETA_MODEL`. A
    fresh install downloads it on its first read (tested on a fresh profile against the real
    repo, the files byte-identical); one that cannot says the download failed
    (`loadBeta` in `ocr/manga.ts`). The fp16 detector (`kemolate/comic-text-and-bubble-detector-fp16`)
    is not published, and the full-precision one is used in its place.
  - `utils/export/letters.ts` waits for the faces inlined into a lettering plate's SVG before
    drawing it (`facesIn`): `decode()` does not, and the first export of a session came out in
    the fallback face with lines that no longer fitted their balloons clipped away. The web
    build's file draws at once, so it very likely does the same.
  - The model picker (`shared/utils/models.ts`, `useModels`): each Claude entry tracks its
    family (`AiModel.family`) and moves to the newest version in OpenRouter's public
    catalogue, never backwards, taking the reader's choice with it; a run reads the catalogue
    first (`useModels.current`, at most 3 s). OpenRouter's free models (ids ending `:free`,
    text out, price 0) are offered after the curated ones, from the catalogue each session; a
    free choice stays itself offline rather than falling back to the first, paid entry. Both
    added 2026-10-21; the web build's list is fixed ids.
  - `useProviderKeys` is the web build's with the passcode vault taken out: keys are kept by
    the OS (`electron/keys.ts`), so nothing is ever locked. `pages/settings.vue` is the web
    page's key section alone (no passcode, no access tokens), drawn *over* the open
    workspace — see `App.vue` and the page's header for why it stops every key press.
  - `panel/Text.vue` and `panel/Translate.vue` keep the web build's versions and "Undo that
    run" for a workspace in the database; for one not moved in yet, Text says it will be when
    it opens, and Translate hides the undo, since `revertRun` reverts nothing without rows —
    silently, which is a web build bug for its local workspaces too.
  - Layer presets (Read / Clean / Letter / Final) work on a local chapter. The web build's
    need a shared workspace — the server's `layers.preset` reaches the pages not on screen —
    so `useLayerPresets` has a local branch: every page's stack is arranged in memory by
    `stageStack` (`shared/utils/presets.ts`, the server's allowlist restated) and
    `useLayerCache` writes them. A page the cache had not looked up when the stage was
    pressed is staged as it lands (`stageArrival`), or its saved stack would undo the press.
    The server branch is what a workspace in the database takes.
  - `useWorkspaceName` is the web build's; `WorkspaceSettings.vue` drops its switch to and
    from the cloud — a workspace moves into the database on its own (`useMoveIn`).
  - A workspace keeps the name its reader gave it (`Workspace.named` in `useWorkspaces`),
    laid over the chapter on every open by the workspace page. Opening names a chapter after
    its folder, and in the web build a renamed local workspace went back to that on reload.
    An imported project's title becomes the name (`useProjectFile`).
  - Every panel has come across; there is no placeholder left in the dock or the menus.
- **Component names follow Nuxt's rule** — `canvas/Engine.vue` is `CanvasEngine`. If a new
  component resolves under a bare name, check `app/components.d.ts`: the plugin drops folder
  prefixes when given `globs`, which is why it is configured with `dirs` and `excludeNames`.
- **Versions match the web build** where both use a package (VueUse 14, zod 4, vitest 4,
  TypeScript 5.x). VueUse 15 already broke a file that had not changed. transformers.js is
  pinned **exactly** (4.2.0) because it must resolve the same `onnxruntime-web`
  (1.26.0-dev) the app pins — a caret range pulled 4.3.1 and a second runtime version.

## Left out, deliberately

From `shared/`: `socials`, and the `auth`, `invite`, `token`, `vault` schemas — accounts and
the server-sealed key vault. `roles` is the web build's; `abilities` is the desktop's own,
names only, since `must` allows everything (see the database section). Provider keys live in the OS
credential store instead (`electron/keys.ts`), and Settings is File › Settings… (Ctrl+,)
rather than the account menu. The header has no account menu.

## The workspace database

Decided 2026-10-21, the day a reader lost a 114-page chapter's reading and translation:
everything a desktop workspace kept lived in the window's IndexedDB, and Chromium answers a
corrupt IndexedDB by deleting it and starting empty, without a word. Now a workspace's record —
pages, blocks, translations with every revision, layer stacks, strokes, glossary, cast,
cleaned repairs' rows — is `<profile>/kemolate.db`, and its pictures stay the reader's files.

- **The web build's cloud half, on this machine.** Its composables keep a workspace on the
  server when signed in; here the window is always signed in (`useUserSession`) and `$fetch`
  goes over IPC (`window.kemolate.data.call`) to `electron/data.ts`, a table of the web
  build's routes — same method and path, same zod schemas, same service calls — answering as
  JSON would have (dates as strings), a repair as bytes, a refusal as `{ status, message,
  data }` that `$fetch` throws as ofetch's `FetchError`. No HTTP server, no router. A route
  added in the web build is a row added there, beside the one it copies; logic stays in the
  services.
- **The services are the web build's, verbatim where they can be.** Different on purpose:
  `access.ts` (one person: `contextFor` finds the workspace, `must` allows everything,
  `notify` tells nobody), `workspaces.ts` (no owner or contributors; `listAll`), `repairs.ts`
  (its store is `server/utils/repairStore.ts`, files under `<profile>/repairs`, not Nitro's
  storage), `logs.ts` (no user join). `createError` and `useEvent` are globals the main
  process installs (`server/utils/errors.ts`), as Nitro's auto-imports were.
- **Schema and migrations are the desktop's own**: the web build's workspace tables without
  users, accounts, passkeys, contributors, invitations, tokens, vaults or site settings, and
  author/user columns kept with no foreign key (always null). `pnpm db:generate` writes a
  migration with drizzle-kit; applied at every launch by Drizzle's migrator, shipped as
  `extraResources` (`resources/migrations`). The web build's rule stands and matters more
  here: read the generated SQL for `__new_` before shipping — a table rebuild inside the
  migrator's transaction fires every cascade.
- **`server/database` opens the file the moment it is imported**, so `electron/database.ts`
  sets `DATABASE_URL` and imports it dynamically, and `main.ts` imports `data.ts` only
  after the database is open. The window's project maps `~~/server/database` to
  `schema.ts` (row types only) and never imports a service.
- **A damaged file is never deleted** (`electron/database.ts`). `PRAGMA quick_check` before
  it is trusted; a file that fails, will not open, or is empty is moved aside as
  `kemolate.db.corrupt-<time>` and the newest backup that passes is put in its place, and
  the window says so in a toast that stays. Backups are `VACUUM INTO` copies under
  `<profile>/backups` — at launch if the newest is over an hour old, before any migration,
  hourly while there were writes, on quit — a day of them kept, then the newest of each day
  for 30, never fewer than three. The repair sweep spares every hash a backup names.
  Settings › Your data (`SettingsData.vue`) shows them, makes one, and restores one at the
  next launch (the app relaunches), keeping the replaced file as `kemolate.db.replaced-<time>`.
- **Workspaces from before move in on their own** (`useMoveIn`), the first time they are
  opened, from the end of a restore pass that began with every page hashed — one that began
  with a page unhashed had skipped that page's reading. `toCloud` carries the record, pages,
  readings, translations, glossary and cast; the move adds every page's layer stack and
  strokes, which `toCloud` leaves to go up as each page is shown. The IndexedDB copy is left.
- **What a lost window storage costs now**: the chapter's pictures, which come back by
  opening their folder or giving each page its file (`CanvasAbsent`, `useLibrary.link`), and
  this window's small records (last workspace, last page, settings). The work is in the
  database, and the pages are shown with it, absent (`useShared.showMissing`).
- Verified on test profiles only (`KEMOLATE_PROFILE`, see below): a workspace's record
  written and read back, kept across a relaunch and a deleted IndexedDB, a workspace made by
  the build before the database moved whole, a damaged file set aside and restored, and a
  restore through Settings.

## The MCP server

Added 2026-10-22: the web build's `/mcp` — an agent in somebody's editor lists the chapters,
has pages read by the app's own OCR, checks and corrects the reading, and translates — served
by the main process on the loopback, for an MCP client on this machine. Read the web build's
**MCP** section first; this is how the desktop differs.

- **The tools, the prompt and their utils are the web build's files at the same paths**
  (`server/mcp/tools/`, `prompts/`, `server/utils/{brief,errand,relay,reading}.ts`), verbatim
  but for `list_workspaces` (`listAll`, no contributors) and the refusal `noHolder` gives, said
  of a window. A tool added there is a file copied here and a line in `server/mcp/index.ts`,
  which lists them by hand (the toolkit discovers them) and holds the server instructions
  (`mcp.instructions` in the web build's `nuxt.config.ts`). The toolkit's auto-imports
  (`defineMcpTool`, `jsonResult`, `imageResult`) and `mcpJson` are globals
  (`installMcpGlobals`), installed before a tool loads. `@modelcontextprotocol/sdk` is pinned
  to the version the web build's toolkit resolves.
- **`electron/mcp.ts` is the server**: `node:http` on 127.0.0.1, stateless (one `McpServer` per
  request, as the web build's `sessions` off), each request inside its own event
  (`useEvent`, an `AsyncLocalStorage`). **Off until Settings › Agents turns it on**
  (`SettingsMcp.vue`); `mcp.json` in the profile keeps on/off and the port (default 38427).
  **No token** (decided 2026-10-22, by the reader): the first version had one, kept as a digest
  like the web build's access tokens, and on one person's machine it kept going wrong — made in
  one app, pasted into another — while guarding only against programs that could read the
  profile anyway. Who may come in is the loopback: it listens on 127.0.0.1 and refuses any
  other remote address (`loopback`). Still refused: a `Host` that is not the loopback (DNS
  rebinding), any `Origin` (a web page), anything but POST `/mcp`. The actor checks
  (`mcpEnabled`, `requireMcpActor`) stay, so the tools read as the web build's; every caller
  that comes in passes them. `serverFor` still answers `tools/list` and `tools/call` itself
  for a caller offered nothing, since the SDK says "Method not found" then — the bridge once
  read that as Kemolate not running.
- **The window is the swarm's one peer.** `server/utils/swarm.ts` keeps the web build's
  `swarmState` shape so `errand`, `relay` and `reading` stay verbatim: the workspace page
  says which scans it holds (`useHolding` → `mcp:have`), a frame for it goes over IPC
  (`mcp:frame`, with the workspace it was asked under), and `useSwarm` handles `render` and
  `read` as the web build's `handle` does — answering through `/relay/:request` and
  `/reading/:request`, rows in `electron/data.ts` (a rendition's type as `?type=`; `$fetch`
  carries no headers). The window holds one workspace or none; a navigation or reload forgets
  it (`leaving` in `main.ts`). The scans never leave the reader's files but as these
  renditions, as the web build's invariant says.
- **The open chapter is the default** (added 2026-10-22, the desktop's own). The window also
  says which page is on screen, by its row (`useHolding`, `rowOfPage`), kept as
  `swarmState.active`. `get_active_workspace` answers what is open, and `defaulted` in
  `server/mcp/index.ts` makes every tool's `workspaceId`, and a one-page tool's `pageId`,
  optional at registration — an id given is used as given; a missing one is the open chapter, and
  the page on screen only within it. The tool files stay the web build's. Nothing open is a 409
  that says to name one, never a guess.
- **An agent can letter, not only translate** (added 2026-10-22, the desktop's own):
  `set_lettering_style` sets lines' `style` — face, size, line, spacing, stroke, weight,
  alignment, anchor, vertical, ink, outline, shape — merged field by field (null is automatic,
  `reset` starts over), checked by `letteringStyleSchema`. Its write is `translations.restyle`,
  which sets the style column alone: `putOnPage` as a person re-signs and pins a line, which
  restyling it is not. Sizes are scan pixels, the Lettering panel's numbers. `read_page` reports
  a line's style where it has one — the one change to that web build file.
- **A balloon's frame for an agent to set** (2026-10-22): `set_lettering_style` also takes a
  `frame` — the lettering's own box (`translations.restyle` writes it beside the style; null
  hands the line back to its room) — and `read_page` reports each block's `room` and each
  line's `frame`. The tool's description tells an agent how to fix tiny type in a big balloon.
- **An agent can see the lettering** (2026-10-22). A line's size is measured in the window and
  never stored, and `get_page_image` was the scan, so an agent fixing lettering was working
  blind. Two more errands to the window, on the same registry as the relay (`errand.ts`):
  `fits` (`server/utils/fits.ts`, answered by `useLetteringErrands` through `/fits/:request`
  in `data.ts`) fits a page as an export does and reports each line's size, what decided it
  (`auto`, `standard`, `chosen`), its squeeze, and its `capacity` (`useLetteringFit.capacityOf`:
  the size its frame allows with nothing holding it); and `render` with `lettered`, the page
  as `usePageExport.preview` draws it, cropped by `renditionOf` like a scan, the drawn page kept
  15 s for the next crop. `review_lettering` joins them in one call — flags (does-not-fit,
  squeezed, small-for-its-balloon, smaller-than-the-page; a line held to the standard is never
  "small") and a lettered crop of each flagged balloon; `get_page_image` takes `lettered`.
  Tested against the packaged app on a test profile: four lines measured and four lettered
  crops in 359 ms. The skill's "Reviewing lettering" section is the order to fix in — layout
  first, words last, a pinned line's rewording proposed rather than saved — and the rules of
  copyfitting (meaning, voice, glossary and set-ups kept).
- **The skill for agents using it** is `plugins/kemolate/skills/kemolate/SKILL.md` (added 2026-10-22): the
  order that saves images, which tool for which job, the coordinate and pinning rules, and the
  lettering fixes. Change it when a tool's behaviour changes — `index.test.ts` fails if it names a
  tool the server does not have. **One file, three ways in**, because a skill installs differently
  in every client and the MCPB manifest cannot carry one:
  - `get_guide`, a tool on the server, returns it (front matter stripped; read in with Vite's
    `?raw`), and the briefing every client gets says to call it first — so every client has the
    guide with nothing installed, and always the one for the tools it is talking to.
  - **Claude Code**: this repository is a plugin marketplace (`.claude-plugin/marketplace.json`)
    listing `plugins/kemolate`, which holds the skill and `.mcp.json` (the server at the default
    port). `claude plugin install kemolate --marketplace azeranex/kemolate-desktop` installs both;
    Settings shows it, or `claude mcp add` on another port. Both manifests pass `claude plugin
    validate`, and the plugin's loopback server connected (`mcp list`) — tested 2026-10-22 with
    the packaged app on a test profile. It installs from the pushed repository, so it is as current
    as `main` on GitHub.
  - **Claude's chat** (Desktop or web): Settings' **Save the skill for Claude** writes the ZIP the
    skill upload takes (`kemolate/SKILL.md` at the top; `electron/zip.ts`, stored, checked with
    Python's `zipfile`), uploaded under Customize › Skills with code execution on. No app can
    install a skill there by itself.
- **An agent's writes reach the window.** `mcpContext` gives its context `origin: 'agent'`, and
  `notify` (`access.ts`) sends those — and only those — to the window as `changed` frames, so
  `useLiveSync` and the rest re-read as for a collaborator. The window's own writes are not
  told back, as the web build spares the author.
- **Claude Desktop gets a bundle** (added 2026-10-22): `kemolate.mcpb`, an MCP Bundle, built by
  `pnpm build:mcpb` (`mcpb/vite.config.ts`: the bridge and the SDK into one file, the manifest
  with `package.json`'s version, `build/icon.png`, packed and validated by
  `@anthropic-ai/mcpb`, pinned) and carried by the installer (`extraResources`). Claude Desktop
  runs its servers over stdio, so `mcpb/bridge.ts` is a bridge to this server, on the port the
  reader enters in Claude Desktop's install dialog (`user_config`). It answers the handshake
  itself and asks Kemolate for every list and call, so it works whether Kemolate was open
  first or not: while Kemolate cannot be reached, or something else answers on its port, it
  offers one tool, `kemolate_status`, saying which and what to do, looks again every 5 s, and
  sends `tools/list_changed` when the real ones appear. A protocol error from a call is a
  refusal, not Kemolate gone. Settings' **Add to Claude Desktop** opens the file
  (`mcp:add-to-claude`), which Windows hands to Claude Desktop (the MSIX package) — tried on
  2026-10-22, at the reader's request; **Show the file** is for dragging it onto Claude
  Desktop's Settings › Extensions where nothing opens it. The manifest lists the tools statically for the
  install screen; `index.test.ts` keeps that list equal to the server's. The briefing is
  `server/mcp/instructions.ts`, importing nothing, so the bridge carries it without the tools.
  Manifest version 0.3: 0.4 adds only `uv` servers.
- Port 47615, the first default, could not be bound on the machine this was written on —
  nothing in 45000–48999 could, with no exclusion listed — and `EADDRINUSE` is said as
  "in use, or reserved".
- Verified 2026-10-22, over HTTP with the SDK's client: against the packaged build on a test
  profile, all sixteen tools and the prompt with no token, `list_workspaces`/`list_pages`
  (`reachable` true for the open chapter), `get_page_image` whole and by region relayed from the
  window, and the Origin, Host, path and GET refusals. The bundle's bridge, run as Claude Desktop
  runs it (`node server/index.mjs` over stdio, configured by environment): the status tool with
  Kemolate closed, then Kemolate opened after the bridge — the list change arrived and the
  tools, the prompt and `list_workspaces` came through. Then, installed on the reader's own
  profile, `get_active_workspace`, `list_pages` and `get_page_image` with no ids, against the
  chapter and page on their screen.
  **`request_page_read` was not run end to end** — its two halves are tested
  (`reading.test.ts`, `useReadErrands.test.ts`), the pass through the window was not.

## Releases and updates

Decided 2026-10-21: the repository is public on GitHub (`azeranex/kemolate-desktop`), and
releases are GitHub Releases the installed app updates itself from.

- **To release:** bump `version` in `package.json`, commit, then
  `git tag v<version> && git push origin main v<version>`. `.github/workflows/release.yml`
  checks the tag matches `package.json`, runs typecheck, lint and tests, builds, **creates the
  Release itself**, then `electron-builder --publish always` uploads the installer, its
  blockmap and `latest.yml` into it, and a last step fails the run unless the tag has exactly
  one release holding all three. `ci.yml` runs the same checks on every push to `main` and
  every pull request. Both run on Windows.
- **Why the workflow makes the Release:** electron-builder uploads in parallel, and each upload
  that finds no release creates one. v0.1.0 (the first, 2026-10-21) came out as two releases on
  one tag — the blockmap in one, the installer and `latest.yml` in the other — and was put
  right by hand. The fix has not run yet; the next release is its first test.
- **The app updates itself** (`electron/updates.ts`, `electron-updater`): checks 15 s after
  launch and every four hours, downloads in the background, then offers "Restart to update"
  (a toast, and Settings › Updates) — never restarts on its own, and otherwise installs on
  the next quit. The database is backed up on that quit and before any migration. Off in
  development and on a test profile (`KEMOLATE_PROFILE`).
- **Unsigned.** A first install from the Release page meets SmartScreen; updates do not,
  since the updater downloads them itself. macOS needs signing and notarisation first.
- `pnpm build` empties `dist-electron/` before building the main process: its chunks are
  hashed, dev builds write there too, and the installer packs the whole folder.
- Packaging into `release/` failed on 2026-10-21 with `EPERM` renaming `win-unpacked.tmp`,
  something holding the folder; `--config.directories.output=out/release` sidesteps it.

## Lettering in round balloons

Found 2026-10-22 on a real page: "the bubble is big but the text is really small".

- **A round balloon's room is its oval** (`ovalIn` in `utils/ocr/balloon.ts`, chosen in
  `rooms.ts`). The largest upright rectangle in an oval has the oval's proportions and under
  two thirds of its area, so a tall balloon's room was a strip barely wider than the Japanese
  column — and a horizontal translation was held to the width of its longest word. Now a
  balloon below `ROUNDISH` solidity whose oval holds at least the rectangle's area (its usable
  share, π/4) gets the oval, stored as `room.round` (a JSON field — no migration), and
  `shapeFor` wraps the line into an oval unless a shape was chosen or a frame was dragged.
  Centred on the interior's centroid with the nearer edge as each radius, so a tail moves
  nothing; 10% off the outline; shrunk until its rim is inside. An oval that would crowd a
  neighbour falls back to the rectangle (`RoomVerdict.square`), not to nothing. The OCR lab
  says "oval" on such a room. Existing chapters get it from Detect › Measure balloons.
  Measured on that page (Anime Ace): the line went from 13 px in its box to 17 in its oval;
  the other three balloons fill theirs.
- **A shape is measured 1% narrow** (`SHAPE_SLACK`, `utils/lettering.ts`): a shaped fit sits
  at the very edge, and the board, drawing at screen size, wrapped a line that had only just
  fitted — "HM? OH, YEAH, IT" with "IS." cut off. It was 4% at first, and that was a bug of
  its own: the probe then wrapped lines the page did not, its block of words was taller, and
  the pad worked out for it set the drawn words high in the oval. At 1% the drawn wrap matched
  the probe's at screen scale and full width alike (measured on the report's four balloons).
- **Where a shaped line's words sit is searched for** (`tryFit`, 2026-10-22). The web build
  nudged the spacer towards the anchor up to four times; in an oval each move re-wraps the
  lines, the block's height jumps, and the nudges stopped wherever they were — "This photo's
  going to be a family heirloom...!", anchored middle, had 7 px above it and 60 below, and a
  bottom anchor could be pushed out of the frame. Now the pad is halved towards the answer
  (middle: room above meets room below; bottom: the lowest pad that fits), and a size only
  counts as fitting if its words sit where the anchor says (`ANCHOR_SLACK`, 6%: the middle
  within that of even, the bottom no further above the middle) — the largest size that fits
  *somewhere* in an oval can fit only with its longest word across the widest line, dragging
  the rest to the top. A size or so smaller, centred, is the trade a letterer makes. In the
  window: 36 / 37 px above and below where it was 7 / 60. A bottom anchor sits at the middle
  when the words fill the oval — lower would mean smaller. A top anchor is unchanged: it
  starts in the oval's narrow crown, so a long line there is set small, as before.
  `FITS_VERSION` 11.
- **Hyphenation is ours, not the browser's** (`utils/hyphens.ts`, 2026-10-22). `hyphens:
  auto` needs a dictionary, and Chromium on Windows downloads its dictionaries through a
  component updater Electron does not have — three overflowing words in a 60 px box stayed
  three unbroken lines — so every fit's "hyphenated" rung was a no-op and a balloon whose one
  long word limited it ("NEIGHBORHOOD...") was set at that word's size. Now soft hyphens
  (U+00AD, which Chromium breaks at with no dictionary) are put in from TeX's patterns (the
  `hyphen` package, pinned; one chunk per target language, loaded on first use): measured with
  in the probe, drawn with on the board (`wordsOf` in `Sheet.vue`) and in export, never put in
  the stored or typed line. One break to a word, nearest its middle (a fragment like "BOR-" on
  a line of its own read badly), words of 7 letters and up. `fitSize` breaks a word when that
  sets the balloon at least 25% larger (`HYPHEN_GAIN`); `fitStandard`'s rung now works. Fits
  key on `HYPHENATION`, so changing where words break re-measures them — a stale fit drew the
  new breaks at the old size and cut the last line. The page from the report: 17 px → 25.

## One size for the voice, not the balloon

Decided 2026-10-23, from "text too big because the bubble is too big" and "what about a
bubble meant to be big".

- **The standard size is the chapter's, in the database** (`workspaces.lettering_standard`,
  an in-place `ADD COLUMN`; `workspacePatchSchema.letteringStandard`). The web build keeps
  it in the browser and names the gap; here `useLetteringStandard` reads it off the
  workspace record and writes it with `PATCH`. The window's IndexedDB copy stays — the
  answer for a workspace not moved in yet, and the first answer while the record loads —
  and a standard kept only there is carried up the first time the record arrives without
  one (`moved` marks it done). `workspaces.update` notifies `{ scope: 'workspace' }`, which
  `useLetteringStandard` answers by reading the record again. Tested on a test profile: an
  agent's standard re-fitted the open page at once, and a window-only 28 moved up on reload.
- **Emphasis** (`app/utils/emphasis.ts`): a line held to the standard is set at the standard
  × its emphasis. Measured from the *original*: each block's character pitch (its box shared
  out among its characters — the found box, never the frame or room), against the median
  over the chapter's dialogue and captions; 1.3× or more counts, to a tenth, at most 1.8×,
  and nothing with fewer than four blocks to measure. A big balloon with ordinary lettering
  is not emphasis. Per line, `Lettering.emphasis` (a style field: null measured, a number
  chosen, 1 none) — the Lettering panel's Emphasis row, `set_lettering_style`'s `emphasis`.
  Not automatic bold: bold is the reader's choice of face. On the test page the four
  originals measured 0.87–1.02 — all ordinary, as they look.
- **For agents**: `set_lettering_standard`; `review_lettering` reports `emphasis` and
  `measuredEmphasis`, flags **larger-than-the-page** (an automatic line over 1.3× the page's
  ordinary size whose original is ordinary; never a sound effect), and says to set a
  standard when the chapter has none. The skill's "One size for the voice" section.

## Line breaks a letterer types

Added 2026-10-23. A newline in a translation was always a hard break (`LETTERING_WRAP` is
`pre-wrap` for it), but the wrap ignored it as soon as a typed line was too wide, and at a
standard size the automatic wrap packs lines mid-phrase: "FIRST, LET / ME SHOW / YOU",
"HM? OH, / YEAH, IT / IS.".

- **Typed breaks are kept** (`keepsBreaks` in `utils/lettering.ts`): a fit of hand-broken
  text only counts a layout where the wrap added no break of its own — the probe reads
  where each word landed (`breaksOf`) — so the balloon is tightened or set smaller, down to
  the standard's floor, before a typed line is wrapped again; then it is, and the fit says
  `rewrapped`. Not hyphenated while its breaks hold; only as the last thing before not
  fitting at all. `FITS_VERSION` 12.
- **A review reports the lines as drawn** (`drawnLines`, via `useLetteringFit.linesOf`):
  each line's `drawn` in `review_lettering`, a word broken at a soft hyphen ending "-" —
  so an agent judges breaks from words, not pictures. `server/utils/breaks.ts` flags
  **stranded-word** (one word between two much longer lines), **lone-last-word** and
  **rewrapped**; a line flagged only for its breaks gets no crop. A phrase split across
  lines is left to the agent, who has the language.
- The skill's "Line breaks" section is the rules (one phrase a line, short-long-short, no
  pair split, no lone last word, compare the size before and after) and the fix: newlines
  through `save_page_translations` for a machine line, a proposal for a pinned one.
- Tested on the test page through MCP: the review flagged "YOU" and "IS."; re-broken by the
  rules the balloons came out exactly as `drawn` said — 27 / 26 / 28 / 28 px, no flags — and
  of two breakings of one balloon the rules' size check picked the larger (27 over 25).

## Electron

- `titleBarStyle: 'hidden'`, not `frame: false` — keeps resize borders, snap and rounded
  corners. The title bar (`TitleBar.vue`) is a drag region; one rule in `tailwind.css`
  (`.app-titlebar`) takes every control in it back out. Windows/Linux draw their own window
  controls at the right; macOS keeps the traffic lights at the left.
- The renderer is sandboxed with context isolation; `electron/preload.ts` is the whole of
  what it can ask for. Add a named method there per need — no raw `ipcRenderer`. A handler
  that hands back anything secret checks the asking frame is the app's origin (`trusted` in
  `main.ts`).
- The installer is electron-builder (`electron-builder.yml`): NSIS on Windows, `.kemolate`
  registered, icon `build/icon.png` (the app's mark, rendered from `Logo.vue`). Only `dist/`,
  `dist-electron/` and `package.json` are packed — Vite bundles every runtime dependency, so
  no `node_modules` goes in. Unsigned: SmartScreen warns until a certificate is configured.
  Per-user, into `%LOCALAPPDATA%\Programs\Kemolate`, no admin prompt; `/S` installs silently.
  `.kemolate` is registered under the ProgID `Kemolate.Project` (the association's `name`;
  its `description` is what Explorer shows). Tested installed on 2026-10-21: the app opens on
  the development profile, Save project writes through the native dialog, a `.kemolate`
  opened from the shell imports into a new workspace both cold and into a running app (which
  the second launch hands it to, then quits), and installing over an earlier build replaces
  its association rather than leaving the old ProgID behind.
- **CUDA is an opt-in second home for two models** (added 2026-10-21). The comic detector's
  `full` build and Kemolate OCR can run on an NVIDIA GPU through a separate process
  (`electron/cuda.ts`, `electron/cuda/kemolate_cuda.py`), on a Python with `onnxruntime-gpu`.
  The installer does not ship CUDA — gigabytes for one vendor's cards — so Settings
  (`SettingsCuda.vue`) offers **Set up CUDA**, one press, on Windows x64 with an NVIDIA card
  (`app.getGPUInfo`): `electron/cudaSetup.ts` fetches `uv` into `<userData>/cuda/`, has it
  install a managed CPython and a venv there, and `onnxruntime-gpu[cuda,cudnn]` into it — the
  extras are CUDA's and cuDNN's DLLs as wheels, so only the driver is needed — then points the
  setting at that Python, tests it and switches CUDA on. Nothing outside that folder is
  touched (`UV_NO_CONFIG`, its own Python and cache dirs), every version is pinned, and Remove
  deletes the folder. A reader's own Python can still be named under "Use another Python".
  Measured on an RTX 4090 with the app's own
  models: a whole Read page 0.40–0.46 s warm against WebGPU's 0.77–0.85, 2.9 s cold against
  5.4, the same text on every balloon. Why not DirectML, which `onnxruntime-node` does carry:
  measured too, it was slower than WebGPU for Kemolate OCR and won only on the detector.
  - The process speaks length-prefixed frames on its own stdin/stdout — no port — and is
    started on the first model asked of it, or by Settings' Test. Kemolate OCR's batch is read
    there whole (`read`): the encoder and the greedy decode together, by `readBatch`'s rules,
    which the script repeats — change one, change the other. Stepping it from the window would
    carry the encoder's states and the logits across the pipe at every token.
  - The window asks the switch afresh at every model load (`cudaWanted`), and keeps a CUDA
    build beside the WebGPU one in each `loadOnce` (`:cuda` in the key). Any failure — no
    Python, no CUDA in it, a crash mid-page — gives CUDA up for the session, says so once
    (`gaveUp`), and the same page is finished on WebGPU. A session onnxruntime quietly put
    on the CPU is refused rather than used: `preload_dlls()` is what makes CUDA's DLLs load.
  - The script is shipped beside the app (`extraResources` → `resources/cuda/`), not in the
    asar, which the reader's Python cannot read. Testing it: launch the app from PowerShell, as
    for anything that must see the real profile; the Python must be the reader's.
- **Anime Ace 3 is read from the OS first** (`local()` in `app/assets/css/fonts.css`). Its files
  are not in the repo (Blambot's terms), and a file dropped into `app/assets/fonts/` would be
  bundled into the installer — redistributing it. Installed on the machine, it is the reader's
  own copy, used on screen and inside export's SVG alike (tested 2026-10-21). Without it the
  dialogue falls back to Shantell Sans.
- **Tests never open the reader's profile.** `KEMOLATE_PROFILE` (`main.ts`) puts a run on a profile of
  its own, and the CDP harness sets it unless asked otherwise. On 2026-10-21 test runs against the
  real profile, from a sandbox that kept their writes but let their deletes through, corrupted its
  IndexedDB; Chromium answers a corrupt IndexedDB by deleting it and starting empty, and the
  reader lost a workspace's reading and translation. That is why the work is now in a database
  of the app's own (see above) — and still why tests never touch the reader's profile.
- The profile folder is pinned to `%APPDATA%\kemolate-desktop` (`app.setPath('userData')`
  in `main.ts`). Electron would name it after the product, and the installed app is
  "Kemolate" where a development run is "kemolate-desktop" — two folders, two sets of
  workspaces, keys and models. Never let it follow the product name.
- Files in and out, natively:
  - **Open folder** is the File System Access picker (its native dialog says "Select a folder
    this site can view" — Chromium's words, not ours). A permission *check* handler in
    `main.ts` (`keepFolderAccess`) answers read checks from the app's origin with yes, so a
    folder chapter is read again on the next launch instead of waiting behind "Reopen folder".
  - **Loose files and PDFs are kept where they are, not copied** (decided 2026-10-21). A drop
    or File › Open files… hands over a handle on each thing (`showOpenFilePicker` for the
    pick), and the chapter is kept as `kind: 'sources'` — the handles, each with the path its
    pages were filed under (`Source` in `utils/images.ts`) — and read out of them again on the
    next launch (`imagesOf`), by the same permission handler a folder uses. OPFS keeps only what
    the app itself made for such a chapter (a blank page, a file linked to a page) beside its
    caches; a page removed from a folder among the sources is remembered in `removed`. A file
    moved or deleted since is a page missing, said; every file gone keeps the workspace and its
    work, as a lost copy does (`resume`). Older chapters kept as `copy` still read back; a drop
    that brings no handles still falls back to one.
  - **Saving** a project or an export goes through the web build's link-to-a-Blob download;
    `electron/downloads.ts` titles the native Save dialog for what is saved, filters it to
    the kind, and opens it in Documents, then the last folder used.
  - **One window per profile, dev included** (`oneWindow` in `main.ts`, since 2026-10-21).
    Chromium's single-instance lock is per profile folder, and it is what keeps two processes
    off one workspace database — nothing tells one window about another's edits, so each
    would write back what it last loaded. A second launch hands its command line to the first
    and quits; in dev it retries for three seconds (the dev plugin waits for the old Electron
    to exit before restarting it, so this is only slack) and then says in the terminal that
    the profile is taken. `pnpm dev` and the installed app on the same profile cannot both
    run; give one of them `KEMOLATE_PROFILE`.
  - **A `.kemolate` from the OS** — on the command line, from a second launch (the lock
    above), or macOS's `open-file` — is queued by `electron/opening.ts`, served
    once at `/opened/<token>` on the app's origin, and opened by `useOpenedFiles` in a new
    workspace, as a project dropped on the workspace list is. The installer registers the file
    type with the OS (`electron-builder.yml`).
  - Testing these: a picker needs a real user gesture (CDP's `Runtime.evaluate` with
    `userGesture: true`), and Chromium hosts the native dialog in a separate process.
- Provider keys: `keys.json` in the profile, each key encrypted by `safeStorage` (DPAPI,
  Keychain, the Linux keyring). There is no write in the clear — where the OS has no real
  encryption (Linux's `basic_text`), saving refuses and Settings says why.
- The Electron build is the inline plugin at the bottom of `vite.config.ts`, not
  vite-plugin-electron or electron-vite. Its header says how dev and build work.
- The renderer's IndexedDB now holds only small records (the workspace index, which chapter
  and page were open, settings) and the reading of a workspace not yet moved into the
  database; OPFS holds the caches and the pages a chapter was copied into.
- The built app is served from `https://app.kemolate.invalid/` (`electron/protocol.ts`),
  not `file://`: OPFS and IndexedDB need an ordinary, stable origin, and a store is keyed by
  its origin — **never change the scheme or host**, or everything kept under the old one is
  lost. `https` rather than a custom scheme because transformers.js refuses to check that a
  file exists on anything but `http:`/`https:` (it was `app://kemolate` until that broke
  every tokenizer). Only that host is intercepted; `.invalid` never resolves. It sends the
  web build's COOP/COEP headers, as does the dev server.
- The same origin answers `/api/models/*` (the web build's model route — `server/models.ts`,
  cached under the app's profile; `.data/models` in dev) and `/ort/*` (ONNX runtime files,
  copied into `dist/ort/` by the build). `utils/ocr/onnx.ts` points both runtimes at `/ort/`
  instead of the web build's CDN — its one deliberate change.
- Each ONNX runtime must stay in **a chunk of its own** (`build.rolldownOptions` in
  `vite.config.ts`): the runtime starts its worker from its own module URL, and a runtime
  chunk that imports the app's main chunk loads the whole app in the worker — "no available
  backend found … [object ErrorEvent]".
- Verifying in the real window: drive the built app over CDP
  (`--remote-debugging-port`); a synthetic drop of `File`s onto the canvas opens a chapter
  through the same path as dropping loose pages.
- Electron 44 fetches its binary on first run, not at install.
- The window opens at 1920 × 1080 (or the work area, if smaller) the first time, and where it
  was after that — size, place, maximised, full screen — from `window.json` in the profile
  (`electron/windowState.ts`). Set with `setBounds`, and a read within two pixels of where it
  was put is taken as that place: either half alone left the window growing a few pixels a
  launch with the hidden title bar at 125%.
- A component that draws itself by its Nuxt name (`<PanelLayerRow>` inside `LayerRow.vue`)
  needs `defineOptions({ name })`: Nuxt registers components globally, but here they are
  imported where used and never into themselves, so the recursion rendered nothing — the
  Layers panel's groups came up empty. It is the only one so far; check for another when
  porting a tree.
- A component used in a template but never brought across renders its slot inline rather
  than failing — the Detect panel's `InfoTip` did, as five lines beside a switch. Check
  `app/components.d.ts` when a ported panel lays out oddly.
- The page's CSP is the meta tag in `index.html`. `connect-src` names the services the
  renderer talks to directly — `translate.googleapis.com` (the Google engine), `openrouter.ai`
  (the AI engines and the model list), `api.anthropic.com` (Claude on an Anthropic key) and
  `vision.googleapis.com` (the Google vision reader); a new one has to be added there. The
  updater and the model downloads run in the main process, which the CSP does not cover.
