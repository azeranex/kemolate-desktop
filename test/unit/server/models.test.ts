import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { answerModel, modelFile, ownSource } from '~~/server/models'

/*
 * The model route's answers that need no network: a path refused, a file kept
 * on disk served, `onnx/` flattened, and this project's own models asked of our
 * own address, never of a Hub namespace that is not ours. `KEMOLATE_MODELS_URL`
 * points at a port nothing answers in the test environment (`vitest.config.ts`),
 * so a fetch fails at once and no test reaches the network.
 */
let root = ''

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kemolate-models-'))
  await mkdir(path.join(root, 'someone', 'model', 'resolve', 'main'), { recursive: true })
  await writeFile(path.join(root, 'someone', 'model', 'resolve', 'main', 'config.json'), '{"ok":true}')
  await writeFile(path.join(root, 'someone', 'model', 'resolve', 'main', 'encoder.onnx'), 'graph')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('answerModel', () => {
  it('refuses a path that climbs out or carries odd characters', async () => {
    expect((await answerModel(root, '../secrets.txt')).status).toBe(400)
    expect((await answerModel(root, 'someone/model/resolve/main/a b.json')).status).toBe(400)
  })

  it('serves a file kept on disk, by the path it was asked for', async () => {
    const answer = await answerModel(root, 'someone/model/resolve/main/config.json')

    expect(answer.status).toBe(200)
    expect(new TextDecoder().decode(answer.body)).toBe('{"ok":true}')
  })

  it('finds a file asked for under onnx/ where it is kept without that folder', async () => {
    const answer = await answerModel(root, 'someone/model/resolve/main/onnx/encoder.onnx')

    expect(answer.status).toBe(200)
    expect(new TextDecoder().decode(answer.body)).toBe('graph')
  })

  it('says so when one of our own models cannot be fetched from our address', async () => {
    const answer = await answerModel(root, 'kemolate/kemolate-ocr-out26/resolve/main/tokenizer_config.json')

    expect(answer.status).toBe(502)
    expect(answer.message).toMatch(/could not be fetched/)
  })
})

/**
 * Desktop: the file a model is in, for the CUDA process, which opens by path
 * (`electron/cuda.ts`) — the same lookup the route makes, `onnx/` and all.
 */
describe('modelFile', () => {
  it('finds a model kept on disk, by the path it was asked for', async () => {
    expect(await modelFile(root, 'someone/model/resolve/main/config.json')).toBe(path.join(root, 'someone', 'model', 'resolve', 'main', 'config.json'))
  })

  it('finds one asked for under onnx/ where it is kept without that folder', async () => {
    expect(await modelFile(root, 'someone/model/resolve/main/onnx/encoder.onnx')).toBe(path.join(root, 'someone', 'model', 'resolve', 'main', 'encoder.onnx'))
  })

  it('gives nothing for a path the route would refuse, or a model of ours it cannot fetch', async () => {
    expect(await modelFile(root, '../secrets.txt')).toBeNull()
    expect(await modelFile(root, 'kemolate/kemolate-ocr-out26/resolve/main/encoder_model.onnx')).toBeNull()
  })
})

/*
 * Where our own files are downloaded from, once an address is set: Kemolate OCR
 * from one `kemolate-ocr` repository at the build's tag, so the window can go
 * on asking for each build by a name that never changes — see `OCR_BUILD`.
 */
describe('ownSource', () => {
  const base = 'https://huggingface.co/someone'

  it('fetches a Kemolate OCR build from its tag on the one repository', () => {
    expect(ownSource(base, 'kemolate/kemolate-ocr-out26/resolve/main/encoder_model_fp16.onnx'))
      .toBe('https://huggingface.co/someone/kemolate-ocr/resolve/out26/encoder_model_fp16.onnx')
    expect(ownSource(base, 'kemolate/kemolate-ocr-out27/resolve/main/tokenizer.json'))
      .toBe('https://huggingface.co/someone/kemolate-ocr/resolve/out27/tokenizer.json')
  })

  it('fetches anything else of ours from the repository of its own name', () => {
    expect(ownSource(base, 'kemolate/comic-text-and-bubble-detector-fp16/resolve/main/model.onnx'))
      .toBe('https://huggingface.co/someone/comic-text-and-bubble-detector-fp16/resolve/main/model.onnx')
    // A name that only looks like a build is not one.
    expect(ownSource(base, 'kemolate/kemolate-ocr-beta/resolve/main/config.json'))
      .toBe('https://huggingface.co/someone/kemolate-ocr-beta/resolve/main/config.json')
  })
})
