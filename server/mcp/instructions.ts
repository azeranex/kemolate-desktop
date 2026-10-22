/**
 * What the agent is told before anything else — the web build's
 * `mcp.instructions`, with its first paragraph adding the open chapter
 * (`get_active_workspace`) and its last said for a window rather than a tab.
 * The coordinate rule and the pinning rule are here for the reasons given
 * there: each is the one thing a model reliably gets wrong.
 *
 * A file of its own, importing nothing, so the Claude Desktop bundle
 * (`mcpb/bridge.ts`) can say the same while Kemolate is not running — `index.ts`
 * loads the tools, which open the database.
 */
export const INSTRUCTIONS = [
  'This server exposes the comic translation workspaces of one Kemolate desktop app.',
  'Before any job of more than a step or two, call `get_guide` once: it is the full playbook.',
  'Start with `get_active_workspace` — the chapter and page open in the Kemolate window — or `list_workspaces`,',
  'then `list_pages`, then `read_page`. Leave `workspaceId` out of any tool to work on the open chapter,',
  'and `pageId` out of a one-page tool to work on the page on screen.',
  '',
  'Block coordinates are NOT percentages of the page. They are an oriented box',
  'normalised by the page WIDTH on both axes, so `cy` and `h` legitimately exceed 1',
  'on a page taller than it is wide. `list_pages` gives you the pixel size of each',
  'page: divide every pixel measurement, x and y alike, by the width.',
  '',
  'A line somebody typed by hand is pinned, and writing over it through this server',
  'files your wording in its history without moving the line. That is deliberate, not',
  'a failed write — a human translator outranks you. `save_page_translations` reports',
  'which lines it held back.',
  '',
  '`save_page_translations` writes only the lines its brief asked about: answers for',
  'context lines are set aside, not saved, and every page is checked before any is',
  'written. A 409 about the job means the page changed since the brief was made, or',
  'the brief is from an older server; call `prepare_page_translation` again.',
  '',
  'Page images, and readings by the app\'s own OCR, come from the Kemolate window, from',
  'the chapter it has open — the scans are the reader\'s own files and are kept nowhere',
  'else. If an image tool says nobody is holding the page, that chapter is not open in',
  'Kemolate; ask the user to open it rather than retrying. Text tools work regardless.',
].join('\n')
