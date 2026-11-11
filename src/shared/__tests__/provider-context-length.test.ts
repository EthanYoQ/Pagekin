import { describe, expect, it } from 'vitest'
import samples from '../../../electron/llm/__tests__/provider-context-length-samples.json'
import { parseProviderContextLength } from '../provider-context-length'

describe('服务商超长报错里的真实窗口', () => {
  it.each([
    ['DeepSeek 样本', JSON.stringify(samples.deepseek), 1_048_576],
    ['硅基流动样本', JSON.stringify(samples.siliconflow), 32_768],
    ['硅基流动 2026-11-09 实测的新形状', JSON.stringify(samples.siliconflowMaxPromptTokens), 1_048_576],
    ['硅基流动最大输出样本', JSON.stringify(samples.siliconflowMaxTokens), 32_768],
    ['Gemini 样本', JSON.stringify(samples.gemini), 1_048_576],
    ['Anthropic 提示词超长', 'prompt is too long: 250000 tokens > 200000 maximum', 200_000],
    ['Anthropic 输入加输出超限', 'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000', 200_000],
  ])('%s', (_name, body, windowTokens) => {
    expect(parseProviderContextLength(body)).toEqual({ exceeded: true, windowTokens })
  })

  it.each([
    ['Gemini 不带上限的旧形状', 'The input token count (1200000) exceeds the maximum number of tokens'],
    ['窗口写成 0', "This model's maximum context length is 0 tokens"],
  ])('超长但读不出可用窗口：%s', (_name, body) => {
    expect(parseProviderContextLength(body)).toEqual({ exceeded: true, windowTokens: null })
  })

  it.each([
    ['模型名错误', '{"error":{"message":"Invalid model name"}}'],
    ['限流里带数字', 'Rate limit reached: limit 1048576 tokens per minute'],
    ['空正文', ''],
  ])('不是超长：%s', (_name, body) => {
    expect(parseProviderContextLength(body)).toEqual({ exceeded: false, windowTokens: null })
  })
})
