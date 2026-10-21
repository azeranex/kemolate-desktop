/**
 * The CUDA process — opt-in, NVIDIA only — and the window's way to it.
 *
 * The window runs its models on WebGPU, inside Chromium, and that cannot reach
 * CUDA: onnxruntime's CUDA backend is a native library. Measured on an RTX 4090
 * with the app's own models, warm, CUDA read a batch of eight balloons with
 * Kemolate OCR in about 210 ms against WebGPU's 435–700, and ran the comic
 * detector in 55–80 ms against 360. So for a reader with an NVIDIA card, the
 * two models that run on every page can run there instead
 * (`kemolate_cuda.py`, which says what it does and why it is Python).
 *
 * The Python is the reader's, named in Settings — one that already has
 * `onnxruntime-gpu`, as an ML setup on such a machine usually does. The app
 * does not ship CUDA: its runtime and cuDNN are gigabytes, for one vendor's
 * cards, and an installer that carried them would be most of a download for
 * a feature most readers cannot use. Off unless switched on, and nothing here
 * runs until it is: the process starts on the first model asked of it, or on
 * Settings' Test, and is stopped when the setting goes off or its Python
 * changes.
 *
 * The window asks over IPC (`cuda:*`), the only caller trusted, and is
 * answered in tensors' bytes; the process is spoken to over its own pipes in
 * frames (see the script). Models are opened by their path in the model store,
 * fetched into it first where they are not there yet (`modelFile`), so CUDA
 * reads the same files the window would have. Any failure is an error back to
 * the window, which then runs the model on WebGPU as it always did — this is a
 * way to be faster, never a way for reading to stop working.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { app, ipcMain } from 'electron'

import { modelFile } from '../server/models'

import type { CudaHello, CudaSettings, TensorSpec } from './preload'
import type { ChildProcess } from 'node:child_process'

type Trusted = (event: Electron.IpcMainInvokeEvent) => boolean

const settingsFile = () => path.join(app.getPath('userData'), 'cuda.json')

function readSettings (): CudaSettings {
  try {
    const held = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<CudaSettings>

    return { enabled: held.enabled === true, python: typeof held.python === 'string' ? held.python : '' }
  } catch {
    return { enabled: false, python: '' }
  }
}

/** The script, beside the app when packed (`extraResources`), in the repository otherwise. */
function script () {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'cuda', 'kemolate_cuda.py')
    : path.join(app.getAppPath(), 'electron', 'cuda', 'kemolate_cuda.py')
}

interface Waiting {
  resolve: (answer: { header: Record<string, unknown>, body: Buffer }) => void
  reject: (error: Error) => void
}

let child: ChildProcess | null = null
let started: Promise<CudaHello> | null = null
let next = 1
const waiting = new Map<number, Waiting>()
let pending = Buffer.alloc(0)

/** Frames out of whatever the pipe has delivered so far — see the script's header for the shape. */
function take (chunk: Buffer) {
  pending = Buffer.concat([pending, chunk])

  for (;;) {
    if (pending.length < 4) return

    const head = pending.readUInt32LE(0)

    if (pending.length < 4 + head + 4) return

    const length = pending.readUInt32LE(4 + head)

    if (pending.length < 8 + head + length) return

    const header = JSON.parse(pending.subarray(4, 4 + head).toString('utf8')) as Record<string, unknown>
    const body = pending.subarray(8 + head, 8 + head + length)

    pending = pending.subarray(8 + head + length)

    const asked = waiting.get(header.id as number)

    waiting.delete(header.id as number)

    if (!asked) continue

    if (header.ok) asked.resolve({ header, body: Buffer.from(body) })
    else asked.reject(new Error(String(header.error ?? 'The CUDA process failed.')))
  }
}

function ask (header: Record<string, unknown>, body: Uint8Array = new Uint8Array(0)) {
  const running = child

  if (!running?.stdin) return Promise.reject(new Error('The CUDA process is not running.'))

  const id = next++
  const head = Buffer.from(JSON.stringify({ ...header, id }), 'utf8')
  const frame = Buffer.alloc(8 + head.length)

  frame.writeUInt32LE(head.length, 0)
  head.copy(frame, 4)
  frame.writeUInt32LE(body.byteLength, 4 + head.length)

  return new Promise<{ header: Record<string, unknown>, body: Buffer }>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    running.stdin!.write(frame)
    if (body.byteLength) running.stdin!.write(body)
  })
}

function stop () {
  child?.kill()
  child = null
  started = null
  pending = Buffer.alloc(0)

  for (const asked of waiting.values()) asked.reject(new Error('The CUDA process was stopped.'))
  waiting.clear()
}

/** The process, started with the chosen Python if it is not running — and what it said about itself. */
function start (detail = false): Promise<CudaHello> {
  if (started) return started

  const { python } = readSettings()

  started = (async () => {
    if (!python) throw new Error('No Python is chosen for CUDA — set one in Settings.')
    if (!existsSync(python)) throw new Error(`That Python is not there: ${python}`)

    const running = spawn(python, ['-I', '-u', script()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

    child = running
    running.stdout!.on('data', take)
    running.stderr!.on('data', (data: Buffer) => console.info(String(data).trimEnd()))
    running.on('exit', (code) => {
      if (child !== running) return

      child = null
      started = null
      for (const asked of waiting.values()) asked.reject(new Error(`The CUDA process stopped (exit ${code}).`))
      waiting.clear()
    })
    running.on('error', (error) => {
      for (const asked of waiting.values()) asked.reject(error)
      waiting.clear()
    })

    const { header } = await ask({ op: 'hello', detail })
    const hello = header as unknown as CudaHello

    if (!hello.ready) throw new Error(hello.error ?? 'CUDA is not available in that Python.')

    return hello
  })().catch((error: unknown) => {
    stop()
    throw error
  })

  return started
}

/** Ready for use: switched on, and started. */
async function ready () {
  if (!readSettings().enabled) throw new Error('CUDA is switched off.')

  return start()
}

export function serveCuda (trusted: Trusted, models: () => string) {
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error('Not the app.')
  }

  ipcMain.handle('cuda:settings', (event) => {
    guard(event)

    return readSettings()
  })

  ipcMain.handle('cuda:configure', (event, patch: unknown) => {
    guard(event)

    const held = readSettings()
    const given = (patch ?? {}) as Partial<CudaSettings>
    const settings: CudaSettings = {
      enabled: typeof given.enabled === 'boolean' ? given.enabled : held.enabled,
      python: typeof given.python === 'string' ? given.python.trim() : held.python,
    }

    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))

    // A different Python, or none wanted: what is running is not what was chosen.
    if (!settings.enabled || settings.python !== held.python) stop()

    return settings
  })

  /** Start it (again) and say what it found — Settings' Test, whether or not it is switched on. */
  ipcMain.handle('cuda:test', async (event): Promise<CudaHello> => {
    guard(event)
    stop()

    try {
      return await start(true)
    } catch (error) {
      return { ready: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('cuda:open', async (event, model: unknown) => {
    guard(event)

    if (typeof model !== 'string') throw new Error('No model named.')

    await ready()

    const file = await modelFile(models(), model)

    if (!file) throw new Error(`That model is not on this computer and could not be fetched: ${model}`)

    const { header } = await ask({ op: 'open', path: file })

    return { path: file, inputs: header.inputs as string[], outputs: header.outputs as string[] }
  })

  ipcMain.handle('cuda:run', async (event, file: unknown, feeds: unknown, body: unknown) => {
    guard(event)
    await ready()

    const { header, body: answer } = await ask({ op: 'run', path: file, feeds }, body as Uint8Array)

    return { outputs: header.outputs as Record<string, TensorSpec>, body: answer }
  })

  ipcMain.handle('cuda:read', async (event, request: unknown, body: unknown) => {
    guard(event)
    await ready()

    const { header } = await ask({ ...(request as Record<string, unknown>), op: 'read' }, body as Uint8Array)

    return header.tokens as number[][]
  })

  app.on('will-quit', stop)
}
