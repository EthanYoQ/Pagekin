import { useLayoutEffect, useState, type RefObject } from 'react'

export function usePaperInkRoot(mountRef: RefObject<Element | null>): Element | null | undefined {
  const [root, setRoot] = useState<Element | null | undefined>(undefined)
  useLayoutEffect(() => {
    setRoot(mountRef.current?.closest('.paper-ink') ?? null)
  }, [mountRef])
  return root
}
