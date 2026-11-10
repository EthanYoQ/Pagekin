import { describe, expect, it } from 'vitest'

import type { CharacterRelationNode, ContinuityProvenance } from '../character-continuity'
import { findBlueprintContinuityRisks, type BlueprintForPreflight, type ConsistencyExemption } from '../consistency-preflight'
import { relationPolarity } from '../blueprint-relation-conflict'

const SOURCE = { draftId: 8, finalizationId: 'f8', chapterNumber: 8, contentHash: 'h8' }
const AUTHOR: ContinuityProvenance = { kind: 'author', operationId: 'op' }

function relation(value: string, effectiveChapter: number, overrides: Partial<CharacterRelationNode> = {}): CharacterRelationNode {
  return {
    eventId: `relation:${value}:${effectiveChapter}`, subjectId: 'a', subjectName: '林晚', targetId: 'b', targetName: '沈舟',
    relationshipId: `line:${value}`, aspect: 'relation', value, effectiveChapter, provenance: AUTHOR, draftId: null, seq: 1, quote: null,
    ...overrides,
  }
}

function blueprint(chapterNumber: number, relationText = '亲密同伴', overrides: Partial<BlueprintForPreflight> = {}): BlueprintForPreflight {
  return {
    chapterNumber, title: '同行', role: '发展', purpose: '两人赶路', keyEvents: '山路遇雨', characters: ['林晚', '沈舟'],
    suspenseHook: '', userGuidance: '', notes: '', relationshipHints: [{ from: '林晚', to: '沈舟', relation: relationText }],
    ...overrides,
  }
}

const check = (plan: BlueprintForPreflight, nodes: CharacterRelationNode[], exemptions: ConsistencyExemption[] = []) =>
  findBlueprintContinuityRisks([], plan, exemptions, nodes)

const BROKEN = relation('决裂', 8)

describe('蓝图关系与时间线相反', () => {
  it('第 8 章起决裂、第 12 章蓝图写亲密同伴时提示，依据写章号和关系原文', () => {
    const [finding, ...rest] = check(blueprint(12), [BROKEN])
    expect(rest).toEqual([])
    expect(finding).toMatchObject({ severity: 'warning', sourceChapter: 8, evidence: '决裂' })
    expect(finding!.issue.zhCN).toContain('第 8 章起')
    expect(finding!.issue.zhCN).toContain('亲密同伴')
    expect(finding!.issue.enUS).toContain('chapter 8')
  })

  it('反向记录的关系同样算数', () => {
    const reversed = relation('死敌', 8, { subjectId: 'b', subjectName: '沈舟', targetId: 'a', targetName: '林晚' })
    expect(check(blueprint(12), [reversed])).toHaveLength(1)
  })

  it('决裂在第 8 章才生效时，第 7 章蓝图不提示', () => {
    expect(check(blueprint(7), [BROKEN])).toEqual([])
  })

  it.each(['purpose', 'keyEvents', 'suspenseHook', 'notes', 'userGuidance'] as const)('蓝图的 %s 写了和解安排时不提示', (field) => {
    expect(check(blueprint(12, '亲密同伴', { [field]: '两人解开误会，重归于好' }), [BROKEN])).toEqual([])
  })

  it.each(['不再是亲密同伴', '普通同门', '假装亲密'])('蓝图关系「%s」认不出或带否定词时不提示', (text) => {
    expect(check(blueprint(12, text), [BROKEN])).toEqual([])
  })

  it('已有关系认不出极性时不提示', () => {
    expect(check(blueprint(12), [relation('关系微妙', 8)])).toEqual([])
  })

  it('同一对角色有一条关系不相反时不提示', () => {
    expect(check(blueprint(12), [BROKEN, relation('同门', 3)])).toEqual([])
    expect(check(blueprint(12), [BROKEN, relation('挚友', 3)])).toEqual([])
  })

  it('多条关系全部相反时按最新一条给依据', () => {
    const [finding] = check(blueprint(12), [relation('仇人', 3), BROKEN])
    expect(finding).toMatchObject({ sourceChapter: 8, evidence: '决裂' })
  })

  it('两个方向各写一条提示时只报一次', () => {
    const plan = blueprint(12, '亲密同伴', { relationshipHints: [{ from: '林晚', to: '沈舟', relation: '亲密同伴' }, { from: '沈舟', to: '林晚', relation: '挚友' }] })
    expect(check(plan, [BROKEN])).toHaveLength(1)
  })

  it('派生节点没有原文时不作依据、不提示', () => {
    expect(check(blueprint(12), [relation('决裂', 8, { provenance: { kind: 'derived', source: SOURCE }, draftId: 8 })])).toEqual([])
  })

  it('派生节点用定稿原文作依据', () => {
    const [finding] = check(blueprint(12), [relation('决裂', 8, {
      provenance: { kind: 'derived', source: SOURCE }, draftId: 8, quote: { start: 0, end: 7, text: '从此恩断义绝。' },
    })])
    expect(finding).toMatchObject({ sourceChapter: 8, evidence: '从此恩断义绝。' })
    expect(finding!.issue.zhCN).toContain('第 8 章定稿')
    expect(finding!.issue.enUS).toContain('finalized')
  })

  it('基线节点标明是升级前的设定，不冒充章号', () => {
    const [finding] = check(blueprint(12), [relation('死敌', 5, { provenance: { kind: 'legacy' } })])
    expect(finding).toMatchObject({ sourceChapter: 0, evidence: '死敌' })
    expect(finding!.issue.zhCN).toContain('升级前的设定')
    expect(finding!.issue.enUS).toContain('before the upgrade')
  })

  it('没有节点的旧项目、没有关系提示的蓝图都不提示', () => {
    expect(check(blueprint(12), [])).toEqual([])
    expect(check(blueprint(12, '亲密同伴', { relationshipHints: undefined }), [BROKEN])).toEqual([])
  })

  it('已清除的关系不算', () => {
    expect(check(blueprint(12), [BROKEN, relation('', 9, { eventId: 'removed', relationshipId: BROKEN.relationshipId })])).toEqual([])
  })
})

describe('豁免按节点和蓝图章', () => {
  const key = check(blueprint(12), [BROKEN])[0]!.stableFactKey
  const exempt = (chapterNumber: number | null, revoked = false): ConsistencyExemption => ({ stableFactKey: key, reason: '作者确认', revoked, chapterNumber })

  it('同一节点在不同章的依据键相同', () => {
    expect(check(blueprint(20), [BROKEN])[0]!.stableFactKey).toBe(key)
  })

  it('按章豁免后该章不提示，别的章仍提示；撤销后恢复', () => {
    expect(check(blueprint(12), [BROKEN], [exempt(12)])).toEqual([])
    expect(check(blueprint(13), [BROKEN], [exempt(12)])).toHaveLength(1)
    expect(check(blueprint(12), [BROKEN], [exempt(12, true)])).toHaveLength(1)
  })

  it('全局豁免各章都不提示', () => {
    expect(check(blueprint(12), [BROKEN], [exempt(null)])).toEqual([])
    expect(check(blueprint(30), [BROKEN], [exempt(null)])).toEqual([])
  })

  it('节点换了之后旧豁免不再管用', () => {
    expect(check(blueprint(12), [relation('仇敌', 10)], [exempt(12)])).toHaveLength(1)
  })

  it('死亡规则也按章豁免', () => {
    const projections = [{
      draftId: 7, chapterNumber: 1, chapterTitle: '', chapterNotes: '', sourceStatus: 'current' as const,
      facts: [{ category: 'character-state' as const, entities: ['沈舟'], statement: '沈舟已经死亡。', sourceChapter: 1, evidence: '原文' }],
    }]
    const plan = blueprint(2, '亲密同伴', { relationshipHints: undefined })
    const [finding] = findBlueprintContinuityRisks(projections, plan, [])
    const exemptions = [{ stableFactKey: finding!.stableFactKey, reason: '回忆', revoked: false, chapterNumber: 2 }]
    expect(findBlueprintContinuityRisks(projections, plan, exemptions)).toEqual([])
    expect(findBlueprintContinuityRisks(projections, { ...plan, chapterNumber: 3 }, exemptions)).toHaveLength(1)
  })
})

describe('relationPolarity', () => {
  it.each([
    ['决裂', 'hostile'], ['反目成仇', 'hostile'], ['死敌', 'hostile'], ['宿敌', 'hostile'], ['势不两立', 'hostile'], ['水火不容', 'hostile'],
    ['亲密同伴', 'close'], ['挚友', 'close'], ['盟友', 'close'], ['恋人', 'close'], ['青梅竹马的知己', 'close'], ['夫妻', 'close'],
    ['enemy', 'hostile'], ['sworn enemies', 'hostile'], ['estranged', 'hostile'], ['close friend', 'close'], ['ally', 'close'], ['lovers', 'close'],
  ] as const)('%s 判为 %s', (text, expected) => {
    expect(relationPolarity(text)).toBe(expected)
  })

  it.each([
    '不再敌对', '并非盟友', '前盟友', '昔日好友', '曾经的恋人', '假盟友', '表面盟友', '同盟破裂', '盟友还是敌人',
    '亦敌亦友', '同门', '师徒', '暗恋', '兄弟', '关系微妙', '',
    'not an enemy', 'no longer friends', 'former ally', 'ex-lover', 'fake friends', 'rival', 'unfriendly neighbor', 'friend or foe',
  ])('「%s」认不出极性，宁可漏报', (text) => {
    expect(relationPolarity(text)).toBeNull()
  })
})
