/**
 * Models on an NVIDIA GPU, through the CUDA process — desktop only, and opt-in.
 *
 * The window's half of `electron/cuda.ts`, which says what the process is and
 * why it exists. The comic detector and Kemolate OCR ask here first when the
 * reader has switched CUDA on in Settings, and run on WebGPU as before when it
 * is off, when this is not the desktop app, or when anything here fails.
 *
 * A failure ends CUDA for the rest of the session, said once (`gaveUp`), rather
 * than being tried again on every page: a Python that went away, a driver that
 * will not load or a model CUDA refused will refuse again a second later, and a
 * reading that spent a timeout on it per page would be slower than never having
 * switched it on. The next launch tries again.
 *
 * Tensors cross as bytes laid end to end with a spec of each — the frame the
 * process speaks (`TensorSpec` in `electron/preload.ts`) — so nothing on the way
 * parses a number.
 */
import type { CudaSettings, TensorSpec } from '../../../electron/preload'

/** A tensor as either runtime hands one over: its type, its shape, its data. */
export interface TensorLike {
  type: string
  dims: readonly number[]
  data: unknown
}

/** A model opened on CUDA: the file it is, and a pass of it. */
export interface CudaSession {
  path: string
  run: (feeds: Record<string, TensorLike>) => Promise<Record<string, TensorLike>>
}

const ARRAYS = {
  float32: Float32Array,
  float16: Uint16Array,
  int64: BigInt64Array,
  int32: Int32Array,
  uint8: Uint8Array,
  int8: Int8Array,
  bool: Uint8Array,
} as const

type Dtype = keyof typeof ARRAYS

let failed = false

const bridge = () => (typeof window === 'undefined' ? undefined : window.kemolate?.cuda)

/**
 * Whether to ask CUDA at all: the desktop app, switched on, and not given up on
 * this session. Asked of the main process every time — one small IPC per model
 * load — rather than remembered here: a remembered `on` outlived the switch being
 * turned off, and sent the next page to a process that then refused it.
 */
export async function cudaWanted (): Promise<boolean> {
  if (failed) return false

  const cuda = bridge()

  if (!cuda) return false

  return (await cuda.settings().catch((): CudaSettings | null => null))?.enabled === true
}

/** Settings changed — try CUDA again if it had failed this session. */
export function cudaChanged () {
  failed = false
}

/**
 * CUDA is done for this session: said once, in words, and every model goes
 * back to WebGPU. `what` is the model that found out.
 */
export function gaveUp (what: string, error: unknown) {
  if (failed) return

  failed = true
  console.warn(`[kemolate] CUDA failed on ${what}; running on WebGPU for the rest of this session.`, error)
  // Electron wraps a main-process error as "Error invoking remote method 'cuda:open':
  // Error: …" — the reader wants the sentence at the end, which is the process's own.
  const said = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

  toast.warning('Using WebGPU instead of CUDA', {
    description: `${what} could not use CUDA, so it runs on WebGPU for the rest of this session. ${said}`,
  })
}

/** Bytes of a tensor's data, as they lie — no copy where none is needed. */
function bytesOf (data: unknown): Uint8Array {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

  throw new Error('A tensor CUDA was handed has no data on this side.')
}

/** Feeds as one body and the spec of each. */
function packFeeds (feeds: Record<string, TensorLike>) {
  const specs: Record<string, TensorSpec> = {}
  const parts: Uint8Array[] = []
  let at = 0

  for (const [name, tensor] of Object.entries(feeds)) {
    const bytes = bytesOf(tensor.data)

    specs[name] = { dtype: tensor.type, dims: [...tensor.dims], offset: at, length: bytes.byteLength }
    parts.push(bytes)
    at += bytes.byteLength
  }

  const body = new Uint8Array(at)
  let into = 0

  for (const part of parts) {
    body.set(part, into)
    into += part.byteLength
  }

  return { specs, body }
}

/** Outputs back out of a body, each in a typed array of its own — the body is not kept. */
function unpack (specs: Record<string, TensorSpec>, body: Uint8Array): Record<string, TensorLike> {
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => {
    const Array_ = ARRAYS[spec.dtype as Dtype]

    if (!Array_) throw new Error(`CUDA answered with a ${spec.dtype} tensor, which this side does not read.`)

    const copy = body.slice(spec.offset, spec.offset + spec.length)

    return [name, { type: spec.dtype, dims: spec.dims, data: new Array_(copy.buffer) }]
  }))
}

/** A model, by its path in the model store (`owner/repo/resolve/main/file.onnx`), opened on CUDA. */
export async function cudaSession (model: string): Promise<CudaSession> {
  const cuda = bridge()

  if (!cuda) throw new Error('CUDA is only in the desktop app.')

  const { path } = await cuda.open(model)

  return {
    path,
    run: async (feeds) => {
      const { specs, body } = packFeeds(feeds)
      const answer = await cuda.run(path, specs, body)

      return unpack(answer.outputs, answer.body)
    },
  }
}

/**
 * Kemolate OCR's reading of a batch of crops, whole, in the CUDA process — the
 * encoder and the greedy decode together, by `readBatch`'s rules (see the
 * script). The token ids of each crop, as `readBatch` gives them.
 */
export async function cudaRead (encoder: CudaSession, decoder: CudaSession, pixels: Float32Array, count: number,
  rules: { edge: number, start: number, end: number, limit: number }): Promise<number[][]> {
  const cuda = bridge()

  if (!cuda) throw new Error('CUDA is only in the desktop app.')

  return cuda.read({ encoder: encoder.path, decoder: decoder.path, count, ...rules }, bytesOf(pixels))
}
