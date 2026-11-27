import { expect, vi } from 'vitest'

/** handle() 把未登记的码换成 IPC_HANDLER_FAILED，原码只进主进程日志，所以测试只能从日志核对原码。 */
export function expectLoggedCode(code: string): void {
  expect(vi.mocked(console.error)).toHaveBeenLastCalledWith(expect.stringContaining('抛出未登记的错误'), expect.objectContaining({ message: code }))
}
