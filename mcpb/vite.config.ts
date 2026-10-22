/**
 * The Claude Desktop bundle, `out/mcpb/kemolate.mcpb` — `pnpm build:mcpb`, and
 * the last step of `pnpm build`.
 *
 * The bridge (`bridge.ts`) and the SDK it uses are bundled into one file, as
 * the main process is (`vite.config.ts`): an MCP Bundle's Node server ships its
 * `node_modules`, and one file is none to ship. Then the bundle's folder is laid
 * out — the manifest with the app's version written in, the app's icon — and
 * packed by the format's own CLI (`mcpb pack`), which validates the manifest as
 * it goes. The installer carries the result (`electron-builder.yml`), and
 * Settings › Agents hands it to Claude Desktop (`electron/mcp.ts`).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

import type { Plugin, UserConfig } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = path.join(root, 'out/mcpb')
const folder = path.join(out, 'bundle')

/** Lays the bundle's folder out around the built server, and packs it. */
function pack (): Plugin {
  return {
    name: 'kemolate:mcpb',
    apply: 'build',
    closeBundle () {
      const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
      const manifest = JSON.parse(readFileSync(path.join(root, 'mcpb/manifest.json'), 'utf8')) as Record<string, unknown>

      // The app's version, so an installed bundle says which Kemolate it came with.
      writeFileSync(path.join(folder, 'manifest.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
      copyFileSync(path.join(root, 'build/icon.png'), path.join(folder, 'icon.png'))

      // By path: the package exports no subpath for its CLI, and it is a direct dependency, so linked here.
      const cli = path.join(root, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js')

      execFileSync(process.execPath, [cli, 'pack', folder, path.join(out, 'kemolate.mcpb')], { stdio: 'inherit' })
    },
  }
}

export default defineConfig((): UserConfig => {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })

  return {
    root,
    publicDir: false,
    logLevel: 'info' as const,
    // Bundled whole, SDK and zod included — see the header.
    ssr: { noExternal: true },
    plugins: [pack()],
    build: {
      ssr: 'mcpb/bridge.ts',
      outDir: path.join(folder, 'server'),
      emptyOutDir: false,
      // Claude Desktop runs it on the Node it ships, which the manifest asks to be 18 or later.
      target: 'node18',
      minify: true,
      copyPublicDir: false,
      reportCompressedSize: false,
      rolldownOptions: {
        external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
        output: { format: 'es', entryFileNames: 'index.mjs', codeSplitting: false },
      },
    },
  }
})
