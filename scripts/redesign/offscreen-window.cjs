const path = require('node:path')
const { app, screen, session } = require('electron')

const timing = globalThis.__driveTiming = { readyToShow: null }

app.on('browser-window-created', (_, window) => {
  window.once('ready-to-show', () => { timing.readyToShow ??= Date.now() })
  const right = Math.max(...screen.getAllDisplays().map(({ bounds }) => bounds.x + bounds.width))
  window.setSkipTaskbar(true)
  window.setPosition(right + 200, 0)
  window.setFocusable(false)
  window.blur()
})

if (process.env.DRIVE_RENDER_TIMING) {
  app.whenReady().then(() => {
    session.defaultSession.registerPreloadScript({ type: 'frame', id: 'drive-render-timing', filePath: path.join(__dirname, 'render-timing-preload.cjs') })
  })
}
