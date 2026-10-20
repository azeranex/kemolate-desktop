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
- **What changes is said in the file**, in the house style (decisions, not syntax — see the
  web build's CLAUDE.md): `useState` → module-level state, `useCookie` → `localStorage`
  (no server render, so read synchronously before the first paint), `import.meta.dev` →
  `import.meta.env.DEV`, `import.meta.client` guards dropped.
- **Unmigrated dependencies get stand-ins, never silent no-ops.** A stand-in is shaped so the
  original template stays unchanged and reads it truthfully (see `AppMenu.vue`,
  `usePanelDock`'s `pending()` panels, `useTools`): things that need a chapter disable
  themselves; things that cannot, say so with a toast. Each stand-in names the line that
  replaces it.
- **Versions match the web build** where both use a package (VueUse 14, zod 4, vitest 4,
  TypeScript 5.x). VueUse 15 already broke a file that had not changed.

## Left out, deliberately

From `shared/`: `abilities`, `roles`, `socials`, and the `auth`, `invite`, `token`, `vault`
schemas — accounts, roles and the server-sealed key vault are cloud concerns. Provider keys
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
- Electron 44 fetches its binary on first run, not at install.
