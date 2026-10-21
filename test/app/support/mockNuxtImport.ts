import type { Plugin } from 'vite'

import { readFileSync } from 'node:fs'

/**
 * `mockNuxtImport`, done the way `@nuxt/test-utils` does it: at transform time.
 *
 * The web build's app tests replace an auto-imported function with
 * `mockNuxtImport('useRoute', () => fake)`. That cannot be a function call that
 * runs — by the time it ran, the module under test would already have imported
 * the real one. Nuxt's test utils rewrite each call into a `vi.mock` of the
 * module the name is auto-imported *from*, which Vitest then hoists above every
 * import. This is the same rewrite, against this app's auto-imports: the name is
 * looked up in `app/auto-imports.d.ts` (unplugin-auto-import's own record of
 * where each name comes from), and every call naming one module is folded into
 * a single `vi.mock` of it, since a second `vi.mock` of a module replaces the
 * first rather than adding to it.
 *
 * What it does not do, as Nuxt's does not: reach a call made *inside* the module
 * that defines the name. A function mocked this way is replaced for everybody
 * who imports it, not for its own neighbours.
 *
 * The factory is moved, not run, so it may use only what a `vi.mock` factory may:
 * imports, and values made with `vi.hoisted`. The web tests already keep to that.
 */
export function mockNuxtImports (declarations: string): Plugin {
  let sources: Map<string, string> | undefined

  const sourceOf = (name: string) => {
    sources ??= new Map([...readFileSync(declarations, 'utf8')
      .matchAll(/const (\w+): typeof import\('([^']+)'\)/g)]
      .map(([, each, from]) => [each!, from!.startsWith('.') ? new URL(from!, `file:///${declarations.replaceAll('\\', '/')}`).pathname.replace(/^\/(\w:)/, '$1') : from!]))

    return sources.get(name)
  }

  return {
    name: 'kemolate:mock-nuxt-import',
    transform (code, id) {
      if (!/\.test\.ts$/.test(id) || !code.includes('mockNuxtImport')) return

      const program = this.parse(code) as unknown as Node
      const calls: { start: number, end: number, name: string, factory: string }[] = []

      walk(program, (node) => {
        if (node.type !== 'CallExpression') return
        const callee = node.callee as Node
        if (callee.type !== 'Identifier' || callee.name !== 'mockNuxtImport') return
        const [name, factory] = node.arguments as Node[]
        if (name?.type !== 'Literal' || typeof name.value !== 'string' || !factory) {
          this.error(`mockNuxtImport takes the name as a string literal and a factory (${id})`)
        }
        calls.push({ start: node.start, end: node.end, name: name.value as string, factory: code.slice(factory.start, factory.end) })
      })

      if (!calls.length) return

      const byModule = new Map<string, typeof calls>()

      for (const call of calls) {
        const from = sourceOf(call.name)
        if (!from) this.error(`mockNuxtImport: "${call.name}" is not an auto-import of this app (${id})`)
        byModule.set(from!, [...(byModule.get(from!) ?? []), call])
      }

      let out = code

      // From the end, so the earlier offsets still point where they did.
      for (const call of [...calls].sort((a, b) => b.start - a.start)) {
        out = `${out.slice(0, call.start)}void 0${out.slice(call.end)}`
      }

      const mocks = [...byModule].map(([from, each]) =>
        `vi.mock(${JSON.stringify(from)}, async (importOriginal) => ({ ...(await importOriginal()), ${
          each.map((call) => `${JSON.stringify(call.name)}: await (${call.factory})()`).join(', ')
        } }))`).join('\n')
      const vi = /\bimport\s*\{[^}]*\bvi\b[^}]*\}\s*from\s*['"]vitest['"]/.test(out) ? '' : 'import { vi } from \'vitest\'\n'

      return { code: `${vi}${out}\n${mocks}\n`, map: null }
    },
  }
}

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

function walk (node: unknown, visit: (node: Node) => void) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const each of node) walk(each, visit)
    return
  }
  if (typeof (node as Node).type === 'string') visit(node as Node)
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && value && typeof value === 'object') walk(value, visit)
  }
}
