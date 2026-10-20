/**
 * Hand the reader a file, as a download.
 *
 * The object URL is revoked a minute later rather than immediately: the click
 * is asynchronous, and revoking in the same frame cancels the save before it
 * starts in more than one browser.
 */
export function download (data: Blob, name: string) {
  const url = URL.createObjectURL(data)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = name
  anchor.click()

  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
