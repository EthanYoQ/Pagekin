import { mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'
import { guardTestFiles } from './test/guards.ts'

export default mergeConfig(viteConfig, {
  test: { include: guardTestFiles() },
})
