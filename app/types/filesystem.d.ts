/**
 * The parts of the File System Access API the standard library does not
 * describe, or does not describe the same way in every version of it.
 *
 * The permission calls are the ones that matter. They are how a handle kept
 * from a previous session is turned back into a folder we may read, and they
 * have never been in `lib.dom` — so without these, the one thing this feature
 * is built on does not type-check.
 *
 * Declared loosely on purpose. This is a shim over what a browser may or may not
 * have, and every call site already treats all of it as absent until proven
 * otherwise.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  queryPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
  requestPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>
}

interface DataTransferItem {
  /** Chromium only, and the reason a dropped folder can be kept. */
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: string | FileSystemHandle
}

interface OpenFilePickerOptions {
  multiple?: boolean
  types?: { description?: string, accept: Record<string, string[]> }[]
}

interface Window {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>
  /** Desktop: how picked files come with a handle each — see `Source` in `utils/images.ts`. */
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
}
