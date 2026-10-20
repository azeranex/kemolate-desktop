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
import type { ChildProcess } from 'node:child_process'
import type { Plugin, ResolvedConfig } from 'vite'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { spawn } from 'node:child_process'
import { builtinModules, createRequire } from 'node:module'
import { defineConfig, build as viteBuild } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss(), electron()],
  server: { port: 5173, strictPort: true },
})

/** The Electron processes' entries, and the format each has to be in. */
const ENTRIES = [
  // An ES module main, which Electron loads as such from the `.mjs` extension.
  { name: 'main', entry: 'electron/main.ts', format: 'es', file: 'main.mjs' },
  // A sandboxed preload cannot be an ES module — Electron requires CommonJS there.
  { name: 'preload', entry: 'electron/preload.ts', format: 'cjs', file: 'preload.cjs' },
] as const

type Entry = typeof ENTRIES[number]

const OUT_DIR = 'dist-electron'

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
            void server.close().then(() => process.exit(code ?? 0))
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
            void event.result?.close()

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
      for (const entry of ENTRIES) await buildEntry(config, entry, false)
    },
  }
}
