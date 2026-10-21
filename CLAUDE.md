# CLAUDE.md

Kemolate as a desktop app: the web build (`../kemolate`) migrated onto Electron, for one
machine and one user. No cloud workspaces, no accounts, no peer-to-peer sharing — a chapter
travels as a `.kemolate` project file. Read `../kemolate/CLAUDE.md` for what the app *is*;
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
mounts under `<Suspense>`; `registerEndpoint` answers `fetch` only — `$fetch` still refuses.
Two things the Nuxt environment did that this one does by hand, and that fail quietly if lost:
`import.meta.client`/`.server`/`.dev` are written in by a transform (`define` does not reach
them under Vitest — every one read `undefined` and the app took its server branches), and
`setup.ts` calls `nuxtReady()` (no `main.ts` runs, so no `remember`ed setting ever loaded).
`test/app/tsconfig.json`, referenced from the root, is what makes `pnpm typecheck` cover them.

What did **not** come across from `test/nuxt/` is the cloud: the sync composables'
(`useBlockSync`, `useLayerSync`, `useLiveSync`, `useTranslationSync.frames`, `Paint.sync`),
`useShared`, `useSwarm`, `wire`, `vault`, the auth middleware, the read errands, a cloud
workspace's reading (`useOcr.persist`/`.measure`) and translation saves (`useTranslate.persist`),
and the payload tests — there is no Nuxt payload here. Tests that only *used* a cloud
workspace to exercise a run (`useTranslate.*`, `useAutoRun`, `useClean.run`) run on a local
one, and the readers' tests name Kemolate OCR where they named Manga OCR; each says so in its
header. A fix carried from the web build's tests should land at the same path under `test/app/`.

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
| `server/` *(to come)* | `server/` | the local data layer, run in the main process |

A file migrated from the web build goes to **the same path** here, so the two can be diffed
and a later fix in one can be carried to the other. Keep it that way.

## Migration rules

- **Copy, then change as little as possible.** Nuxt's auto-imports are recreated in
  `vite.config.ts` (`nuxtStyleImports`): Vue, VueUse, `app/composables`, `app/utils`,
  `shared/utils`, components by Nuxt's naming, shadcn-vue under the `U` prefix by the names
  each `components/ui/*/index.ts` exports. The aliases (`~`, `@`, `#shared`, `~~`) are the
  web build's. A ported file should need no new imports.
- **Nuxt's runtime is shimmed, so ported files stay verbatim.** `app/composables/nuxt.ts`
  provides `useState`, `useRoute`/`useRouter`/`navigateTo` (one in-memory route: `/` or
  `/w/<id>` — 34 files read `route.params.workspaceId`), `useNuxtApp`, `useCookie` (local
  storage), `$fetch` (refuses: no server), `useHead`, `onNuxtReady`. `import.meta.client`,
  `.server` and `.dev` are defined in `vite.config.ts`. Do not hand-convert these in a ported
  file — the first three files ported (`usePanelDock`, `useTools`, `useColorScheme`) were,
  before the shim existed, and say so.
- **What changes is said in the file**, in the house style (decisions, not syntax — see the
  web build's CLAUDE.md).
- **Unmigrated dependencies get stand-ins, never silent no-ops.** A stand-in is shaped so the
  original stays unchanged and reads it truthfully: things that need a chapter disable
  themselves; things that cannot, say so with a toast. Each stand-in names what replaces it.
  - Cloud-only, permanent: `useShared` (no shared workspace — every caller already steps
    around `null`), `useSwarm` (no room: `peers` is empty and a live stroke is told to
    nobody — `sendLive`, `onSwarmLive`), `useBlockSync`, `useLiveSync` (their exports used on the
    server-row branch only), `utils/strokes.ts` (server stroke
    calls → "the server would not"), `useUserSession` (nobody is ever signed in).
  - Nuxt's `<NuxtLink>` is `components/NuxtLink.vue`: an anchor that goes through
    `navigateTo`.
  - Partial ports at the original path, growing as their dependencies arrive:
    `pages/w/[workspaceId].vue`
    (opening, restoring, the reading and repairs restore, paging, zoom),
    `server/database/index.ts` (row types only),
    `composables/useLayerSync.ts` (the helpers others import — `useLayerClaims`, `stackOf`,
    `serverStacks` — without `useLayerSync()` itself; a local workspace's stacks are
    `useLayerCache`'s).
  - `ProjectImport.vue` keeps the dialog's openness apart from the file it asks about. In the
    web build's version, Import closed the dialog (reka's `DialogClose` runs its own click
    first), the close cleared the file, and nothing was imported. The web build has the same
    code, so it very likely has the same bug.
  - `pages/index.vue`, the list of workspaces: local workspaces only, its server branches
    never reached, its wording about signing in and "this browser" made true here. A launch
    lands in the last workspace (`App.vue`); the mark goes to the list. Leaving for the list
    unmounts the workspace as in the web build, and `useWorkspaceReset` lets go of its
    state when another is opened; Settings is drawn over the workspace instead.
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
  - `panel/Text.vue` says earlier wordings are not kept here, where the web build says to
    move the workspace to the cloud (`useRevisions` keeps them only server-side).
  - `panel/Translate.vue` hides "Undo that run" without a server (`shared`): run revisions are
    kept only server-side, and `revertRun` on a local workspace reverts nothing, silently.
    That is a web build bug as well, reached there only by local workspaces.
  - Layer presets (Read / Clean / Letter / Final) work on a local chapter. The web build's
    need a shared workspace — the server's `layers.preset` reaches the pages not on screen —
    so `useLayerPresets` has a local branch: every page's stack is arranged in memory by
    `stageStack` (`shared/utils/presets.ts`, the server's allowlist restated) and
    `useLayerCache` writes them. A page the cache had not looked up when the stage was
    pressed is staged as it lands (`stageArrival`), or its saved stack would undo the press.
    The server branch is kept for a shared workspace.
  - `WorkspaceSettings.vue` and `useWorkspaceName` are their local halves: name, reading
    direction and what is kept where; no move to or from the cloud.
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

From `shared/`: `abilities`, `socials`, and the `auth`, `invite`, `token`, `vault` schemas —
accounts and the server-sealed key vault are cloud concerns. (`roles` came across after all:
it is pure, and `useOcr` asks `atLeast` on its cloud branch.) Provider keys live in the OS
credential store instead (`electron/keys.ts`), and Settings is File › Settings… (Ctrl+,)
rather than the account menu. The header has no account menu.

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
- The profile folder is pinned to `%APPDATA%\kemolate-desktop` (`app.setPath('userData')`
  in `main.ts`). Electron would name it after the product, and the installed app is
  "Kemolate" where a development run is "kemolate-desktop" — two folders, two sets of
  workspaces, keys and models. Never let it follow the product name.
- Files in and out, natively:
  - **Open folder** is the File System Access picker (its native dialog says "Select a folder
    this site can view" — Chromium's words, not ours). A permission *check* handler in
    `main.ts` (`keepFolderAccess`) answers read checks from the app's origin with yes, so a
    folder chapter is read again on the next launch instead of waiting behind "Reopen folder".
  - **Saving** a project or an export goes through the web build's link-to-a-Blob download;
    `electron/downloads.ts` titles the native Save dialog for what is saved, filters it to
    the kind, and opens it in Documents, then the last folder used.
  - **A `.kemolate` from the OS** — on the command line, from a second launch (single-instance
    lock, built app only), or macOS's `open-file` — is queued by `electron/opening.ts`, served
    once at `/opened/<token>` on the app's origin, and opened by `useOpenedFiles` in a new
    workspace, as a project dropped on the workspace list is. Registering the file type with
    the OS is the installer's job and not done yet.
  - Testing these: a picker needs a real user gesture (CDP's `Runtime.evaluate` with
    `userGesture: true`), and Chromium hosts the native dialog in a separate process.
- Provider keys: `keys.json` in the profile, each key encrypted by `safeStorage` (DPAPI,
  Keychain, the Linux keyring). There is no write in the clear — where the OS has no real
  encryption (Linux's `basic_text`), saving refuses and Settings says why.
- The Electron build is the inline plugin at the bottom of `vite.config.ts`, not
  vite-plugin-electron or electron-vite. Its header says how dev and build work.
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
