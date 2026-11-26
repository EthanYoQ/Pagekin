const shelfBooks = Number(globalThis.process?.env?.DRIVE_RENDER_TIMING) || 20

const mark = (name, value) => document.documentElement?.setAttribute(`data-drive-${name}`, String(Math.round(value)))

const isNewBook = button => (button.getAttribute('aria-label') ?? button.textContent.trim()) === '新建作品'

let interactiveAt = null
const observer = new MutationObserver(() => {
  if (interactiveAt === null && [...document.querySelectorAll('button')].some(isNewBook)) {
    interactiveAt = performance.now()
    mark('interactive', interactiveAt)
  }
  if (interactiveAt !== null && document.querySelectorAll('button[aria-label^="预览《"]').length >= shelfBooks) {
    mark('shelf', performance.now())
    observer.disconnect()
    requestIdleCallback(() => mark('idle', performance.now()), { timeout: 5000 })
  }
})
observer.observe(document, { childList: true, subtree: true })
