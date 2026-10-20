/**
 * Where this project's TypeScript library describes the platform differently
 * from the one the web build was checked against — narrowed back to what the
 * web build's files were written for, rather than changing those files.
 *
 * Kept apart from `filesystem.d.ts`, which is the web build's, verbatim.
 */

interface FileSystemDirectoryHandle {
  /**
   * A directory's entries, as files *or* directories. TypeScript 5.9's
   * `lib.dom.asynciterable` yields the base `FileSystemHandle`, which checking
   * `kind` does not narrow — so `entry.getFile()` after `kind === 'file'`
   * (`utils/opfs.ts`, `utils/images.ts`) did not type-check. Declared here, it
   * is the first overload, and the narrowing works as written.
   */
  values(): FileSystemDirectoryHandleAsyncIterator<FileSystemFileHandle | FileSystemDirectoryHandle>
}
