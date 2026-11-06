/**
 * Language models on this computer, run by the app itself — desktop only.
 *
 * The assistant and the translator speak OpenAI's chat format to whoever
 * answers (`app/utils/openrouter.ts`). llama.cpp's `llama-server` answers in
 * that format too, from a GGUF file on disk, on whatever GPU is here — which is
 * what LM Studio runs underneath. So rather than asking a reader to install
 * LM Studio and start its server with the right flags, the app downloads
 * `llama-server` once and starts it itself, on the model the reader picked,
 * when it is first asked something.
 *
 * ## The binary, pinned
 *
 * One llama.cpp release (`RELEASE`), by SHA-256, from its GitHub releases — as
 * `cudaSetup.ts` pins `uv`. A setup next month must get what was tested; a new
 * model family llama.cpp learns later is a decision to move the pin and test
 * again. Two builds:
 *
 * - **Vulkan** — about 37 MB, and runs on any card with a Vulkan driver
 *   (NVIDIA, AMD, Intel). The default.
 * - **CUDA** — NVIDIA only, about 660 MB with NVIDIA's runtime, which does
 *   not need the CUDA toolkit installed. Quicker reading of a long prompt,
 *   which an assistant turn is.
 *
 * Into `<userData>/llama/<release>-<build>/`. Nothing on PATH, nothing outside
 * the folder, and Remove deletes the folder.
 *
 * ## The models
 *
 * GGUF files under a folder the reader names — LM Studio's own models folder
 * when it has one, so a model downloaded there is not downloaded twice. A model
 * that can see has its vision projector (`mmproj-*.gguf`) beside it, which is
 * how LM Studio and the Hub lay them out; that is the whole test for `vision`.
 *
 * ## One server, one model
 *
 * Started on the first ask for a model and kept for the next — loading a 17 GB
 * file into VRAM takes a while, and an assistant run is dozens of asks. Asking
 * for another model stops it and starts one on that. It listens on a free port
 * on 127.0.0.1 only, and stops with the app.
 *
 * `--jinja` is what makes tool calls work: it applies the model's own chat
 * template, which is where a model says how it writes one.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { app, dialog, ipcMain, net } from 'electron'

import type { LlamaBuild, LlamaModel, LlamaProgress, LlamaStatus } from './preload'
import type { ChildProcess } from 'node:child_process'

/** The llama.cpp release every setup gets — see the header. */
export const RELEASE = 'b11818'

const DOWNLOADS = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}`

/** What each build is made of: every file, its size and its SHA-256, as the release publishes them. */
const BUILDS: Record<LlamaBuild, { label: string, files: { name: string, bytes: number, sha256: string }[] }> = {
  vulkan: {
    label: 'Vulkan',
    files: [{ name: `llama-${RELEASE}-bin-win-vulkan-x64.zip`, bytes: 36_873_831, sha256: '1f86fa8fa640c9c23cc53f44921b879735fe71cfe49ea49fdf5564157523078a' }],
  },
  cuda: {
    label: 'CUDA 12.4',
    files: [
      { name: `llama-${RELEASE}-bin-win-cuda-12.4-x64.zip`, bytes: 272_323_458, sha256: '39eeaa10e276deddebb5146edd80400550a044e48f7f65985e86036ac3b89c83' },
      { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', bytes: 391_443_627, sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' },
    ],
  },
}

/** How long a model is given to load before the ask is refused: a big one from a slow disk takes minutes. */
const LOAD_TIMEOUT = 300_000

/** The context a model is started with, where the reader has not chosen: an assistant turn is ~15–30k tokens. */
const DEFAULT_CONTEXT = 32_768

/** NVIDIA's PCI vendor id, as `app.getGPUInfo` reports it. */
const NVIDIA = 0x10DE

interface Settings {
  /** Which build is installed, or null. */
  build: LlamaBuild | null
  /** Where the GGUF files are looked for. */
  folder: string
  /** The context window a model is started with, in tokens. */
  context: number
}

const root = () => path.join(app.getPath('userData'), 'llama')
const settingsFile = () => path.join(app.getPath('userData'), 'llama.json')
const buildDir = (build: LlamaBuild) => path.join(root(), `${RELEASE}-${build}`)
const serverExe = (build: LlamaBuild) => path.join(buildDir(build), 'llama-server.exe')
const supported = () => process.platform === 'win32' && process.arch === 'x64'

/** LM Studio's models folder where it has one, so its downloads are found; the app's own otherwise. */
function defaultFolder (): string {
  const lmStudio = path.join(os.homedir(), '.lmstudio', 'models')

  return existsSync(lmStudio) ? lmStudio : path.join(app.getPath('userData'), 'llm')
}

function readSettings (): Settings {
  const fallback: Settings = { build: null, folder: defaultFolder(), context: DEFAULT_CONTEXT }

  try {
    const read = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<Settings>

    return {
      build: read.build === 'vulkan' || read.build === 'cuda' ? read.build : null,
      folder: typeof read.folder === 'string' && read.folder ? read.folder : fallback.folder,
      context: Number.isInteger(read.context) && read.context! >= 4096 ? read.context! : fallback.context,
    }
  } catch {
    return fallback
  }
}

function writeSettings (settings: Settings) {
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

/** The build that is installed and whose server is on disk, or null. */
function installed (): LlamaBuild | null {
  const { build } = readSettings()

  return build && existsSync(serverExe(build)) ? build : null
}

async function nvidia (): Promise<string | null> {
  const info = await app.getGPUInfo('complete').catch(() => null) as {
    gpuDevice?: { vendorId?: number, deviceString?: string, description?: string }[]
  } | null

  const card = info?.gpuDevice?.find((device) => device.vendorId === NVIDIA)

  return card ? (card.deviceString || card.description || 'NVIDIA GPU') : null
}

async function sizeOf (folder: string): Promise<number> {
  let total = 0

  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const at = path.join(folder, entry.name)

    if (entry.isDirectory()) total += await sizeOf(at)
    else if (entry.isFile()) total += (await stat(at).catch(() => null))?.size ?? 0
  }

  return total
}

/**
 * Every model under the folder: each GGUF that is not a vision projector, with
 * the projector beside it where there is one. An embedding model is left out —
 * it cannot answer anything. Two levels deep at most beyond the publisher and
 * repository folders LM Studio uses, which is where anybody keeps them.
 */
export async function modelsIn (folder: string, depth = 4): Promise<LlamaModel[]> {
  const found: LlamaModel[] = []

  async function walk (at: string, left: number) {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => [])
    const ggufs = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
    const projector = ggufs.find((entry) => /^mmproj/i.test(entry.name))

    for (const entry of ggufs) {
      if (/^mmproj/i.test(entry.name) || /embed/i.test(entry.name)) continue
      // A model split across files is named by its first part, and llama.cpp reads the rest itself.
      if (Number(/-(\d+)-of-\d+\.gguf$/i.exec(entry.name)?.[1] ?? 1) > 1) continue

      const file = path.join(at, entry.name)

      found.push({
        id: path.relative(folder, file).split(path.sep).join('/'),
        name: entry.name.replace(/\.gguf$/i, ''),
        bytes: (await stat(file).catch(() => null))?.size ?? 0,
        vision: Boolean(projector),
      })
    }

    if (left > 0) {
      for (const entry of entries) if (entry.isDirectory()) await walk(path.join(at, entry.name), left - 1)
    }
  }

  await walk(folder, depth)

  return found.sort((a, b) => a.id.localeCompare(b.id))
}

/** A port nothing is listening on, from the OS. */
function freePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()

    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }

      probe.close(() => resolve(port))
    })
  })
}

/** The file under `folder` an id names, refusing one that climbs out of it. */
function fileFor (folder: string, id: string): string {
  const file = path.resolve(folder, id)

  if (!file.startsWith(path.resolve(folder) + path.sep) || !file.toLowerCase().endsWith('.gguf')) throw new Error('Not a model in the models folder.')
  if (!existsSync(file)) throw new Error(`${id} is no longer in the models folder.`)

  return file
}

// ── The running server ──────────────────────────────────────────────────────

interface Running { model: string, port: number, child: ChildProcess, ready: Promise<number> }

let running: Running | null = null

export function stopServer () {
  running?.child.kill()
  running = null
}

/** Answers once `/health` says the model is loaded, or rejects with the server's last words. */
async function healthy (port: number, child: ChildProcess, tail: string[]): Promise<number> {
  const started = Date.now()

  while (Date.now() - started < LOAD_TIMEOUT) {
    if (child.exitCode !== null) throw new Error(`The model did not load: ${tail.slice(-3).join(' ') || `llama-server stopped (exit ${child.exitCode}).`}`)

    try {
      const response = await net.fetch(`http://127.0.0.1:${port}/health`)

      if (response.ok) return port
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  child.kill()
  throw new Error('The model took too long to load.')
}

/** The port a server on this model listens on, starting one — and stopping another — where needed. */
async function serve (model: string): Promise<number> {
  if (running?.model === model) return running.ready

  stopServer()

  const build = installed()

  if (!build) throw new Error('Local models are not set up — Settings › Local models.')

  const settings = readSettings()
  const file = fileFor(settings.folder, model)
  const projector = (await readdir(path.dirname(file)).catch(() => [] as string[])).find((name) => /^mmproj.*\.gguf$/i.test(name))
  const port = await freePort()

  const args = [
    '--model', file,
    ...(projector ? ['--mmproj', path.join(path.dirname(file), projector)] : []),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', String(settings.context),
    // Every layer on the GPU; llama.cpp keeps on the CPU what does not fit.
    '--n-gpu-layers', '999',
    '--jinja',
    '--no-webui',
  ]

  const child = spawn(serverExe(build), args, { cwd: buildDir(build), windowsHide: true })
  const tail: string[] = []
  const keep = (data: Buffer) => {
    for (const line of String(data).split(/\r?\n/)) {
      if (!line.trim()) continue
      tail.push(line.trim())
      if (tail.length > 20) tail.shift()
    }
  }

  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  child.on('exit', () => {
    if (running?.child === child) running = null
  })

  const ready = healthy(port, child, tail)

  running = { model, port, child, ready }
  ready.catch(() => {
    if (running?.child === child) running = null
  })

  return ready
}

// ── Setup ───────────────────────────────────────────────────────────────────

let installing: AbortController | null = null

/** One file of a build, streamed to disk and checked against its published digest. */
async function download (name: string, sha256: string, to: string, signal: AbortSignal, say: (done: number) => void) {
  const response = await net.fetch(`${DOWNLOADS}/${name}`, { signal })

  if (!response.ok || !response.body) throw new Error(`${name} could not be downloaded (${response.status}).`)

  const hash = createHash('sha256')
  const out = createWriteStream(to)
  let done = 0

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      done += chunk.byteLength
      say(done)
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }

  if (hash.digest('hex') !== sha256) throw new Error(`${name} did not match its published checksum, and was not used.`)
}

function unzip (zip: string, into: string): Promise<void> {
  // Windows' own `tar` (bsdtar, since Windows 10) unpacks a zip — as `cudaSetup.ts` does.
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zip, '-C', into], { windowsHide: true })

    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(zip)} could not be unpacked (exit ${code}).`))))
  })
}

async function install (build: LlamaBuild, say: (progress: LlamaProgress) => void) {
  const into = buildDir(build)
  const files = BUILDS[build].files
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  let before = 0

  installing = new AbortController()

  try {
    await rm(into, { recursive: true, force: true })
    await mkdir(into, { recursive: true })

    for (const file of files) {
      const zip = path.join(root(), file.name)

      await download(file.name, file.sha256, zip, installing.signal, (done) => say({ message: `Downloading llama.cpp ${RELEASE} (${BUILDS[build].label})…`, done: before + done, total }))
      say({ message: 'Unpacking…' })
      await unzip(zip, into)
      await rm(zip, { force: true })
      before += file.bytes
    }

    if (!existsSync(serverExe(build))) throw new Error('llama.cpp was downloaded, but llama-server.exe is not in it.')

    // One build at a time: the other is a few hundred megabytes nobody is using.
    for (const other of Object.keys(BUILDS) as LlamaBuild[]) {
      if (other !== build) await rm(buildDir(other), { recursive: true, force: true })
    }

    stopServer()
    writeSettings({ ...readSettings(), build })
    say({ message: 'Ready.' })
  } catch (error) {
    await rm(into, { recursive: true, force: true }).catch(() => {})
    throw installing.signal.aborted ? new Error('Cancelled.') : error
  } finally {
    installing = null
  }
}

export function serveLlama (trusted: (event: Electron.IpcMainInvokeEvent) => boolean) {
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error('Not the app.')
  }

  ipcMain.handle('llama:status', async (event): Promise<LlamaStatus> => {
    guard(event)

    const settings = readSettings()
    const build = installed()

    return {
      supported: supported(),
      release: RELEASE,
      gpu: await nvidia(),
      build,
      bytes: existsSync(root()) ? await sizeOf(root()) : 0,
      sizes: { vulkan: BUILDS.vulkan.files.reduce((sum, file) => sum + file.bytes, 0), cuda: BUILDS.cuda.files.reduce((sum, file) => sum + file.bytes, 0) },
      folder: settings.folder,
      context: settings.context,
      running: running ? { model: running.model, port: running.port } : null,
    }
  })

  ipcMain.handle('llama:models', async (event): Promise<LlamaModel[]> => {
    guard(event)

    return installed() ? modelsIn(readSettings().folder) : []
  })

  ipcMain.handle('llama:configure', (event, patch: { folder?: unknown, context?: unknown }) => {
    guard(event)

    const settings = readSettings()
    const folder = typeof patch.folder === 'string' && patch.folder.trim() ? patch.folder.trim() : settings.folder
    const context = Number.isInteger(patch.context) && (patch.context as number) >= 4096 && (patch.context as number) <= 262_144 ? patch.context as number : settings.context

    // A new folder or context is a different server; the next ask starts it.
    if (folder !== settings.folder || context !== settings.context) stopServer()

    writeSettings({ ...settings, folder, context })
  })

  ipcMain.handle('llama:choose-folder', async (event): Promise<string | null> => {
    guard(event)

    const picked = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: readSettings().folder })

    return picked.canceled ? null : picked.filePaths[0] ?? null
  })

  ipcMain.handle('llama:install', async (event, build: unknown): Promise<{ ok: boolean, error?: string }> => {
    guard(event)

    if (!supported()) return { ok: false, error: 'Local models are set up here for Windows on x64.' }
    if (build !== 'vulkan' && build !== 'cuda') return { ok: false, error: 'No such build.' }
    if (installing) return { ok: false, error: 'Already setting up.' }

    const say = (progress: LlamaProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send('llama:progress', progress)
    }

    try {
      await mkdir(root(), { recursive: true })
      await install(build, say)

      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      say({ message })

      return { ok: false, error: message }
    }
  })

  ipcMain.handle('llama:cancel', (event) => {
    guard(event)
    installing?.abort()
  })

  ipcMain.handle('llama:remove', async (event) => {
    guard(event)

    if (installing) throw new Error('Setting up — cancel that first.')

    stopServer()
    writeSettings({ ...readSettings(), build: null })
    await rm(root(), { recursive: true, force: true, maxRetries: 3 })
  })

  /** The port a model answers on, loading it first where it is not the one running. */
  ipcMain.handle('llama:start', (event, model: unknown): Promise<number> => {
    guard(event)

    if (typeof model !== 'string' || !model) throw new Error('Name a model.')

    return serve(model)
  })

  ipcMain.handle('llama:stop', (event) => {
    guard(event)
    stopServer()
  })

  app.on('will-quit', stopServer)
}
