import { Plus, MoreHorizontal, Server, Sparkles, ChevronRight, History } from 'lucide-react'
import { useAgentStore } from '../../../stores/agent-store'
import { useMCPStore } from '../../../stores/mcp-store'
import { skillRegistry, type LoadedSkill } from '../../../services/agent/skill-registry'
import { useRef, useState } from 'react'
import { confirm } from '../../ui/Confirm'
import { Button } from '../../ui/Button'
import { MenuItem } from '../../ui/MenuItem'
import { useOutsideClick } from '../../../hooks/useOutsideClick'
import { useLocaleStore } from '../../../stores/locale-store'
import { pluralEn } from '../../../shared/plural-en'

export default function AgentHeader() {
  const text = useLocaleStore(s => s.text)
  const { createConversation, toggleHistory, showHistory, getActiveConversation } = useAgentStore()
  const [showMore, setShowMore] = useState(false)
  const [subView, setSubView] = useState<'main' | 'mcp' | 'skills'>('main')
  const moreRef = useRef<HTMLDivElement>(null)

  useOutsideClick(moreRef, () => { setShowMore(false); setSubView('main') }, showMore)

  const { servers: mcpServers, tools: mcpTools } = useMCPStore()
  const connectedCount = mcpServers.filter(s => s.status === 'connected').length

  const skills = skillRegistry.listAll()

  const handleNew = () => {
    createConversation()
  }

  const activeConv = getActiveConversation()
  const isCurrentEmpty = !activeConv || activeConv.messages.filter(m => m.role !== 'system').length === 0
  const newLabel = isCurrentEmpty ? text('当前对话为空，请先发送消息', 'The current conversation is empty') : text('新建对话', 'New conversation')

  return (
    <div
      className="no-select flex items-center justify-between gap-1.5 px-2 flex-shrink-0"
      style={{
        height: 'var(--height-panel-header)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <div
        className="flex min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap gap-1"
        style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', fontWeight: 500 }}
      >
        {text('AI 写作助手', 'AI Writing Assistant')}
      </div>

      <div className="flex items-center gap-1.5 px-0.5 flex-shrink-0">

        <Button
          variant="icon"
          size="sm"
          aria-label={newLabel}
          title={newLabel}
          disabled={isCurrentEmpty}
          onClick={handleNew}
        >
          <Plus size={13} strokeWidth={1.5} />
        </Button>

        <Button
          variant="icon"
          size="sm"
          aria-label={text('历史对话', 'Conversation history')}
          title={text('历史对话', 'Conversation history')}
          onClick={toggleHistory}
          aria-pressed={showHistory}
        >
          <History size={15} strokeWidth={1.5} />
        </Button>

        <div className="relative" ref={moreRef}>
          <Button
            variant="icon"
            size="sm"
            aria-label={text('更多选项', 'More options')}
            title={text('更多选项', 'More options')}
            onClick={() => { setShowMore(v => !v); setSubView('main') }}
            aria-expanded={showMore}
          >
            <MoreHorizontal size={15} strokeWidth={1.5} />
          </Button>

          {showMore && (
            <div
              className="absolute right-0 top-full mt-1 z-50 py-1 rounded-lg shadow-lg"
              style={{
                width: subView === 'main' ? 200 : 260,
                backgroundColor: 'var(--color-sidebar)',
                border: '1px solid var(--color-border)',
                boxShadow: 'var(--shadow-popover)',
              }}
            >
              {subView === 'main' && (
                <>
                  <MenuItem
                    label={text('MCP 服务器', 'MCP servers')}
                    icon={<Server size={13} />}
                    shortcut={connectedCount > 0 ? text(`${connectedCount} 在线`, `${connectedCount} online`) : ''}
                    onClick={() => setSubView('mcp')}
                  />
                  <MenuItem
                    label={text('技能列表', 'Skills')}
                    icon={<Sparkles size={13} />}
                    shortcut={skills.length > 0 ? text(`${skills.length} 个`, `${skills.length}`) : ''}
                    onClick={() => setSubView('skills')}
                  />
                  <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
                  <MenuItem
                    label={text('清空所有对话', 'Clear all conversations')}
                    danger
                    onClick={async () => {
                      setShowMore(false)
                      const ok = await confirm(text('确定要清空所有对话记录？\n此操作不可撤销。', 'Clear all conversation history?\nThis cannot be undone.'), {
                        title: text('清空对话记录', 'Clear conversation history'),
                        confirmText: text('确认清空', 'Clear all'),
                        danger: true,
                      })
                      if (ok) useAgentStore.getState().clearAll()
                    }}
                  />
                </>
              )}

              {subView === 'mcp' && (
                <MCPSubView
                  servers={mcpServers}
                  toolCount={mcpTools.length}
                  onBack={() => setSubView('main')}
                />
              )}

              {subView === 'skills' && (
                <SkillSubView
                  skills={skills}
                  onBack={() => setSubView('main')}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MCPSubView({
  servers,
  toolCount,
  onBack,
}: {
  servers: { id: string; name: string; status: string; toolCount: number; error?: string }[]
  toolCount: number
  onBack: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const connectedCount = servers.filter(s => s.status === 'connected').length

  return (
    <>
      <button
        onClick={onBack}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
        <span className="font-medium">{text('MCP 服务器', 'MCP servers')}</span>
        <span className="ml-auto text-[0.68rem] opacity-50">
          {text(`${connectedCount}/${servers.length} 在线`, `${connectedCount}/${servers.length} online`)}
        </span>
      </button>

      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />

      {servers.length === 0 ? (
        <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          <div className="mb-1">{text('暂无 MCP 服务器', 'No MCP servers')}</div>
          <div className="text-[0.68rem] opacity-60">
            {text('在用户配置目录中配置 MCP 服务器', 'Configure MCP servers in your user configuration directory')}
          </div>
        </div>
      ) : (
        <div className="py-1 max-h-[200px] overflow-y-auto">
          {servers.map(server => (
            <div
              key={server.id}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <span
                className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
                style={{
                  backgroundColor:
                    server.status === 'connected' ? 'var(--color-success)'
                    : server.status === 'connecting' ? 'var(--color-warning)'
                    : server.status === 'error' ? 'var(--color-error)'
                    : 'var(--color-text-muted)',
                }}
              />
              <span
                className="flex-1 truncate font-medium"
                style={{ color: 'var(--color-text)' }}
              >
                {server.name}
              </span>
              {server.status === 'connected' && server.toolCount > 0 && (
                <span className="text-[0.65rem] opacity-50 flex-shrink-0">
                  {server.toolCount} tools
                </span>
              )}
              {server.status === 'error' && (
                <span
                  className="text-[0.65rem] text-[var(--color-error-text)] truncate max-w-[80px]"
                  title={text('服务器连接失败', 'Server connection failed')}
                >
                  {text('错误', 'Error')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {toolCount > 0 && (
        <>
          <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />
          <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(`共 ${toolCount} 个 MCP 工具已注册`, `${toolCount} MCP tools registered`)}
          </div>
        </>
      )}
    </>
  )
}

function SkillSubView({
  skills,
  onBack,
}: {
  skills: LoadedSkill[]
  onBack: () => void
}) {
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  const sourceBadge = (source: string) => {
    switch (source) {
      case 'builtin': return { bg: 'color-mix(in srgb, var(--color-info) 12%, transparent)', color: 'var(--color-info)', label: text('内置', 'Built-in') }
      case 'user': return { bg: 'color-mix(in srgb, var(--color-accent) 12%, transparent)', color: 'var(--color-accent)', label: text('用户', 'User') }
      case 'project': return { bg: 'color-mix(in srgb, var(--color-success) 12%, transparent)', color: 'var(--color-success-text)', label: text('项目', 'Project') }
      default: return { bg: 'var(--color-hover)', color: 'var(--color-text-muted)', label: source }
    }
  }

  return (
    <>
      <button
        onClick={onBack}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
        <span className="font-medium">{text('技能列表', 'Skills')}</span>
        <span className="ml-auto text-[0.68rem] opacity-50">
          {text(`${skills.length} 个技能`, `${skills.length} ${pluralEn(skills.length, 'skill')}`)}
        </span>
      </button>

      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />

      {skills.length === 0 ? (
        <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          <div className="mb-1">{text('暂无可用技能', 'No skills available')}</div>
          <div className="text-[0.68rem] opacity-60">
            {text('在用户技能目录放入 SKILL.md 文件', 'Add SKILL.md files to your user skills directory')}
          </div>
        </div>
      ) : (
        <div className="py-1 max-h-[240px] overflow-y-auto">
          {skills.map(skill => {
            const badge = sourceBadge(skill.source)
            return (
              <div
                key={skill.metadata.name}
                className="flex items-start gap-2 px-3 py-1.5 text-xs"
              >
                <Sparkles size={12} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-accent)' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {locale === 'en-US'
                        ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
                        : (skill.metadata.displayName ?? skill.metadata.name)}
                    </span>
                    <span
                      className="text-[0.6rem] px-1 py-0 rounded flex-shrink-0"
                      style={{ backgroundColor: badge.bg, color: badge.color }}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div
                    className="text-[0.68rem] truncate mt-0.5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {locale === 'en-US'
                      ? skill.writingSkill.metadata.description
                      : skill.metadata.description}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />
      <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {text('输入', 'Type')} <code className="px-0.5 rounded" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}>/</code> {text('可快速调用技能', 'to quickly invoke a skill')}
      </div>
    </>
  )
}
