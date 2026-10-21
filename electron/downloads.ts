/**
 * Where a file the app hands over is saved — a project, an export.
 *
 * The page saves the way the web build does: `utils/download.ts` makes a link
 * to a Blob and clicks it. In a browser that lands in Downloads or asks, as the
 * browser is set; in Electron, with nothing said, it asks with a bare dialog
 * named for nothing in particular, opening wherever the last one did. A save is
 * the moment a reader decides where their chapter lives, so the dialog is set
 * up here instead: titled for what is being saved, filtered to its kind, and
 * opening in Documents the first time and in the last folder used after that.
 *
 * Nothing is saved without the dialog. A download the reader cancels is simply
 * not written; Chromium's partial file is its own to clean up.
 */
import type { DownloadItem } from 'electron'

import { app, session } from 'electron'
import path from 'node:path'

/** What each kind of file is called in the dialog, by extension. */
const KINDS: Record<string, { title: string, filter: string }> = {
  '.kemolate': { title: 'Save project', filter: 'Kemolate project' },
  '.pdf': { title: 'Export as PDF', filter: 'PDF' },
  '.zip': { title: 'Export pages', filter: 'Zip of pages' },
}

/** The folder the last save went to, for this run of the app. */
let lastFolder: string | null = null

function prepare (item: DownloadItem) {
  const name = item.getFilename()
  const extension = path.extname(name).toLowerCase()
  const kind = KINDS[extension]

  item.setSaveDialogOptions({
    title: kind?.title ?? 'Save',
    defaultPath: path.join(lastFolder ?? app.getPath('documents'), name),
    filters: kind
      ? [{ name: kind.filter, extensions: [extension.slice(1)] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  })

  item.once('done', (_event, state) => {
    if (state === 'completed') lastFolder = path.dirname(item.getSavePath())
  })
}

/** Set every download from the app's session up to ask well. Call once the app is ready. */
export function askWhereToSave () {
  session.defaultSession.on('will-download', (_event, item) => { prepare(item) })
}
