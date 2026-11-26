import { readFileSync } from 'node:fs'

export function normalizeSourceEol(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

export function readNormalizedSource(sourcePath: string): string {
  return normalizeSourceEol(readFileSync(sourcePath, 'utf8'))
}
