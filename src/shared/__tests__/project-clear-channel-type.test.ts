import { expectTypeOf, it } from 'vitest'

import type { DatabaseChannels } from '../ipc-channels'

it('未迁移的 db:project-clear-generated-data 声明与处理器一致，失败仍回 error', () => {
  expectTypeOf<DatabaseChannels['db:project-clear-generated-data']['return']>().toHaveProperty('error').toEqualTypeOf<string | undefined>()
})
