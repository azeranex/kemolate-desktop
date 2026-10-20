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
pnpm typecheck    # vue-tsc -b: app, main process and tests
pnpm test         # vitest, once
pnpm test:unit    # the node project only
```

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
    around `null`), `useSwarm`, `useBlockSync`, `useLiveSync` (their exports used on the
    server-row branch only), `utils/strokes.ts` (server stroke
    calls → "the server would not").
  - Partial ports at the original path, growing as their dependencies arrive:
    `canvas/Board.vue` (the view — fit, zoom, pan, wheel, keys — and block boxes; no plates,
    grips or lettering yet, so a cleaned page does not show its repairs),
    `pages/w/[workspaceId].vue`
    (opening, restoring, the reading and repairs restore, paging, zoom),
    `server/database/index.ts` (row types only).
  - Until the desktop key store exists: `useProviderKeys` (refuses aloud; only the Google
    Vision reader asks).
  - Pending UI: `AppMenu.vue`'s composable stand-ins, `usePanelDock`'s `pending()` panels.
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
it is pure, and `useOcr` asks `atLeast` on its cloud branch.) Provider keys
will live in the OS credential store instead. The header has no account menu, and the mark is
not yet a link (the workspace collection has not been migrated).

## Electron

- `titleBarStyle: 'hidden'`, not `frame: false` — keeps resize borders, snap and rounded
  corners. The title bar (`TitleBar.vue`) is a drag region; one rule in `tailwind.css`
  (`.app-titlebar`) takes every control in it back out. Windows/Linux draw their own window
  controls at the right; macOS keeps the traffic lights at the left.
- The renderer is sandboxed with context isolation; `electron/preload.ts` is the whole of
  what it can ask for. Add a named method there per need — no raw `ipcRenderer`.
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
