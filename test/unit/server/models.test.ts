import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { answerModel } from '~~/server/models'

/*
 * The model route's answers that need no network: a path refused, a file kept
 * on disk served, `onnx/` flattened, and this project's own models — with no
 * address to download them from — refused in words rather than fetched from a
 * Hub namespace that is not ours. `KEMOLATE_MODELS_URL` is unset in the test
 * environment, which is the "not decided yet" state the app ships in.
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

  it('says why one of our own models is missing, rather than asking the Hub for it', async () => {
    const answer = await answerModel(root, 'kemolate/kemolate-ocr-out26/resolve/main/tokenizer_config.json')

    expect(answer.status).toBe(404)
    expect(answer.message).toMatch(/no address to download them from/)
  })
})
