import { expectTypeOf, it } from 'vitest'

import type { DatabaseChannels } from '../ipc-channels'
import type { Failure } from '../failure'

it('db:project-clear-generated-data 迁到 handle() 后失败只回 failure', () => {
  expectTypeOf<DatabaseChannels['db:project-clear-generated-data']['return']>().toHaveProperty('failure').toEqualTypeOf<Failure | undefined>()
  expectTypeOf<DatabaseChannels['db:project-clear-generated-data']['return']>().not.toHaveProperty('error')
})
