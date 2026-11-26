import { expect } from 'vitest'

expect.addEqualityTesters([
  (a: unknown, b: unknown) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : undefined),
])
