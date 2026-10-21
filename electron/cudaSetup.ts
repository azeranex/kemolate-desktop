/**
 * CUDA in one press: a Python of the app's own, in the app's own folder.
 *
 * The CUDA process (`cuda.ts`) runs on a Python with `onnxruntime-gpu` in it.
 * Asking a reader for the path to one was asking them to have built an ML
 * environment first; most who own an NVIDIA card have not, and those who have
 * should not have to find its `python.exe`. So Settings offers to make one:
 *
 * 1. `uv` — Astral's Python installer and package manager, one 15 MB exe —
 *    downloaded into `<userData>/cuda/uv/`. It is what makes the rest one step
 *    each, and fast: a managed CPython it fetches itself, and a resolver that
 *    installs a few gigabytes of wheels in parallel.
 * 2. A CPython (`PYTHON`) under `<userData>/cuda/python/`, and a venv from it
 *    at `<userData>/cuda/venv/`. Nothing goes on PATH, into the registry, or
 *    anywhere outside the folder — a reader's own Pythons are untouched, and
 *    `uv` is told to ignore any configuration of theirs (`UV_NO_CONFIG`).
 * 3. `onnxruntime-gpu[cuda,cudnn]` into it (`PACKAGES`): the extras bring
 *    CUDA's and cuDNN's DLLs as ordinary wheels, which `preload_dlls()` in the
 *    script then loads — so no CUDA toolkit is installed, only the driver the
 *    card already has is needed. The whole is about 2.1 GB on disk (measured
 *    2026-10-21, installed in 24 s on a fast line), and the button says
 *    so before it is pressed.
 * 4. The setting pointed at that Python, Test run, and CUDA switched on if it
 *    passed.
 *
 * Every version is pinned: a setup run next month must get what was tested,
 * not whatever was published since. Moving one is a decision to test again.
 *
 * Remove deletes the folder — every byte of it — and switches CUDA off if it
 * was using it. Windows on x64 only for now: the `uv` build named here is that
 * one, and the CUDA wheels are what this was measured on.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app, ipcMain, net } from 'electron'

import { readSettings, start, stop, writeSettings } from './cuda'

import type { CudaHello, CudaManaged, CudaProgress } from './preload'
import type { ChildProcess } from 'node:child_process'

/** `uv`, pinned — see the header. */
const UV = 'https://github.com/astral-sh/uv/releases/download/0.13.4/uv-x86_64-pc-windows-msvc.zip'

/** The CPython the venv is made from: one every pinned wheel below is built for. */
const PYTHON = '3.12'

/**
 * What goes into it. `onnx` is for the script's `hello`, which builds a model
 * of one node to prove CUDA opens rather than trusting that it is listed.
 */
const PACKAGES = ['onnxruntime-gpu[cuda,cudnn]==1.31.0', 'numpy', 'onnx']

/** NVIDIA's PCI vendor id, as `app.getGPUInfo` reports it. */
const NVIDIA = 0x10DE

const root = () => path.join(app.getPath('userData'), 'cuda')
const uvExe = () => path.join(root(), 'uv', 'uv.exe')

/** The venv's Python — what the CUDA setting points at once setup is done. */
export const managedPython = () => path.join(root(), 'venv', 'Scripts', 'python.exe')

const supported = () => process.platform === 'win32' && process.arch === 'x64'

/** Every command `uv` runs keeps its Pythons and its cache in the folder, and reads no configuration of the reader's. */
const uvEnv = () => ({
  ...process.env,
  UV_PYTHON_INSTALL_DIR: path.join(root(), 'python'),
  UV_CACHE_DIR: path.join(root(), 'cache'),
  UV_PYTHON_PREFERENCE: 'only-managed',
  UV_NO_CONFIG: '1',
  UV_NO_PROGRESS: '1',
})

let running: ChildProcess | null = null
let busy = false

/** The NVIDIA card here, by name where the GPU process can say one, or null. */
async function nvidia (): Promise<string | null> {
  const info = await app.getGPUInfo('complete').catch(() => null) as {
    gpuDevice?: { vendorId?: number, deviceString?: string, description?: string }[]
  } | null

  const card = info?.gpuDevice?.find((device) => device.vendorId === NVIDIA)

  return card ? (card.deviceString || card.description || 'NVIDIA GPU') : null
}

/** How much is on disk under a folder, in bytes — what Remove would give back. */
async function sizeOf (folder: string): Promise<number> {
  let total = 0

  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const at = path.join(folder, entry.name)

    if (entry.isDirectory()) total += await sizeOf(at)
    else if (entry.isFile()) total += (await stat(at).catch(() => null))?.size ?? 0
  }

  return total
}

/** A command of `uv`'s, with each line it says handed to `say`, failing in its own words. */
function uv (args: string[], say: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(uvExe(), args, { env: uvEnv(), windowsHide: true })
    const tail: string[] = []

    running = child

    const lines = (data: Buffer) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (!line.trim()) continue

        tail.push(line.trim())
        if (tail.length > 6) tail.shift()
        say(line.trim())
      }
    }

    child.stdout.on('data', lines)
    child.stderr.on('data', lines)
    child.on('error', reject)
    child.on('exit', (code) => {
      running = null

      if (code === 0) resolve()
      else reject(new Error(tail.join('\n') || `uv stopped (exit ${code}).`))
    })
  })
}

/** `uv`, fetched and unpacked where it is not here yet. */
async function fetchUv (say: (progress: CudaProgress) => void) {
  if (existsSync(uvExe())) return

  const folder = path.dirname(uvExe())
  const zip = path.join(root(), 'uv.zip')

  await mkdir(folder, { recursive: true })

  const response = await net.fetch(UV)

  if (!response.ok || !response.body) throw new Error(`uv could not be downloaded (${response.status}).`)

  const total = Number(response.headers.get('content-length')) || 0
  const parts: Uint8Array[] = []
  let done = 0

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    parts.push(chunk)
    done += chunk.byteLength
    say({ step: 'uv', message: 'Downloading uv…', done, total })
  }

  await writeFile(zip, Buffer.concat(parts))

  // Windows' own `tar` (bsdtar, since Windows 10) unpacks a zip — no library for it.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', zip, '-C', folder], { windowsHide: true })

    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`uv could not be unpacked (exit ${code}).`))))
  })

  await rm(zip, { force: true })

  if (!existsSync(uvExe())) throw new Error('uv was downloaded, but uv.exe is not in it.')
}

export function serveCudaSetup (trusted: (event: Electron.IpcMainInvokeEvent) => boolean) {
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error('Not the app.')
  }

  ipcMain.handle('cuda:managed', async (event): Promise<CudaManaged> => {
    guard(event)

    const installed = existsSync(managedPython())

    return {
      supported: supported(),
      gpu: await nvidia(),
      installed,
      bytes: installed || existsSync(root()) ? await sizeOf(root()) : 0,
      python: managedPython(),
    }
  })

  ipcMain.handle('cuda:setup', async (event): Promise<CudaHello> => {
    guard(event)

    if (!supported()) return { ready: false, error: 'Setting up CUDA here is for Windows on x64.' }
    if (busy) return { ready: false, error: 'CUDA is already being set up.' }

    busy = true

    const say = (progress: CudaProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send('cuda:progress', progress)
    }

    try {
      await mkdir(root(), { recursive: true })
      await fetchUv(say)

      say({ step: 'python', message: `Installing Python ${PYTHON}…` })
      await uv(['venv', '--python', PYTHON, '--allow-existing', path.join(root(), 'venv')], (line) => say({ step: 'python', message: line }))

      say({ step: 'packages', message: 'Installing onnxruntime-gpu, CUDA and cuDNN — the large part…' })
      await uv(['pip', 'install', '--python', managedPython(), ...PACKAGES], (line) => say({ step: 'packages', message: line }))

      // The cache holds what is already installed; the venv keeps its own copy.
      say({ step: 'packages', message: 'Tidying up…' })
      await uv(['cache', 'clean'], () => {}).catch(() => {})

      say({ step: 'test', message: 'Testing CUDA…' })
      writeSettings({ ...readSettings(), python: managedPython() })
      stop()

      const hello = await start(true).catch((error: unknown): CudaHello => ({ ready: false, error: error instanceof Error ? error.message : String(error) }))

      // On only if it works: a setup that installed and then could not open CUDA
      // leaves the switch where it was, and says why.
      if (hello.ready) writeSettings({ ...readSettings(), enabled: true })

      say({ step: 'done', message: hello.ready ? 'CUDA is ready.' : (hello.error ?? 'CUDA did not open.') })

      return hello
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      say({ step: 'done', message })

      return { ready: false, error: message }
    } finally {
      busy = false
      running = null
    }
  })

  ipcMain.handle('cuda:cancel', (event) => {
    guard(event)
    running?.kill()
  })

  ipcMain.handle('cuda:remove', async (event): Promise<void> => {
    guard(event)

    if (busy) throw new Error('CUDA is being set up — cancel that first.')

    stop()

    const settings = readSettings()

    if (settings.python.startsWith(root())) writeSettings({ enabled: false, python: '' })

    await rm(root(), { recursive: true, force: true, maxRetries: 3 })
  })
}
