import { expect, vi } from 'vitest'

/** handle() 把没登记的码换成通用码，原码只进主进程日志；从日志核对是哪条门禁拒绝的。 */
export function expectLoggedCode(code: string): void {
  expect(vi.mocked(console.error)).toHaveBeenLastCalledWith(expect.stringContaining('抛出未登记的错误'), expect.objectContaining({ message: code }))
}
