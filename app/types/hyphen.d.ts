/**
 * The `hyphen` package's language modules (TeX patterns, Liang's algorithm),
 * which ship no types of their own — see `utils/hyphens.ts`, the one place
 * that loads them. Only what that file uses.
 */
declare module 'hyphen/*' {
  export function hyphenateSync (text: string, options?: { minWordLength?: number, hyphenChar?: string, exceptions?: string[] }): string
}
