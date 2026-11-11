import { page } from 'vitest/browser'

/**
 * 改视口并等这次 resize 派发完。viewport() 返回时尺寸已变，resize 却要等下一次渲染才派发；
 * 负载高时它落在之后打开浮层的那一刻，use-anchored-layer 收到 resize 就把浮层关掉。
 */
export async function resizeViewport(width: number, height: number) {
  const resized = new Promise<void>(resolve => {
    if (innerWidth === width && innerHeight === height) return resolve()
    const onResize = () => {
      if (innerWidth !== width || innerHeight !== height) return
      window.removeEventListener('resize', onResize)
      resolve()
    }
    window.addEventListener('resize', onResize)
  })
  await page.viewport(width, height)
  await resized
}
