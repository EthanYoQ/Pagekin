import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useLocaleStore } from '../stores/locale-store'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'

type CopyState = 'idle' | 'copied' | 'failed'

export function CrashPanel({ heading, diagnostics, onRetry }: { heading?: string; diagnostics: () => string; onRetry: () => void }) {
  const text = useLocaleStore(s => s.text)
  const [copy, setCopy] = useState<CopyState>('idle')
  const copyDiagnostics = () => {
    navigator.clipboard.writeText(diagnostics()).then(() => setCopy('copied'), () => setCopy('failed'))
  }
  const copyLabel = {
    idle: text('复制诊断信息', 'Copy diagnostics', '診断情報をコピー'),
    copied: text('已复制', 'Copied', 'コピーしました'),
    failed: text('复制失败', 'Copy failed', 'コピーに失敗しました'),
  }[copy]
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <EmptyState
        icon={<AlertTriangle aria-hidden="true" />}
        heading={heading || text('这一块没能显示出来', 'This part could not be shown', 'この部分を表示できませんでした')}
        description={text(
          '已保存的内容不受影响。点「重试」再试一次；仍然出错就点「复制诊断信息」发给我们。',
          'Your saved work is not affected. Click Retry to try again. If it keeps failing, click Copy diagnostics and send them to us.',
          '保存済みの内容には影響ありません。「再試行」を押してください。繰り返し失敗する場合は「診断情報をコピー」を押して送ってください。',
        )}
        action={(
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 'var(--s-2)' }}>
            <Button variant="primary" onClick={onRetry}>{text('重试', 'Retry', '再試行')}</Button>
            <Button variant="secondary" onClick={copyDiagnostics}>{copyLabel}</Button>
          </div>
        )}
      />
    </div>
  )
}
