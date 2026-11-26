import { useLayoutStore } from '../../stores/layout-store'

export const IS_MAC = navigator.userAgent.includes('Mac')

function isLetter(event: Pick<KeyboardEvent, 'key' | 'code'>, letter: string): boolean {
  const key = event.key.toLowerCase()
  return /^[a-z]$/.test(key) ? key === letter : event.code === `Key${letter.toUpperCase()}`
}

export function isCommand(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, letter: string, mac = IS_MAC): boolean {
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return modifier && !event.altKey && !event.shiftKey && isLetter(event, letter)
}

export function commandLabel(letter: string, mac = IS_MAC): string {
  return mac ? `⌘${letter.toUpperCase()}` : `Ctrl ${letter.toUpperCase()}`
}

export function commandKeyLabel(key: string, mac = IS_MAC): string {
  return `${mac ? '⌘' : 'Ctrl'} + ${key}`
}

export function isComposing(event: { isComposing?: boolean; keyCode: number }): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229
}

const MODAL_SELECTOR = '[role="dialog"]:not(.pi-popover), [role="alertdialog"]'

export function isModalOpen(): boolean {
  const layout = useLayoutStore.getState()
  return layout.exportOpen || layout.newProjectOpen || layout.importNovelOpen
    || document.querySelector(MODAL_SELECTOR) !== null
}
