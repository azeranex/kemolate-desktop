/**
 * A file read in as text at build time — Vite's `?raw`, which the main process's
 * build and Vitest both understand. Used for the Kemolate skill, which the MCP
 * server hands out (`get_guide`) and Settings saves (`electron/mcp.ts`).
 */
declare module '*.md?raw' {
  const text: string
  export default text
}
