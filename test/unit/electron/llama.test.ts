import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

/**
 * Which GGUF files in the models folder are offered as models. Laid out as LM
 * Studio lays them out — publisher, repository, files — since that is the
 * folder looked in by default.
 */

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: () => {} }, dialog: {}, ipcMain: { handle: () => {} }, net: {} }))

const { modelsIn } = await import('~~/electron/llama')

function folder (files: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'llama-'))

  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), 'gguf')
  }

  return root
}

describe('the models in a folder', () => {
  it('offers each model, seeing where its projector is beside it, and nothing that cannot answer', async () => {
    const root = folder([
      'lmstudio-community/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf',
      'lmstudio-community/gemma-4-26B-A4B-it-GGUF/mmproj-gemma-4-26B-A4B-it-BF16.gguf',
      'qwen/qwen3.8-27b/Qwen3.8-27B-Q4_K_M.gguf',
      'nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q4_K_M.gguf',
      'notes.txt',
    ])

    expect(await modelsIn(root)).toEqual([
      { id: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q4_K_M.gguf', name: 'gemma-4-26B-A4B-it-Q4_K_M', bytes: 4, vision: true },
      { id: 'qwen/qwen3.8-27b/Qwen3.8-27B-Q4_K_M.gguf', name: 'Qwen3.8-27B-Q4_K_M', bytes: 4, vision: false },
    ])
  })

  it('offers a model split across files once, by its first part', async () => {
    const root = folder([
      'big/model-00001-of-00003.gguf',
      'big/model-00002-of-00003.gguf',
      'big/model-00003-of-00003.gguf',
    ])

    expect((await modelsIn(root)).map((model) => model.id)).toEqual(['big/model-00001-of-00003.gguf'])
  })
})
