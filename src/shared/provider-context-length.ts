export interface ProviderContextLengthVerdict {
  exceeded: boolean
  windowTokens: number | null
}

const CONTEXT_LENGTH_RULES = [
  // OpenAI 兼容协议（DeepSeek 实测）
  /maximum context length is (?<window>\d+) tokens/iu,
  // 硅基流动（实测）：提示词超长，或最大输出本身超过上下文
  /input tokens \(\d+\) has exceeded max_(?:seq_len|prompt_tokens) \((?<window>\d+)\)/iu,
  /max_tokens \(\d+\) have exceeded max_seq_len \((?<window>\d+)\)/iu,
  // Gemini；没有 key，未实测。
  /input token count \(\d+\) exceeds the maximum number of tokens(?: allowed \((?<window>\d+)\))?/iu,
  // Anthropic：提示词超长，或输入加 max_tokens 超过上下文
  /prompt is too long: \d+ tokens? > (?<window>\d+) maximum/iu,
  /input length and `?max_tokens`? exceed context limit: \d+ \+ \d+ > (?<window>\d+)/iu,
]

export function parseProviderContextLength(body: string): ProviderContextLengthVerdict {
  for (const rule of CONTEXT_LENGTH_RULES) {
    const match = rule.exec(body)
    if (!match) continue
    const tokens = Number(match.groups?.window)
    return { exceeded: true, windowTokens: Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null }
  }
  return { exceeded: false, windowTokens: null }
}
