/**
 * A ZIP of a few small text files, stored rather than deflated — for the
 * Kemolate skill Settings saves (`mcp.ts`), which Claude's skill upload takes as
 * a ZIP with the skill's folder at its top.
 *
 * Written by hand because it is forty lines and the alternative is a dependency
 * for one file a few kilobytes long. Stored entries need no compressor, and
 * Node has the checksum (`zlib.crc32`). Names are UTF-8 (flag bit 11), so a
 * path is never mangled by a code page.
 */
import { crc32 } from 'node:zlib'

export function zipOf (files: { path: string, text: string }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const { path, text } of files) {
    const name = Buffer.from(path, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const sum = crc32(data)

    const local = Buffer.alloc(30)

    local.writeUInt32LE(0x04034B50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(0, 10) // time and date: none
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)

    central.writeUInt32LE(0x02014B50, 0) // central directory header
    central.writeUInt16LE(20, 4) // made by: 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)

  end.writeUInt32LE(0x06054B50, 0) // end of central directory
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, end])
}
