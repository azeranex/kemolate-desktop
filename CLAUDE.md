# CLAUDE.md

Kemolate as a desktop app: the web build (`../kemolate`) migrated onto Electron, for one
machine and one user. No accounts and no peer-to-peer sharing — a chapter travels as a
`.kemolate` project file. A workspace's work is kept the way the web build keeps a cloud
workspace's, through the same composables and services, but in a SQLite file the main process
owns (see **The workspace database**). Read `../kemolate/CLAUDE.md` for what the app *is*;
this file is about how this repository differs from it.

## Commands

```bash
pnpm dev          # Vite + Electron; main restarts on edit, preload reloads the page
pnpm build        # vue-tsc, then renderer → dist/, main + preload → dist-electron/
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
`import.meta.client`/`.server`/`.dev` are written in by a transform (`define` does not reach
them under Vitest — every one read `undefined` and the app took its server branches), and
`setup.ts` calls `nuxtReady()` (no `main.ts` runs, so no `remember`ed setting ever loaded).
`test/app/tsconfig.json`, referenced from the root, is what makes `pnpm typecheck` cover them.

The sync composables' tests came back with the database (2026-10-21), as the web build has
them. What did **not** come across from `test/nuxt/` is the swarm and the accounts — `useSwarm`,
`wire`, `vault`, the auth middleware, the read errands — and the payload tests: there is no
Nuxt payload here. The readers' tests name Kemolate OCR where they named Manga OCR, and say so.
The server's tests are the web build's `test/unit/server/` on the same harness (an in-memory
database, the real migrations replayed), less every case about people, roles and the swarm.
A fix carried from the web build's tests should land at the same path here.

`electron . --smoke=out/smoke.png` opens the built window, saves a capture of it and quits —
the way to see the real window, title bar included, without anybody looking at it.

**Never start the dev server with Bash**; use the Browser preview tools (the config is
`kemolate-desktop` in `../kemolate/.claude/launch.json`). A renderer opened in the browser
pane has no `window.kemolate`, so window controls and anything else on the bridge are absent
there — check those inside Electron.

## Layout — the web build's, on purpose

| Here | Web build | Notes |
| --- | --- | --- |
| `app/` | `app/` | the renderer: components, composables, utils, layouts, assets |
| `shared/` | `shared/` | pure logic both sides use; explicit relative imports |
| `test/unit/` | `test/unit/` | node, mirrors the tree it covers |
| `test/app/` | `test/nuxt/` | the app's tests — see Commands |
| `electron/` | — | main process and preload (the bridge, `window.kemolate`) |
| `server/` | `server/` | the model store (`models.ts`), and the web build's data layer — `database/` (schema, relations, client, migrations) and `services/` — run by the main process, not a server; see **The workspace database** |

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
  `useHead`, `onNuxtReady`, and `definePageMeta` (ignored — `App.vue` decides layout and key). `import.meta.client`,
  `.server` and `.dev` are defined in `vite.config.ts`. Do not hand-convert these in a ported
  file — the first three files ported (`usePanelDock`, `useTools`, `useColorScheme`) were,
  before the shim existed, and say so.
- **What changes is said in the file**, in the house style (decisions, not syntax — see the
  web build's CLAUDE.md).
- **Unmigrated dependencies get stand-ins, never silent no-ops.** A stand-in is shaped so the
  original stays unchanged and reads it truthfully: things that need a chapter disable
  themselves; things that cannot, say so with a toast. Each stand-in names what replaces it.
  - Permanent: `useSwarm` (no room: `peerHeader` is `{}`, `peers` is empty, a live stroke is
    told to nobody and no change notice ever arrives — there is one window), and
    `useUserSession` (always signed in, as nobody in particular — see the database section).
  - Nuxt's `<NuxtLink>` is `components/NuxtLink.vue`: an anchor that goes through
    `navigateTo`.
  - `pages/w/[workspaceId].vue` is the desktop's page with the web build's open chain in it
    (`look`, `syncPages`, `showMissing`, the four syncs mounted, sizes filled) — not the web
    file, which also joins the swarm and serves MCP errands. Its `composing` wait asks once
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
  - Readers: no Manga OCR or Manga OCR 2025 (`READERS` in `utils/ocr/readers.ts`), and
    Kemolate OCR is the default (`useOcr`). Their code is kept; an entry put back brings
    one back. Kemolate OCR's weights (`kemolate/…`, ours, never asked of the Hub) are
    downloaded from `OWN_MODELS` in `server/models.ts` — **not decided yet, so empty**
    (`KEMOLATE_MODELS_URL` overrides it). Until it is set, a fresh install's first read says
    in words that the reader is not here (`loadBeta` in `ocr/manga.ts`); on the dev machine
    the run's export (`E:\ml\export\out26-web`) is copied in by hand at
    `kemolate/kemolate-ocr-out26/resolve/main/` under the model store
    (`%APPDATA%\kemolate-desktop\models`, or `.data/models` in dev).
  - `utils/export/letters.ts` waits for the faces inlined into a lettering plate's SVG before
    drawing it (`facesIn`): `decode()` does not, and the first export of a session came out in
    the fallback face with lines that no longer fitted their balloons clipped away. The web
    build's file draws at once, so it very likely does the same.
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
- The page's CSP is the meta tag in `index.html`. `connect-src` names the two services the
  renderer talks to directly — `translate.googleapis.com` (the Google engine) and
  `openrouter.ai` (the AI engines and the model list); a new one has to be added there.
