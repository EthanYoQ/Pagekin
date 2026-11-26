/// <reference types="@vitest/browser-playwright" />
import { cdp } from 'vitest/browser'

export async function withReducedMotion(run: () => Promise<void>) {
  const session = cdp()
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  try {
    await run()
  } finally {
    await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  }
}
