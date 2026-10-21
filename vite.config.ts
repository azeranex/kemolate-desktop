/**
 * Vite builds the renderer; the plugin at the bottom of this file builds and
 * runs Electron around it. It is written here rather than taken from
 * vite-plugin-electron or electron-vite on purpose: what it has to do is small
 * and specific, and owning it means the dev loop can be read in one place.
 *
 * `vite` (dev)
 *   - serves the renderer with HMR as usual;
 *   - builds `electron/main.ts` and `electron/preload.ts` with Vite's own
 *     builder in watch mode, into `dist-electron/`;
 *   - starts Electron once both first builds land, pointed at the dev server;
 *   - a change to main restarts Electron, a change to preload reloads the page
 *     (a preload runs once per page load, so that is all it needs);
 *   - closing the app window stops the dev server, and stopping the dev server
 *     closes the app.
 *
 * `vite build`
 *   - builds the renderer into `dist/` with relative paths (it is loaded from
 *     disk, not served), then main and preload into `dist-electron/`, minified.
 *     `pnpm preview` runs the result. Packaging an installer is a separate step
 *     and not this plugin's job.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig, build as viteBuild } from 'vite'

import { answerModel, MODEL_HEADERS } from './server/models.ts'

import type { ChildProcess } from 'node:child_process'
import type { Plugin, ResolvedConfig } from 'vite'

// Forward slashes even on Windows: these paths are written into generated
// imports, where a backslash is an escape and `X:\repos` arrives as `X:epos`.
const root = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '')
const appDir = `${root}/app`

/**
 * The web build's aliases, so a file carried across keeps its imports: `~` and
 * `@` for the app, `#shared` for the code both sides of the app share, `~~` for
 * the root. The layout they point into is the web build's too — `app/`,
 * `shared/`, `test/` — so a path in one project is the same path in the other.
 */
export const aliases = {
  '@': appDir,
  '~': appDir,
  '#shared': `${root}/shared`,
  '~~': root,
}

/**
 * Nuxt's build-time flags, which the web build's files test as they are — a
 * desktop renderer is always the client, never the server, and is in
 * development exactly when Vite is. See `composables/nuxt.ts` for the runtime
 * half of the same arrangement. The app's tests take them too.
 */
export const nuxtFlags = (dev: boolean) => ({
  'import.meta.client': 'true',
  'import.meta.server': 'false',
  'import.meta.dev': JSON.stringify(dev),
})

export default defineConfig(({ mode }) => ({
  resolve: { alias: aliases },
  define: nuxtFlags(mode === 'development'),
  plugins: [vue(), tailwindcss(), ...nuxtStyleImports(), electron()],
  build: {
    rolldownOptions: {
      output: {
        /**
         * Each ONNX runtime in a chunk of its own, and the bundler's helpers in
         * a third.
         *
         * Both runtimes move inference into a worker (`wasm.proxy`, see
         * `utils/ocr/onnx.ts`), and start that worker from *their own module's
         * URL*. Bundled as it fell, each runtime's chunk imported the bundler's
         * interop helpers from the app's main chunk — so the worker loaded the
         * whole app, which reached for `document` and died, and every model
         * failed with "no available backend found … [object ErrorEvent]". In
         * their own chunks, a worker loads a runtime and nothing else; the
         * helpers' chunk is the one thing they import, and it runs nothing.
         *
         * The app's runtime is `onnxruntime-web` (`ortOnce`); transformers.js
         * brings `onnxruntime-web/webgpu` — two instances on purpose, see the
         * web build's CLAUDE.md.
         */
        codeSplitting: {
          groups: [
            { name: 'rolldown-runtime', test: /^\0rolldown\/runtime\.js$/ },
            { name: 'ort', test: /onnxruntime-web[\\/]dist[\\/]ort\.bundle\.min\.mjs$/ },
            { name: 'ort-webgpu', test: /onnxruntime-web[\\/]dist[\\/]ort\.webgpu\.bundle\.min\.mjs$/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // The web build's cross-origin isolation, in dev as in the built app (see
    // `electron/protocol.ts`): wasm gets SharedArrayBuffer, onnxruntime threads.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
}))

/**
 * Nuxt's auto-imports, recreated, so a file migrated from the web build reads
 * the same here as it did there — Kemolate's components and composables lean
 * on them everywhere, and adding hundreds of imports by hand would make every
 * ported file a diff against its original instead of a copy of it.
 *
 * - Vue's and VueUse's functions, and everything exported from the top level of
 *   `app/composables/`, `app/utils/` and `shared/utils/`, types included
 *   (`DockSide` in a prop type).
 * - Components by Nuxt's rule: a folder is a prefix, and a prefix the file name
 *   already starts with is not repeated — `dock/DockColumn.vue` is `DockColumn`,
 *   `panel/Blocks.vue` is `PanelBlocks`.
 * - shadcn-vue's components under the web build's `U` prefix — `UButton`,
 *   `UAccordionItem` — whichever folder of `components/ui` holds them.
 */
export function nuxtStyleImports () {
  const uiDir = `${appDir}/components/ui`

  /**
   * Every shadcn-vue component by the name its folder's `index.ts` exports it
   * under — which is what the web build's Nuxt module registers, and is not
   * always the file's name: `sonner/index.ts` exports `Sonner.vue` as `Toaster`,
   * so the app writes `<UToaster>`. File names are the fallback, for a folder
   * whose index does not re-export a component.
   */
  const scan = () => new Map(readdirSync(uiDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) => {
      const folder = `${uiDir}/${dir.name}`
      const byFile = readdirSync(folder)
        .filter((file) => file.endsWith('.vue'))
        .map((file) => [file.slice(0, -4), `${folder}/${file}`] as const)
      const index = existsSync(`${folder}/index.ts`) ? readFileSync(`${folder}/index.ts`, 'utf8') : ''
      const byExport = [...index.matchAll(/export \{ default as (\w+) \} from '\.\/(\w+)\.vue'/g)]
        .map(([, name, file]) => [name!, `${folder}/${file}.vue`] as const)
      return [...byFile, ...byExport]
    }))

  // Read again on a miss: the list was taken once, at config load, so a
  // component added while `pnpm dev` ran (`shadcn-vue add`) stayed unresolved
  // until a restart — `UMenubar` rendered as an unknown element.
  let ui = scan()
  const find = (name: string) => ui.get(name) ?? (ui = scan()).get(name)

  return [
    AutoImport({
      imports: ['vue', '@vueuse/core'],
      // `shared/utils` as well, which Nuxt auto-imports into the app too.
      dirs: ['./app/composables', './app/utils', './app/utils/ocr', './shared/utils'],
      dirsScanOptions: { types: true },
      vueTemplate: true,
      dts: './app/auto-imports.d.ts',
    }),
    Components({
      // `dirs`, not `globs`: given globs at all, the plugin drops the folder
      // prefix and named `canvas/Engine.vue` `Engine` rather than `CanvasEngine`.
      // `ui/` is scanned with the rest and its names refused below — the `U`
      // resolver owns those, under the names their folders export.
      dirs: ['app/components'],
      excludeNames: [/^Ui[A-Z]/],
      directoryAsNamespace: true,
      collapseSamePrefixes: true,
      resolvers: [(name: string) => {
        const file = name.startsWith('U') ? find(name.slice(1)) : undefined
        return file ? { from: file } : undefined
      }],
      dts: './app/components.d.ts',
    }),
  ]
}

/** The Electron processes' entries, and the format each has to be in. */
const ENTRIES = [
  // An ES module main, which Electron loads as such from the `.mjs` extension.
  { name: 'main', entry: 'electron/main.ts', format: 'es', file: 'main.mjs' },
  // A sandboxed preload cannot be an ES module — Electron requires CommonJS there.
  { name: 'preload', entry: 'electron/preload.ts', format: 'cjs', file: 'preload.cjs' },
] as const

type Entry = typeof ENTRIES[number]

const OUT_DIR = 'dist-electron'

/** The web build's cross-origin isolation, for everything served beside the page. */
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
} as const

/** The ONNX runtime's wasm builds and their loaders — what `ort.env.wasm.wasmPaths` points at. */
const ORT_FILE = /^ort-wasm[\w.-]*\.(?:wasm|mjs)$/

/**
 * Where the pinned onnxruntime-web keeps them — the one copy both runtimes
 * load, since transformers.js is pinned to the same version (see
 * `utils/ocr/onnx.ts`). Found through the app's own dependency, so it is the
 * version in `package.json` and not whichever a hoisting happened to pick.
 */
function ortDist () {
  const entry = createRequire(import.meta.url).resolve('onnxruntime-web').replaceAll('\\', '/')

  return `${entry.slice(0, entry.lastIndexOf('/dist/'))}/dist`
}

/** Node's built-ins and Electron itself are provided at runtime, never bundled. */
const EXTERNAL = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

/** Watch handle for one entry in dev — just the part of the watcher this file uses. */
interface Watching {
  on: (event: 'event', listener: (event: { code: string, error?: unknown, result?: { close: () => unknown } }) => void) => void
  close: () => Promise<void> | void
}

function buildEntry (config: ResolvedConfig, entry: Entry, watch: boolean) {
  return viteBuild({
    configFile: false,
    root: config.root,
    mode: config.mode,
    logLevel: watch ? 'warn' : 'info',
    clearScreen: false,
    publicDir: false,
    build: {
      // An SSR build is Vite's Node build: no browser polyfills, node
      // resolution, and package dependencies left as runtime `require`s.
      ssr: entry.entry,
      outDir: OUT_DIR,
      emptyOutDir: false,
      target: 'node24',
      minify: !watch,
      sourcemap: watch ? 'inline' : false,
      copyPublicDir: false,
      reportCompressedSize: false,
      watch: watch ? {} : null,
      rolldownOptions: {
        external: EXTERNAL,
        output: { format: entry.format, entryFileNames: entry.file },
      },
    },
  })
}

function electron (): Plugin {
  let config: ResolvedConfig
  let stopDev: (() => Promise<void>) | undefined

  return {
    name: 'kemolate:electron',

    // The built renderer is opened from disk, so its asset URLs must be relative.
    config: (_, { command }) => (command === 'build' ? { base: './' } : {}),

    configResolved (resolved) {
      config = resolved
    },

    configureServer (server) {
      // The two things the built app's `app://` handler answers besides the
      // page (see `electron/protocol.ts`), answered here in development: model
      // weights through the store in `.data/models` — the web build's location —
      // and the ONNX runtime's own wasm and loaders, straight from the package.
      server.middlewares.use('/api/models', async (request, response) => {
        const answer = await answerModel(`${config.root}/.data/models`, (request.url ?? '').split('?')[0]!.slice(1))

        response.statusCode = answer.status
        for (const [name, value] of Object.entries({ ...MODEL_HEADERS, ...ISOLATION })) response.setHeader(name, value)
        if (answer.body) response.setHeader('Content-Length', String(answer.body.byteLength))
        response.end(answer.body ?? answer.message)
      })
      server.middlewares.use('/ort', (request, response, next) => {
        const file = (request.url ?? '').split('?')[0]!.slice(1)

        if (!ORT_FILE.test(file)) return next()
        response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        for (const [name, value] of Object.entries(ISOLATION)) response.setHeader(name, value)
        response.end(readFileSync(`${ortDist()}/${file}`))
      })

      const electronPath = createRequire(import.meta.url)('electron') as string
      const watchers: Watching[] = []
      let app: ChildProcess | null = null
      let restarting = false
      let stopping = false

      const log = (message: string) => config.logger.info(`\x1b[36m[electron]\x1b[0m ${message}`, { timestamp: true })

      const url = () => {
        const address = server.httpServer?.address()
        const port = typeof address === 'object' && address ? address.port : config.server.port
        return `http://localhost:${port}/`
      }

      const start = (again = false) => {
        log(again ? 'main rebuilt — restarting' : `starting on ${url()}`)
        app = spawn(electronPath, ['.'], {
          cwd: config.root,
          stdio: 'inherit',
          env: { ...process.env, KEMOLATE_DEV_URL: url() },
        })
        app.once('exit', (code) => {
          app = null
          if (restarting) {
            restarting = false
            start(true)
            return
          }
          // The window was closed, or Electron died: the dev session is over.
          if (!stopping) {
            log(`exited${code ? ` with code ${code}` : ''} — stopping the dev server`)
            server.close().then(() => process.exit(code ?? 0))
          }
        })
      }

      const restart = () => {
        if (!app) return start()
        restarting = true
        app.kill()
      }

      /**
       * Kill the app and stop watching — run from `closeBundle` below, which Vite
       * calls whenever this server closes, its own restarts included. Two
       * earlier wirings both leaked: the HTTP server's 'close' event waits for
       * every open connection, the HMR socket among them, and a wrapped
       * `server.close` is bypassed by a restart (Vite calls an internal close).
       * Either way, after a config edit the old instance's watchers lived on and
       * answered the next main edit with a second window.
       */
      stopDev = async () => {
        if (stopping) return
        stopping = true
        app?.kill()
        await Promise.all(watchers.map((w) => w.close()))
      }

      server.httpServer?.once('listening', async () => {
        const built = new Set<string>()

        for (const entry of ENTRIES) {
          const watcher = await buildEntry(config, entry, true) as unknown as Watching
          // Stopped while this one was building: it has nobody to report to.
          if (stopping) {
            await watcher.close()
            return
          }
          watchers.push(watcher)

          watcher.on('event', (event) => {
            if (event.code === 'ERROR') {
              config.logger.error(`[electron] ${entry.name} failed to build: ${String(event.error)}`)
              return
            }
            if (event.code !== 'BUNDLE_END') return
            event.result?.close()

            // The first build of each only counts towards starting the app.
            if (!built.has(entry.name)) {
              built.add(entry.name)
              if (built.size === ENTRIES.length) start()
              return
            }

            if (entry.name === 'main') {
              restart()
            } else {
              log('preload rebuilt — reloading the page')
              server.ws.send({ type: 'full-reload' })
            }
          })
        }
      })
    },

    // In dev, the server is closing (or restarting): take the app down with it.
    // In a build, the renderer has been written: build main and preload for production.
    async closeBundle () {
      if (config.command === 'serve') return stopDev?.()
      // The runtime's wasm and loaders beside the page, at `/ort/` — loaded
      // from here rather than the CDN the web build points at, which the CSP
      // refuses and an offline machine cannot reach.
      mkdirSync(`${config.root}/dist/ort`, { recursive: true })
      for (const file of readdirSync(ortDist()).filter((name) => ORT_FILE.test(name))) {
        copyFileSync(`${ortDist()}/${file}`, `${config.root}/dist/ort/${file}`)
      }
      for (const entry of ENTRIES) await buildEntry(config, entry, false)
    },
  }
}
