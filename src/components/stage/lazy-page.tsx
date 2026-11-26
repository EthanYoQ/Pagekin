import { createElement, useEffect, useState, type ComponentType } from 'react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

const FAILED_MODULE_URL = /dynamically imported module: (\S+)/

const isComponent = (value: unknown): boolean =>
  typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value)

export function lazyPage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, entry: string) {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<boolean> | null = null
  let failedUrl: URL | null = null
  let retries = 0
  const attemptLoad = (): Promise<{ default: unknown }> => {
    if (!failedUrl) return load()
    const url = new URL(failedUrl)
    url.searchParams.set('retry', String(++retries))
    return import(/* @vite-ignore */ url.href) as Promise<{ default: unknown }>
  }
  const entryUrl = (error: unknown): URL | null => {
    const found = FAILED_MODULE_URL.exec(error instanceof Error ? error.message : '')?.[1]
    if (!found || !URL.canParse(found)) return null
    const url = new URL(found)
    const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    return file.startsWith(`${entry}-`) || file.startsWith(`${entry}.`) ? url : null
  }
  const preload = () => (pending ??= attemptLoad().then(
    module => {
      // i18n-exempt: 下面的 catch 只记日志，作者看到的是按语言写好的「页面没有载入」
      if (!isComponent(module.default)) throw new Error(`页面代码块 ${entry} 没有默认导出的组件`)
      loaded = module.default as ComponentType<P>
      return true
    },
  ).catch((error: unknown) => {
    pending = null
    failedUrl ??= entryUrl(error)
    console.warn('[lazyPage] 页面代码载入失败', error)
    return false
  }))

  function Page(props: P) {
    const text = useLocaleStore(s => s.text)
    const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
    const attempt = () => {
      setStatus('loading')
      void preload().then(ok => setStatus(ok ? 'ready' : 'failed'))
    }
    useEffect(() => {
      if (!loaded) attempt()
    }, [])
    if (loaded) return createElement(loaded, props)
    if (status !== 'failed') return null
    return (
      <EmptyState
        heading={text('页面没有载入', 'This page did not load')}
        description={text('页面代码读取失败，作品内容不受影响。', 'The page code could not be read. Your book is not affected.')}
        action={<Button variant="primary" onClick={attempt}>{text('重试', 'Retry')}</Button>}
      />
    )
  }

  return { Page, preload }
}
