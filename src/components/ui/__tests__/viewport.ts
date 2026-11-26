import { page } from 'vitest/browser'

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
