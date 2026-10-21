import { describe, expect, it } from 'vitest'

import type { ReadingSessions } from '~/utils/ocr/manga'

import { betaFiles, betaPrecision, KEMOLATE_OCR_BETA_FILES, mangaPrecision, readBatch } from '~/utils/ocr/manga'
import { READERS_BY_ID } from '~/utils/ocr/readers'

/**
 * manga-ocr's reading loop, batched — with sessions that behave like the
 * runtime's, and no model.
 *
 * Two things are under test, and both fail quietly when they are wrong.
 *
 * **The bookkeeping.** A page's crops are encoded in one run and decoded side
 * by side, a token each per step, and a crop that reaches its end marker
 * leaves the batch. Get the rows crossed and a balloon reads another balloon's
 * words; keep a finished row in play and it is fed tokens past its end; read
 * the wrong position of the logits and every reading is its first token again.
 * The decoder below checks, every step, that each row was fed its own reading
 * so far, and puts a louder wrong answer at every position but the last.
 *
 * **Fresh buffers, every run.** Both runtimes run inference in a worker and
 * *transfer* each input's buffer to it, so an array handed to one run is
 * detached before the next — and a second run given it dies with "ArrayBuffer
 * at index 1 is already detached", naming nothing. That was a real bug in the
 * one-crop loop (the encoder's states reused across steps). The sessions here
 * transfer what they are given the same way, through `structuredClone`, so a
 * reused buffer throws here as it does in the browser.
 */

/** The encoder's input, one crop: three planes of 224 × 224. */
const CROP = 3 * 224 * 224

const START = 2
const END = 3

/** A tiny hidden state: the decoder here only has to tell the rows apart. */
const SEQ = 2
const WIDTH = 3
const VOCAB = 12

/** A token no script says, scored loudest at every position but the last. */
const DECOY = 11

interface Fed {
  data: Float32Array | BigInt64Array
  dims: number[]
}

/**
 * A session that treats its inputs as the runtime does: each buffer is
 * transferred away as `run` is called, and one already given away throws.
 */
function transferring (answer: (feeds: Record<string, Fed>) => Record<string, Fed>) {
  const calls: Record<string, Fed>[] = []

  const run = async (feeds: Record<string, unknown>) => {
    const arrived: Record<string, Fed> = {}

    for (const [name, value] of Object.entries(feeds)) {
      const { data, dims } = value as Fed
      const { byteOffset, length } = data
      const moved = structuredClone(data.buffer as ArrayBuffer, { transfer: [data.buffer as ArrayBuffer] })
      const copy = data instanceof BigInt64Array
        ? new BigInt64Array(moved, byteOffset, length)
        : new Float32Array(moved, byteOffset, length)

      expect(copy.length, `${name} holds what its dims say`).toBe(dims.reduce((a, b) => a * b, 1))

      arrived[name] = { data: copy, dims: [...dims] }
    }

    calls.push(arrived)

    return answer(arrived)
  }

  return { calls, run }
}

/** Crops whose first value names them — 0, 1, 2… — which the encoder passes on as its states. */
function crops (count: number): Float32Array {
  const pixels = new Float32Array(count * CROP)

  for (let crop = 0; crop < count; crop++) pixels[crop * CROP] = crop

  return pixels
}

function encoder () {
  return transferring(({ pixel_values: pixels }) => {
    const rows = pixels!.dims[0]!
    const hidden = new Float32Array(rows * SEQ * WIDTH)

    for (let row = 0; row < rows; row++) {
      hidden.fill(pixels!.data[row * CROP] as number, row * SEQ * WIDTH, (row + 1) * SEQ * WIDTH)
    }

    return { last_hidden_state: { data: hidden, dims: [rows, SEQ, WIDTH] } }
  })
}

/** Which crops a step's states belong to, row by row. */
const named = (states: Fed) =>
  Array.from({ length: states.dims[0]! }, (_, row) => states.data[row * SEQ * WIDTH] as number)

/**
 * A decoder that reads each crop's script, one token a step — after checking
 * that the row was fed exactly that script so far.
 */
function scripted (scripts: number[][], ties: Record<number, number> = {}) {
  return transferring(({ input_ids: ids, encoder_hidden_states: states }) => {
    const [rows, said] = ids!.dims as [number, number]
    const logits = new Float32Array(rows * said * VOCAB)

    for (const [row, crop] of named(states!).entries()) {
      const script = scripts[crop]!
      const fed = Array.from(ids!.data.subarray(row * said, (row + 1) * said), Number)

      expect(fed, `crop ${crop} is fed its own reading`).toEqual([START, ...script.slice(0, said - 1)])

      for (let position = 0; position < said - 1; position++) logits[(row * said + position) * VOCAB + DECOY] = 9

      const at = (row * said + said - 1) * VOCAB

      logits[at + script[said - 1]!] = 1

      // An equal score further along the vocabulary, where a test asks for one.
      if (ties[said - 1] !== undefined) logits[at + ties[said - 1]!] = 1
    }

    return { logits: { data: logits, dims: [rows, said, VOCAB] } }
  })
}

function sessionsFor (decoder: ReturnType<typeof scripted>) {
  const encoding = encoder()

  const sessions: ReadingSessions = {
    encoder: encoding,
    decoder,
    makeTensor: (_kind, data, dims) => ({ data, dims }),
  }

  return { sessions, encoder: encoding, decoder }
}

describe('readBatch', () => {
  it('reads every crop to its own end marker, in the order the crops were given', async () => {
    const { sessions } = sessionsFor(scripted([[5, 6, END], [7, END], [8, 9, 5, 6, END]]))

    expect(await readBatch(sessions, crops(3), 3)).toEqual([
      [START, 5, 6, END],
      [START, 7, END],
      [START, 8, 9, 5, 6, END],
    ])
  })

  it('encodes the whole batch in one run', async () => {
    const { sessions, encoder } = sessionsFor(scripted([[END], [END], [END]]))

    await readBatch(sessions, crops(3), 3)

    expect(encoder.calls).toHaveLength(1)
    expect(encoder.calls[0]!.pixel_values!.dims).toEqual([3, 3, 224, 224])
  })

  it('lets a crop leave the batch once it has finished, and carries on with the rest', async () => {
    const { sessions, decoder } = sessionsFor(scripted([[5, 6, END], [7, END], [8, 9, 5, 6, END]]))

    await readBatch(sessions, crops(3), 3)

    expect(decoder.calls.map((call) => call.input_ids!.dims)).toEqual([[3, 1], [3, 2], [2, 3], [1, 4], [1, 5]])
    expect(decoder.calls.map((call) => named(call.encoder_hidden_states!))).toEqual([
      [0, 1, 2],
      [0, 1, 2],
      [0, 2],
      [2],
      [2],
    ])
  })

  it('gives every run buffers of its own, as a runtime that transfers them needs', async () => {
    const { sessions, decoder } = sessionsFor(scripted([[5, 6, 7, 8, END], [9, END]]))
    const pixels = crops(2)

    // Five decoder runs, each of which detaches what it was handed: a buffer
    // reused from one step to the next throws inside `transferring`.
    await expect(readBatch(sessions, pixels, 2)).resolves.toHaveLength(2)
    expect(decoder.calls).toHaveLength(5)

    // And the caller's own array was one of them — handed over, as the
    // runtime would take it, which is why each batch builds a new one.
    expect(pixels.length).toBe(0)
  })

  it('takes the first of two equal scores, as the reading always has', async () => {
    const { sessions } = sessionsFor(scripted([[4, END]], { 0: 7 }))

    expect(await readBatch(sessions, crops(1), 1)).toEqual([[START, 4, END]])
  })

  it('cuts off a reading that never ends rather than decoding for ever', async () => {
    const { sessions, decoder } = sessionsFor(scripted([Array.from({ length: 400 }, () => 5), [END]]))

    const [endless, done] = await readBatch(sessions, crops(2), 2)

    expect(endless).toHaveLength(301)
    expect(done).toEqual([START, END])
    expect(decoder.calls).toHaveLength(300)
  })

  it('runs nothing for no crops', async () => {
    const { sessions, encoder, decoder } = sessionsFor(scripted([]))

    expect(await readBatch(sessions, new Float32Array(0), 0)).toEqual([])
    expect(encoder.calls).toHaveLength(0)
    expect(decoder.calls).toHaveLength(0)
  })
})

describe('mangaPrecision', () => {
  it('reads with the fp32 encoder on WebGPU, which cannot run the q8 one', () => {
    expect(mangaPrecision('webgpu')).toEqual({ encoder_model: 'fp32', decoder_model_merged: 'fp32' })
  })

  it('reads with the fp16 encoder where the GPU can run it, and the fp32 decoder still', () => {
    expect(mangaPrecision('webgpu', true)).toEqual({ encoder_model: 'fp16', decoder_model_merged: 'fp32' })
    expect(mangaPrecision('wasm', true)).toEqual({ encoder_model: 'q8', decoder_model_merged: 'fp32' })
  })

  it('keeps the q8 encoder on WebAssembly, where integer arithmetic is the cheap kind', () => {
    expect(mangaPrecision('wasm')).toEqual({ encoder_model: 'q8', decoder_model_merged: 'fp32' })
  })
})

describe('Kemolate OCR beta', () => {
  it('reads with the fp16 graphs on a GPU that can run them', () => {
    expect(betaPrecision(true, true)).toBe('fp16')
    expect(betaFiles('fp16')).toEqual({ encoder: 'encoder_model_fp16.onnx', decoder: 'decoder_model_fp16.onnx' })
  })

  it('reads with the fp32 graphs on any other GPU, which cannot run MatMulInteger either', () => {
    expect(betaPrecision(true, false)).toBe('fp32')
    expect(betaFiles('fp32')).toEqual({ encoder: 'encoder_model.onnx', decoder: 'decoder_model.onnx' })
  })

  it('reads with the q8 graphs on WebAssembly, where integer arithmetic is the cheap kind', () => {
    expect(betaPrecision(false, false)).toBe('q8')
    expect(betaPrecision(false, true)).toBe('q8')
    expect(betaFiles('q8')).toEqual({ encoder: 'encoder_model_quantized.onnx', decoder: 'decoder_model_quantized.onnx' })
  })

  it('names six distinct graphs, so no precision is handed another\'s file', () => {
    const names = Object.values(KEMOLATE_OCR_BETA_FILES).flatMap((pair) => [pair.encoder, pair.decoder])

    expect(new Set(names).size).toBe(6)
  })

  it('is a local reader that takes the detector\'s regions, like manga-ocr', () => {
    const reader = READERS_BY_ID.get('kemolate-beta')

    expect(reader?.label).toBe('Kemolate OCR (beta)')
    expect(reader?.detects).toBeFalsy()
    expect(reader?.lab).toBeFalsy()
    expect(reader?.provider).toBeUndefined()
  })
})
