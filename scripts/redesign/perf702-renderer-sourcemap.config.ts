import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electronRenderer from 'vite-plugin-electron-renderer'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))

export default defineConfig({
  root,
  base: './',
  plugins: [tailwindcss(), react(), electronRenderer()],
  publicDir: 'public',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: path.join(root, '.runtime', 'perf702', 'sm-dist'), emptyOutDir: true, sourcemap: true },
})
