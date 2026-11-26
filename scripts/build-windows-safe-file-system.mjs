import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const securityDirectory = path.resolve(path.dirname(scriptPath), '..', 'electron', 'security')
const defaultSource = path.join(securityDirectory, 'windows-safe-file-system.cs')
const defaultOutput = path.join(securityDirectory, 'windows-safe-file-system.exe')
const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

export function compileWindowsSafeFileSystem(source, output) {
  const staging = `${output}.${process.pid}.tmp.exe`
  try {
    execFileSync(csc, [
      '/nologo',
      '/optimize+',
      '/warnaserror+',
      '/target:exe',
      '/r:System.Web.Extensions.dll',
      `/out:${staging}`,
      source,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    renameSync(staging, output)
  } catch (error) {
    rmSync(staging, { force: true })
    throw new Error(`csc could not build ${path.basename(output)}:\n${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`)
  }
}

export function setup() {
  if (process.platform !== 'win32') return
  if (existsSync(defaultOutput) && statSync(defaultOutput).mtimeMs >= statSync(defaultSource).mtimeMs) return
  compileWindowsSafeFileSystem(defaultSource, defaultOutput)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const [source, output] = process.argv.slice(2)
  if (source && output) compileWindowsSafeFileSystem(path.resolve(source), path.resolve(output))
  else setup()
}
