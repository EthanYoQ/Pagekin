import { parseProviderContextLength } from '../../src/shared/provider-context-length'

export async function providerFailureCode(response: Response, options: { signal: AbortSignal; onContextWindow?: (tokens: number) => void }): Promise<'LLM_CONTEXT_LENGTH_EXCEEDED' | 'LLM_REQUEST_FAILED'> {
  if (response.status !== 400) {
    void response.body?.cancel().catch(() => {})
    return 'LLM_REQUEST_FAILED'
  }
  let body = ''
  try { body = await response.text() }
  catch (error) {
    if (options.signal.aborted) throw error
  }
  const { exceeded, windowTokens } = parseProviderContextLength(body)
  if (windowTokens !== null) options.onContextWindow?.(windowTokens)
  return exceeded ? 'LLM_CONTEXT_LENGTH_EXCEEDED' : 'LLM_REQUEST_FAILED'
}
