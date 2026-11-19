import { describe, expect, it } from 'vitest'
import { aiSourceOf, parseAiSources, recordAiSources } from '../novel-config-ai-sources'
import type { NovelConfig } from '../ipc-channels'

const withSources = (config: Partial<NovelConfig>, written: Partial<NovelConfig>): Partial<NovelConfig> =>
  ({ ...config, ...written, aiSources: recordAiSources(config, written) })

describe('设定细则的 AI 来源标记', () => {
  it('空着的项由 AI 写入记作 AI 填写，作者原有内容被补写记作 AI 扩写', () => {
    const config = withSources({ worldSetting: '', writingStyle: '冷峻' }, { worldSetting: '雾城', writingStyle: '冷峻，短句多' })
    expect(aiSourceOf(config, 'worldSetting')).toBe('filled')
    expect(aiSourceOf(config, 'writingStyle')).toBe('expanded')
    expect(aiSourceOf(config, 'goldenFinger')).toBeNull()
  })

  it('作者改了这一项，标记消失；其他项的标记不受影响', () => {
    const filled = withSources({}, { worldSetting: '雾城', goldenFinger: '回溯' })
    const edited = { ...filled, worldSetting: '雾城，常年下雨' }
    expect(aiSourceOf(edited, 'worldSetting')).toBeNull()
    expect(aiSourceOf(edited, 'goldenFinger')).toBe('filled')
  })

  it('AI 再写别的项时，没动的项保留仍有效的标记，已被作者改过的不会复活', () => {
    const first = withSources({}, { worldSetting: '雾城', goldenFinger: '回溯' })
    const authorEdited = { ...first, goldenFinger: '回溯三秒' }
    const second = withSources(authorEdited, { referenceWorks: '《雪中》' })
    expect(aiSourceOf(second, 'worldSetting')).toBe('filled')
    expect(aiSourceOf(second, 'goldenFinger')).toBeNull()
    expect(aiSourceOf(second, 'referenceWorks')).toBe('filled')
  })

  it('整项由 AI 写的内容再被 AI 补写，仍记 AI 填写', () => {
    const first = withSources({}, { worldSetting: '雾城' })
    const second = withSources(first, { worldSetting: '雾城，常年下雨' })
    expect(aiSourceOf(second, 'worldSetting')).toBe('filled')
  })

  it('AI 写回的内容和原来一样或是空白，不打标记', () => {
    const config = withSources({ worldSetting: '雾城' }, { worldSetting: '雾城', goldenFinger: '   ' })
    expect(aiSourceOf(config, 'worldSetting')).toBeNull()
    expect(aiSourceOf(config, 'goldenFinger')).toBeNull()
  })

  it.each([
    ['坏 JSON', '{not json'],
    ['数组', '[1]'],
    ['null', null],
    ['种类不认识', JSON.stringify({ worldSetting: { kind: 'human', hash: 'x' } })],
    ['指纹不是字符串', JSON.stringify({ worldSetting: { kind: 'filled', hash: 1 } })],
  ])('库里的标记是%s时当作没有标记', (_name, raw) => {
    expect(parseAiSources(raw)).toEqual({})
  })

  it('设定值类型不对时按空内容处理，不抛错', () => {
    const config = { worldSetting: 42 as unknown as string, aiSources: { worldSetting: { kind: 'filled' as const, hash: '00000000' } } }
    expect(aiSourceOf(config, 'worldSetting')).toBeNull()
    expect(() => recordAiSources(config, { goldenFinger: '回溯' })).not.toThrow()
  })
})
