import { describe, expect, it } from 'vitest'

import { getBuiltinPromptTemplate } from '../prompt-templates'
import { parseFinalizedCharacterStateResponse, type FinalizedCharacterContext } from '../../shared/finalized-continuity'

const content = '林舟走进青石关。\n\n白鹭替林舟包扎了伤口。'
const context: FinalizedCharacterContext = {
  projectId: 'project', epoch: 'project:1',
  source: { draftId: 1, finalizationId: 'final-1', chapterNumber: 7, contentHash: 'a'.repeat(64) },
  content, projectionGeneration: 1, identityRevision: 1, identityStatus: 'bound',
  sourceOrder: { continuityEpoch: 'project:1', chapterNumber: 7, authoritativeFinalizationRevision: 1 },
  characters: [{ characterId: 'char-lin', displayNameSnapshot: '林舟', aliases: [], fields: [] }],
}

function exampleObject(template: string): Record<string, unknown> {
  const rendered = template.replaceAll('{{chapter_number}}', '7')
  const start = rendered.search(/\{\s*"updates"/u)
  let depth = 0
  for (let index = start; index < rendered.length; index += 1) {
    if (rendered[index] === '{') depth += 1
    if (rendered[index] === '}' && --depth === 0) return JSON.parse(rendered.slice(start, index + 1))
  }
  throw new Error('example JSON not found')
}

describe.each(['zh-CN', 'en-US'] as const)('built-in character-state example (%s)', language => {
  it('fills into an answer the production parser accepts, with a new person kept as a proposal', () => {
    const example = exampleObject(getBuiltinPromptTemplate('update_character_cards', language)!.content)
    const updates = example.updates as Array<Record<string, unknown>>
    updates.forEach((update, index) => {
      if ('characterId' in update) update.characterId = 'char-lin'
      else if ('name' in update) update.name = index === 0 ? '林舟' : '白鹭'
      if (update.evidence) update.evidence = { text: index === 0 ? '林舟走进青石关。' : '白鹭替林舟包扎了伤口。' }
    })

    const parsed = parseFinalizedCharacterStateResponse(JSON.stringify(example), context)

    expect(Object.keys(example)).toEqual(['updates'])
    expect(parsed.updates.map(update => update.characterId)).toEqual(['char-lin'])
    expect(parsed.unresolved.map(item => [item.displayName, item.reason])).toEqual([['白鹭', 'name-only']])
  })
})
