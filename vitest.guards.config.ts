import { mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'
import { GUARD_TESTS } from './test/guards.ts'

export default mergeConfig(viteConfig, {
  test: { include: GUARD_TESTS.map(entry => entry.file) },
})
