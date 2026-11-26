import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function canonicalizePnpmLockfileBytes(bytes) {
  const normalized = Buffer.allocUnsafe(bytes.length)
  let writeOffset = 0

  for (let readOffset = 0; readOffset < bytes.length; readOffset += 1) {
    const byte = bytes[readOffset]
    if (byte === 0x0d) {
      normalized[writeOffset] = 0x0a
      writeOffset += 1
      if (bytes[readOffset + 1] === 0x0a) readOffset += 1
      continue
    }

    normalized[writeOffset] = byte
    writeOffset += 1
  }

  return normalized.subarray(0, writeOffset)
}

export function canonicalPnpmLockfileSha256(file) {
  return createHash('sha256')
    .update(canonicalizePnpmLockfileBytes(readFileSync(file)))
    .digest('hex')
}
