import { useState } from 'react'
import {
  Wrench,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import type { ToolCallInfo } from '../../../services/agent/agent-engine'
import { useLocaleStore } from '../../../stores/locale-store'

interface Props {
  toolCall: ToolCallInfo
}

function StatusIcon({ status }: { status: ToolCallInfo['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={13} className="tool-call-status completed" />
    case 'failed':
      return <XCircle size={13} className="tool-call-status failed" />
    case 'result_unknown':
      return <AlertTriangle size={13} className="tool-call-status waiting_confirm" />
    case 'running':
      return <Loader2 size={13} className="tool-call-status running tool-spinner" />
    case 'waiting_confirm':
      return <AlertTriangle size={13} className="tool-call-status waiting_confirm tool-pulse" />
    case 'pending':
    default:
      return <Loader2 size={13} className="tool-call-status running" style={{ opacity: 0.3 }} />
  }
}

function statusLabel(
  status: ToolCallInfo['status'],
  text: ReturnType<typeof useLocaleStore.getState>['text'],
): string {
  switch (status) {
    case 'completed': return text('完成', 'Completed')
    case 'failed': return text('失败', 'Failed')
    case 'result_unknown': return text('结果待确认', 'Result unknown')
    case 'running': return text('执行中', 'Running')
    case 'waiting_confirm': return text('待确认', 'Waiting for confirmation')
    case 'pending': return text('等待中', 'Pending')
    default: return ''
  }
}

export default function ToolCallBlock({ toolCall }: Props) {
  const text = useLocaleStore(s => s.text)
  const [expanded, setExpanded] = useState(false)
  const { toolName, arguments: args, status, result, error, source } = toolCall

  return (
    <div className="tool-call-block">
      <div className="tool-call-header" onClick={() => setExpanded(v => !v)}>
        <div className="tool-call-icon">
          <Wrench size={12} style={{ color: 'var(--color-text-muted)' }} />
        </div>

        <span className="tool-call-name">{toolName}</span>

        {source && (
          <span className={`tool-call-source-badge ${source}`}>
            {source === 'builtin'
              ? text('内置', 'Built-in')
              : source === 'mcp'
                ? 'MCP'
                : text('Skill', 'Skill')}
          </span>
        )}

        <div className="tool-call-status" style={{ marginLeft: 'auto' }}>
          <StatusIcon status={status} />
          <span>{statusLabel(status, text)}</span>
        </div>

        <ChevronRight
          size={12}
          className={`tool-call-arrow ${expanded ? 'expanded' : ''}`}
        />
      </div>

      {expanded && (
        <div className="tool-call-body">
          {Object.keys(args).length > 0 && (
            <div className="tool-call-params">
              {JSON.stringify(args, null, 2)}
            </div>
          )}

          {result && (
            <div className="tool-call-result" style={{ position: 'relative' }}>
              {result}
              <button
                onClick={() => navigator.clipboard.writeText(result).catch(() => {})}
                className="absolute top-1 right-1 text-[0.65rem] px-1.5 py-0.5 rounded transition-opacity opacity-0 hover:opacity-100"
                style={{
                  backgroundColor: 'var(--color-hover)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
                title={text('复制结果', 'Copy result')}
              >
                {text('复制', 'Copy')}
              </button>
            </div>
          )}

          {error && (
            <div className="tool-call-result" style={{ color: 'var(--color-error-text)' }}>
              <XCircle size={13} className="inline mr-1" />{error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
