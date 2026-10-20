/**
 * Bytes in the units people read, and never more precision than that earns.
 *
 * One function rather than one per component, because the rounding *is* the
 * decision: "1.2 GB" and "1234.6 MB" are the same number and only one of them
 * is an answer. Two copies of that judgement drift, and a page showing a
 * transfer in one style beside a storage figure in another reads as two
 * different kinds of measurement.
 *
 * Three significant-ish digits at most, and fewer as the number grows: past ten
 * of anything the decimal is noise, because nobody acts differently on 47.3 GB
 * than on 47 GB.
 */
export function formatBytes (bytes: number): string {
  const gb = bytes / 1024 ** 3

  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`

  const mb = bytes / 1024 ** 2

  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`

  // Floored at one rather than shown as zero: a file that exists is not nothing,
  // and "0 KB" reads as a failure to write it.
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
