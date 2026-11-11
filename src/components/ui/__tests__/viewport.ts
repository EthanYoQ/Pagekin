import { page } from 'vitest/browser'

// viewport() 返回时尺寸已变，resize 却要等下一次渲染才派发；不等它，它会落在之后打开浮层的那一刻，被 use-anchored-layer 当成窗口变化把浮层关掉。
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
