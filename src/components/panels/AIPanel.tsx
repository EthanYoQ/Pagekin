import { useEffect } from 'react'
import { useLLMStore } from '../../stores/llm-store'
import AgentHeader from './agent/AgentHeader'
import AgentConversation from './agent/AgentConversation'

export default function AIPanel() {
  const init = useLLMStore(s => s.init)
  const loaded = useLLMStore(s => s.loaded)
  useEffect(() => {
    if (!loaded) init()
  }, [init, loaded])

  return (
    <div className="writer-ai-panel w-full h-full flex flex-col overflow-hidden">
      <AgentHeader />

      <div className="flex-1 overflow-hidden">
        <AgentConversation />
      </div>
    </div>
  )
}
