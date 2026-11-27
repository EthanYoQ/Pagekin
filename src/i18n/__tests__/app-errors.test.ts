import { describe, expect, it } from 'vitest'
import { appErrorMessage, archiveFailureMessage, damagedReviewCycleMessage, omittedReviewCyclesMessage, displayedErrorMessage, englishWithReason, errorCodeOf, errorMessageForModel, failureText, importStopFailure, knownAppErrorMessage, legacyImportFailureMessage, projectOpenFailureMessage } from '../app-errors'
import { shown } from './shown-locale'
import { translate } from '../core'

describe('localized application errors', () => {
  it('maps stable error codes to localized messages', () => {
    expect(appErrorMessage(shown('en-US'), { code: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' }))
      .toContain('Windows native component')
    expect(appErrorMessage(shown('zh-CN'), { code: 'PROJECT_NOT_OPEN' }))
      .toBe('请先打开项目。')
    expect(appErrorMessage(shown('en-US'), { errorCode: 'PROJECT_NOT_OPEN' }))
      .toBe('Open a project first.')
    expect(appErrorMessage(shown('zh-CN'), { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('project.json 的小说文件夹')
    expect(appErrorMessage(shown('en-US'), { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('Select the novel folder')
    expect(appErrorMessage(shown('zh-CN'), new Error('SOURCE_CHANGED_SINCE_PROBE')))
      .toContain('打开期间作品文件被其他程序改动')
  })

  it('explains an archive that stopped on an unsafe projection instead of showing the raw code', () => {
    expect(appErrorMessage(shown('zh-CN'), { errorCode: 'PORTABLE_UNSAFE_PROJECTION' })).toBe('作品没有改动。有一项数据无法安全打包，存档没有生成。请把这条提示反馈给我们。')
    expect(displayedErrorMessage(shown('en-US'), new Error('PORTABLE_UNSAFE_PROJECTION'))).toContain('Your book is unchanged.')
  })

  it('导出重来一次资料仍被改：说明作品没动、资料被改了、再点哪个按钮，不露原码（#744）', () => {
    const code = 'PORTABLE_EXPORT_SOURCE_CHANGED'
    expect(displayedErrorMessage(shown('zh-CN'), new Error(code))).toBe('作品没有改动。导出时资料被改了，存档没有生成。请再点「导出本地存档」。')
    expect(displayedErrorMessage(shown('en-US'), new Error(code))).toBe('Your book is unchanged. Files changed during export, so no archive was created. Click Export local archive again.')
    expect(displayedErrorMessage(shown('ja-JP'), new Error(code))).not.toContain(code)
  })

  it('导出时头像文件坏了：说明作品没动、哪类资料坏了、在哪个按钮修，不说资料被改（#744）', () => {
    const code = 'PORTABLE_EXPORT_AVATAR_DAMAGED'
    expect(displayedErrorMessage(shown('zh-CN'), new Error(code))).toBe('作品没有改动。有个角色头像文件坏了或不见了，存档没有生成。请在人物页给头像没显示的角色「选择头像」，再点「导出本地存档」。')
    expect(displayedErrorMessage(shown('en-US'), new Error(code))).toBe('Your book is unchanged. A character avatar file is damaged or missing, so no archive was created. On the character page, click Choose avatar for the character whose avatar is missing, then Export local archive again.')
    expect(displayedErrorMessage(shown('ja-JP'), new Error(code))).not.toContain(code)
  })

  it('导出中途意外停止：说明作品没动、所选位置可能已有存档、换名再导，不露原码（#702）', () => {
    const code = 'PORTABLE_EXPORT_INTERRUPTED'
    expect(displayedErrorMessage(shown('zh-CN'), new Error(code))).toBe('作品没有改动。导出中途意外停止，所选位置可能留下了存档文件。请换个文件名，再点「导出本地存档」。')
    expect(displayedErrorMessage(shown('en-US'), new Error(code))).toBe('Your book is unchanged. Export stopped unexpectedly, and an archive file may remain at the chosen location. Click Export local archive again and choose a new file name.')
    expect(displayedErrorMessage(shown('ja-JP'), new Error(code))).not.toContain(code)
    expect(displayedErrorMessage(shown('ja-JP'), new Error(code))).not.toContain('作成されませんでした')
  })

  it.each(['PORTABLE_ARCHIVE_SOURCE_CHANGED', 'PORTABLE_ARCHIVE_SOURCE_UNSAFE'])('恢复时存档被改（%s）：不叫作者去点导出（#744）', code => {
    expect(displayedErrorMessage(shown('zh-CN'), new Error(code))).not.toContain('导出')
    expect(displayedErrorMessage(shown('en-US'), new Error(code))).not.toContain('Export')
  })

  it('preserves an unknown error as localized diagnostic text', () => {
    expect(appErrorMessage(shown('en-US'), new Error('disk full'))).toBe('Something went wrong: disk full')
  })
})

it.each(['KNOWLEDGE_BASE_NATIVE_UNAVAILABLE','LEGACY_VECTOR_MIGRATION_BLOCKED'])('maps knowledge preparation IPC error %s without exposing internal details', code => {
 expect(appErrorMessage(shown('en-US'),new Error(`Error invoking remote method 'generation:prepare-draft-context': Error: ${code}`)))
   .toBe(appErrorMessage(shown('en-US'),{errorCode:code}))
})

describe('generation error codes from the main process', () => {
  it.each([
    ["Error invoking remote method 'generation:commit-draft': Error: GENERATION_DRAFT_DEPENDENCY_STALE", '前一章'],
    ["Error invoking remote method 'generation:begin': Error: GENERATION_DRAFT_NOT_CURRENT", '当前稿'],
    ["Error invoking remote method 'review-revision:prepare': Error: GENERATION_REVIEW_LINEAGE_UNPROVEN", '重新审稿'],
    ["Error invoking remote method 'character-proposal:list-pending-finalized': Error: GENERATION_PROJECT_SESSION_STALE", '重新打开'],
    ['Error: GENERATION_REQUEST_FAILED', '重试'],
    ["Error invoking remote method 'finalization-generation:commit': Error: FINALIZED_CHARACTER_SOURCE_CONFLICT", '当前状态'],
    ["Error invoking remote method 'finalization-generation:commit': Error: FINALIZED_CHARACTER_FIELD_CONFLICT", '生成期间'],
    ["Error invoking remote method 'review-revision:prepare': Error: GENERATION_REVIEW_RESTORED_HISTORY", '恢复前'],
  ])('turns %s into a full sentence without the IPC wrapper', (raw, hint) => {
    for (const error of [raw, new Error(raw)]) {
      const zh = knownAppErrorMessage(shown('zh-CN'), error)
      expect(zh).toContain(hint)
      expect(zh).not.toMatch(/Error invoking|GENERATION_|FINALIZED_/u)
      expect(knownAppErrorMessage(shown('en-US'), error)).toMatch(/^[A-Z][^_]+\.$/u)
    }
  })

  it('tells the author a pre-restore review cannot drive a revision or recheck, and names the Review again button (#702)', () => {
    const error = new Error("Error invoking remote method 'review-revision:prepare': Error: GENERATION_REVIEW_RESTORED_HISTORY")
    const generic = new Error('GENERATION_REVIEW_LINEAGE_UNPROVEN')
    for (const [locale, restored, button] of [['zh-CN', '恢复', '「重新审稿」'], ['en-US', 'restore', '“Review again”'], ['ja-JP', '復元', '「Review again」']] as const) {
      const message = knownAppErrorMessage(shown(locale), error)
      expect(message).toContain(restored)
      expect(message).toContain(button)
      expect(message).not.toBe(knownAppErrorMessage(shown(locale), generic))
    }
  })

  it('审稿或修稿交给 AI 的内容超过上限：前文、设定、蓝图已不计入，叫作者缩短本章正文或自己填的要求，缩了仍超限时有反馈出路（#702）', () => {
    const error = new Error("Error invoking remote method 'generation:begin': Error: GENERATION_REVIEW_CONTEXT_TOO_LARGE")
    for (const [locale, notCounted, shorten, fallback] of [
      ['zh-CN', /前文|设定|蓝图/u, /缩短本章正文或你填的要求/u, /反馈给我们/u],
      ['en-US', /earlier chapters|settings|blueprint/iu, /Shorten this chapter or your guidance/u, /report this message to us/u],
      ['ja-JP', /前の章|設定|ブループリント/u, /この章の本文か指示を短く/u, /このメッセージをご報告ください/u],
    ] as const) {
      const message = knownAppErrorMessage(shown(locale), error)!
      expect(message).not.toMatch(notCounted)
      expect(message).toMatch(shorten)
      expect(message).toMatch(fallback)
      expect(message).not.toContain('GENERATION_REVIEW_CONTEXT_TOO_LARGE')
    }
  })

  it('写作材料没能核对上（定稿回执、来源上限或旧审稿都会报）：不猜是审稿，也不叫作者再点「AI 审稿」（#702）', () => {
    const error = new Error("Error invoking remote method 'generation:resume': Error: GENERATION_MATERIAL_DECISION_INVALID")
    for (const [locale, kept, review] of [['zh-CN', '作品内容没有变动', /审稿/u], ['en-US', 'Your book is unchanged', /review/iu], ['ja-JP', '作品の内容は変更されていません', /レビュー|review/iu]] as const) {
      const message = knownAppErrorMessage(shown(locale), error)!
      expect(message).toContain(kept)
      expect(message).not.toMatch(review)
      expect(message).not.toContain('GENERATION_MATERIAL_DECISION_INVALID')
    }
  })

  it('leaves unregistered codes and prose to the caller', () => {
    expect(knownAppErrorMessage(shown('zh-CN'), "Error invoking remote method 'generation:begin': Error: GENERATION_SOMETHING_NEW")).toBeUndefined()
    expect(knownAppErrorMessage(shown('zh-CN'), '模型服务返回 HTTP 429')).toBeUndefined()
  })
})

it('does not promise that a stale-session action never ran', () => {
  const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_PROJECT_SESSION_STALE"
  const zh = knownAppErrorMessage(shown('zh-CN'), raw)!, en = knownAppErrorMessage(shown('en-US'), raw)!
  expect(zh).toContain('结果不可用')
  expect(zh).not.toMatch(/没有执行|未执行/u)
  expect(en).toContain('result')
  expect(en).not.toMatch(/did not run|was not run/iu)
})

it.each(['GENERATION_MODEL_CHANGED', 'GENERATION_IMPORT_MODEL_CHANGED', 'GENERATION_SOURCE_CHANGED_MODEL'])('explains %s mid-generation instead of falling back to the raw code', code => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage(shown('zh-CN'), wrapped)).toContain('模型设置被修改')
  expect(knownAppErrorMessage(shown('en-US'), wrapped)).toContain('model settings changed')
})

it.each([
  ['GENERATION_SKILL_BUNDLE_DAMAGED', '重新导入', 'import'],
  ['GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE', '生成记录已变化', 'generation record changed'],
])('explains %s instead of falling back to the raw code', (code, zh, en) => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage(shown('zh-CN'), wrapped)).toContain(zh)
  expect(knownAppErrorMessage(shown('en-US'), wrapped)).toContain(en)
})

it.each(['GENERATION_DRAFT_NOT_CURRENT', 'GENERATION_FINALIZED_SOURCE_NOT_CURRENT'])('does not promise that %s happened before any model request', code => {
  const raw = `Error invoking remote method 'generation:commit-draft': Error: ${code}`
  expect(knownAppErrorMessage(shown('zh-CN'), raw)).not.toMatch(/没有调用模型|未调用模型/u)
  expect(knownAppErrorMessage(shown('en-US'), raw)).not.toMatch(/no model request/iu)
})

it('does not blame a book switch when the request carried no session at all', () => {
  const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_PROJECT_SESSION_REQUIRED"
  const zh = knownAppErrorMessage(shown('zh-CN'), raw)!, en = knownAppErrorMessage(shown('en-US'), raw)!
  expect(zh).toContain('重新打开')
  expect(zh).not.toContain('已切换')
  expect(en).not.toMatch(/switched/iu)
})

it.each([
  'GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT',
  'GENERATION_ASSET_CHANGED_DURING_SNAPSHOT',
  'GENERATION_REVIEW_CONTEXT_CHANGED',
  'GENERATION_AUTHOR_DRAFT_CHANGED',
])('explains %s as a mid-run source change', code => {
  const wrapped = `Error invoking remote method 'generation:begin': Error: ${code}`
  expect(knownAppErrorMessage(shown('zh-CN'), wrapped)).toBe(knownAppErrorMessage(shown('zh-CN'), 'GENERATION_SOURCE_CHANGED'))
  expect(knownAppErrorMessage(shown('en-US'), wrapped)).toBe(knownAppErrorMessage(shown('en-US'), 'GENERATION_SOURCE_CHANGED'))
})

it.each(['CHARACTER_ID_REVISION_CONFLICT', 'CHARACTER_ID_UNKNOWN'])('explains %s without assuming a proposal is open', code => {
  expect(knownAppErrorMessage(shown('en-US'), code)).not.toMatch(/proposal/iu)
  expect(knownAppErrorMessage(shown('zh-CN'), code)).not.toContain('提议')
})

describe('project session and external file errors from the main process (#474 B4)', () => {
  it.each([
    ["Error invoking remote method 'db:draft-list': ProjectSessionStaleError: PROJECT_SESSION_DATABASE_MISMATCH", 'The project was switched or reopened'],
    ['ProjectSessionStaleError: PROJECT_SESSION_STALE', 'The project was switched or reopened'],
    ["Error invoking remote method 'kb:stats': Error: PROJECT_SESSION_REQUIRED", 'did not carry the session of the open project'],
    ['Error: PROJECT_CONTEXT_CHANGED', 'The project was switched or reopened'],
    ["Error invoking remote method 'project:create': Error: EXTERNAL_FILE_GRANT_EXPIRED", 'Choose it again'],
  ])('explains %s in English without the wrapper or the code', (raw, english) => {
    expect(appErrorMessage(shown('en-US'), raw)).toContain(english)
    expect(appErrorMessage(shown('en-US'), raw)).not.toMatch(/Error|PROJECT_|EXTERNAL_/u)
    expect(appErrorMessage(shown('zh-CN'), raw)).not.toMatch(/[A-Z]{3,}_/u)
  })

  it('translates a registered code thrown by a dialog handler and keeps renderer copy as is', () => {
    const exists = new Error("Error invoking remote method 'dialog:select-project-archive-export': Error: PROJECT_ARCHIVE_TARGET_EXISTS")
    expect(displayedErrorMessage(shown('en-US'), exists)).toBe('The target file already exists. Choose another file name; project archives never overwrite existing files.')
    expect(displayedErrorMessage(shown('zh-CN'), exists)).toBe('目标文件已存在，请选择其他文件名。项目存档不会覆盖已有文件。')
    expect(displayedErrorMessage(shown('en-US'), new Error('Could not open the archive.'))).toBe('Could not open the archive.')
  })
})

describe('显示处统一的报错说明（#474 渲染层消费处）', () => {
  it.each(['zh-CN', 'en-US'] as const)('%s：剥掉通道与类名前缀再认码，认不出的保留原文，没有内容时用兜底', locale => {
    const stale = knownAppErrorMessage(shown(locale), 'PROJECT_SESSION_STALE')!
    for (const raw of [
      'PROJECT_SESSION_STALE',
      'Error: PROJECT_SESSION_STALE',
      new Error('PROJECT_SESSION_STALE'),
      new Error("Error invoking remote method 'kb:clear-all': Error: PROJECT_SESSION_STALE"),
      { errorCode: 'PROJECT_SESSION_STALE' },
    ]) expect(displayedErrorMessage(shown(locale), raw, '兜底')).toBe(stale)
    expect(displayedErrorMessage(shown(locale), "Error invoking remote method 'fs:read': Error: EBUSY: resource busy", '兜底')).toBe('EBUSY: resource busy')
    expect(displayedErrorMessage(shown(locale), new Error("Error invoking remote method 'fs:read': TypeError: boom"), '兜底')).toBe('boom')
    expect(displayedErrorMessage(shown(locale), '模型服务返回 HTTP 429', '兜底')).toBe('模型服务返回 HTTP 429')
    for (const empty of [undefined, null, '', '  ', new Error('')]) expect(displayedErrorMessage(shown(locale), empty, '兜底')).toBe('兜底')
    expect(displayedErrorMessage(shown(locale), { message: '磁盘只读' }, '兜底')).toBe('磁盘只读')
    expect(displayedErrorMessage(shown(locale), { success: false }, '兜底')).toBe('兜底')
  })

  const unregistered = 'ERR_L1_NEVER_REGISTERED_PROBE'
  const codeShaped = [
    unregistered,
    `Error: ${unregistered}`,
    new Error(unregistered),
    new Error(`Error invoking remote method 'project-archive:export': Error: ${unregistered}`),
    { message: unregistered },
  ]
  it.each(['zh-CN', 'en-US', 'ja-JP'] as const)('%s：未登记的码不原样给作者看，换成这种界面语言的通用说明（#702）', locale => {
    const general = translate(locale, 'error.unregisteredCode')
    for (const raw of codeShaped) {
      expect(displayedErrorMessage(shown(locale), raw)).toBe(general)
      expect(appErrorMessage(shown(locale), raw)).toBe(general)
    }
  })

  it.each(['zh-CN', 'en-US', 'ja-JP'] as const)('%s：未登记的码有调用处自己的说明时用它', locale => {
    expect(displayedErrorMessage(shown(locale), new Error(unregistered), '草稿保存失败')).toBe('草稿保存失败')
  })

  it.each(['zh-CN', 'en-US', 'ja-JP'] as const)('%s：不是码形的原文照常显示', locale => {
    expect(displayedErrorMessage(shown(locale), '模型服务返回 HTTP 429')).toBe('模型服务返回 HTTP 429')
    expect(displayedErrorMessage(shown(locale), new Error('Could not save the draft.'))).toBe('Could not save the draft.')
    expect(displayedErrorMessage(shown(locale), `Error: ${unregistered}: 第 3 章`)).toBe(`${unregistered}: 第 3 章`)
    expect(displayedErrorMessage(shown(locale), 'ENOENT')).toBe('ENOENT')
  })

  it('回给模型的工具结果保留未登记的码，便于模型和排查读到原因', () => {
    expect(errorMessageForModel('zh-CN', new Error(`Error invoking remote method 'fs:read': Error: ${unregistered}`))).toBe(unregistered)
    expect(errorMessageForModel('en-US', unregistered)).toBe(unregistered)
  })

  it.each(['zh-CN', 'en-US'] as const)('%s：选好的文件夹在使用前被移动或替换时，不把 EXTERNAL_FILE_GRANT_TARGET_CHANGED 交给作者', locale => {
    const message = displayedErrorMessage(shown(locale), 'Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED')
    expect(message).not.toMatch(/EXTERNAL_FILE_GRANT|Error:/u)
    expect(appErrorMessage(shown(locale), 'Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED')).toBe(message)
  })
})

describe('cast, blueprint and draft errors from the main process (#474 B2)', () => {
  it.each([
    ['Error: DRAFT_FINALIZED_READ_ONLY', 'This chapter is finalized', '这一章已经定稿'],
    ['Error: CHARACTER_ROSTER_REVISION_STALE', 'The cast changed in the meantime', '角色名单在这期间被改动了'],
    ['Error: CHARACTER_ROSTER_RELATIONSHIP_TARGET_UNKNOWN', 'must be another character in the cast', '对象须是名单里的其他角色'],
    ["Error invoking remote method 'db:blueprint-character-sync-complete': Error: BLUEPRINT_CHARACTER_SYNC_ROSTER_NOT_READY", 'The cast needs repair first', '角色名单需要先修复'],
  ])('explains %s in the interface language without the code', (raw, english, chinese) => {
    expect(displayedErrorMessage(shown('en-US'), new Error(raw))).toContain(english)
    expect(displayedErrorMessage(shown('en-US'), new Error(raw))).not.toMatch(/[A-Z]{3,}_|\p{Script=Han}/u)
    expect(displayedErrorMessage(shown('zh-CN'), new Error(raw))).toContain(chinese)
    expect(displayedErrorMessage(shown('zh-CN'), new Error(raw))).not.toMatch(/[A-Z]{3,}_/u)
  })
})

describe('knowledge base and search index errors from the main process (#474 B3)', () => {
  it.each([
    ['KNOWLEDGE_BASE_COPY_CHANGED', 'Reopen the material', '请重新打开这份资料'],
    ['EMBEDDING_RESPONSE_INVALID', 'returned an unusable result', '返回的结果不对'],
    ["Error invoking remote method 'kb:search': Error: EMBEDDING_SPACE_REGISTRY_INVALID", 'search index records of this book are damaged', '检索索引记录已损坏'],
    ['Error: EMBEDDING_SPACE_UNREGISTERED_DATA', 'search index records of this book are damaged', '检索索引记录已损坏'],
  ])('explains %s in the interface language without the code', (raw, english, chinese) => {
    expect(appErrorMessage(shown('en-US'), raw)).toContain(english)
    expect(appErrorMessage(shown('en-US'), raw)).not.toMatch(/[A-Z]{3,}_|\p{Script=Han}/u)
    expect(appErrorMessage(shown('zh-CN'), raw)).toContain(chinese)
    expect(appErrorMessage(shown('zh-CN'), raw)).not.toMatch(/[A-Z]{3,}_/u)
  })

  it('prefers the code of a result whose error text was written in the system language', () => {
    const blocked = {
      success: false,
      errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED',
      error: '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
    }
    expect(knownAppErrorMessage(shown('en-US'), blocked)).toContain('Legacy knowledge-base data must be repaired')
  })
})

describe('model, model settings and MCP errors from the main process (#474 B6)', () => {
  it.each([
    ['Error: LLM_GLOBAL_CONFIG_CORRUPT', 'model settings file is damaged', '模型设置文件已损坏'],
    ['Error: LLM_DEFAULT_MODEL_ROLLBACK_FAILED', 'model was not deleted', '模型没有删除'],
    ['Error: LLM_STAGE_MODEL_UNAVAILABLE', 'no longer available for writing', '不能用于文本生成'],
    ['Error: LLM_STAGE_MODEL_REQUEST_INVALID', 'stage setting was not saved', '分工设置没有保存'],
    ['ModelExecutionLeaseError: MODEL_ENDPOINT_INVALID', 'Base URL is invalid', 'Base URL 无效'],
    ['GENERATION_KIMI_TEMPERATURE_INVALID', 'temperature from 0 to 1', '温度必须在 0 到 1 之间'],
    ['MCP_CONFIG_INVALID', 'MCP configuration file is damaged', 'MCP 配置文件损坏'],
    ['MCP_CONNECT_FAILED', 'Could not connect to the MCP server', 'MCP 服务器连接失败'],
    ['Error: MCP_REQUEST_TIMEOUT', 'did not respond in time', '没有及时响应'],
  ])('explains %s in the interface language without the code', (raw, english, chinese) => {
    expect(appErrorMessage(shown('en-US'), raw)).toContain(english)
    expect(appErrorMessage(shown('en-US'), raw)).not.toMatch(/[A-Z]{3,}_|\p{Script=Han}/u)
    expect(appErrorMessage(shown('zh-CN'), raw)).toContain(chinese)
    expect(appErrorMessage(shown('zh-CN'), raw)).not.toMatch(/[A-Z]{3,}_/u)
  })
})

it('names the output limit setting by its field label when that setting is invalid', () => {
  expect(appErrorMessage(shown('zh-CN'), { errorCode: 'MODEL_OUTPUT_LIMIT_INVALID' })).toContain('最大输出 Tokens')
  expect(appErrorMessage(shown('en-US'), { errorCode: 'MODEL_OUTPUT_LIMIT_INVALID' })).toContain('max output tokens')
})

describe('import generation stops (#537)', () => {
  it('reads app codes but not platform error codes such as ENOENT', () => {
    expect(errorCodeOf(new Error('GENERATION_STORAGE_FAILED'))).toBe('GENERATION_STORAGE_FAILED')
    expect(errorCodeOf(Object.assign(new Error('open failed'), { code: 'ENOENT' }))).toBeUndefined()
  })

  const nextStep = { 'zh-CN': /在导入对话框里点「继续导入」.*已提交的批次不会重做/u, 'en-US': /choose Continue import in the import dialog.*batches already committed are not redone/u } as const
  const blocked = ['GENERATION_DISPATCH_BLOCKED', 'GENERATION_DIRECTORY_CONTINUATION_BLOCKED', 'GENERATION_PARENT_INVALID'] as const

  it.each(['zh-CN', 'en-US'] as const)('tells a request limit, an active-time stop and a blocked generation apart in %s, without codes, and names the only way to finish', locale => {
    const requestLimit = failureText(shown(locale), importStopFailure('ROOT_BUDGET_EXHAUSTED'))
    const activeTime = failureText(shown(locale), importStopFailure('ROOT_BUDGET_EXHAUSTED', true))
    const blockedMessages = blocked.map(code => failureText(shown(locale), importStopFailure(code)))
    const previousAttempt = failureText(shown(locale), importStopFailure('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE'))
    const storage = failureText(shown(locale), importStopFailure('GENERATION_STORAGE_FAILED', true))
    const all = [requestLimit, activeTime, ...blockedMessages, previousAttempt, storage]
    for (const message of all) {
      expect(message).toBeTruthy()
      expect(message).not.toMatch(/[A-Z]{3,}_[A-Z]/u)
      expect(message).toMatch(nextStep[locale])
      expect(message).not.toBe(knownAppErrorMessage(shown(locale), 'GENERATION_DISPATCH_BLOCKED'))
    }
    expect(new Set([requestLimit, activeTime, blockedMessages[0], previousAttempt, storage]).size).toBe(5)
    expect(storage).not.toBe(knownAppErrorMessage(shown(locale), 'GENERATION_STORAGE_FAILED'))
    expect(new Set(blockedMessages).size).toBe(1)
    if (locale === 'en-US') for (const message of all) expect(message).not.toMatch(/\p{Script=Han}/u)
  })

  it('does not claim the request count ran out when a stop before sending may be the running time', () => {
    expect(failureText(shown('zh-CN'), importStopFailure('ROOT_BUDGET_EXHAUSTED'))).toMatch(/^这次导入的请求次数或运行时长已到上限/u)
    expect(failureText(shown('en-US'), importStopFailure('ROOT_BUDGET_EXHAUSTED'))).toMatch(/^This import reached its limit on model requests or running time/u)
  })

  it.each(['zh-CN', 'en-US'] as const)('tells an author-manuscript inference stop in %s what is saved and what the author can still do, without Start over', locale => {
    const stops: [string, boolean][] = [['ROOT_BUDGET_EXHAUSTED', false], ['ROOT_BUDGET_EXHAUSTED', true], ['GENERATION_DISPATCH_BLOCKED', false],
      ['GENERATION_STORAGE_FAILED', true], ['GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE', false]]
    const saved = { 'zh-CN': /原稿正文已经导入并保存，只是 AI 反推的设定、文风或蓝图没有做完/u, 'en-US': /manuscript text is imported and saved/u }[locale]
    const startOver = { 'zh-CN': /重新开始/u, 'en-US': /Start over/u }[locale]
    for (const [code, inFlight] of stops) {
      const author = failureText(shown(locale), importStopFailure(code, inFlight, 'author-manuscript'))
      const reference = failureText(shown(locale), importStopFailure(code, inFlight))
      expect(author).toMatch(saved)
      expect(author).not.toMatch(startOver)
      expect(author).not.toMatch(/[A-Z]{3,}_[A-Z]/u)
      expect(reference).toMatch(nextStep[locale])
      expect(failureText(shown(locale), importStopFailure(code, inFlight, 'reference'))).toBe(reference)
    }
  })

  it.each(['GENERATION_PROVIDER_FAILED', 'IMPORT_RUN_EXECUTION_STALE', 'DEADLINE_EXHAUSTED'])('leaves %s to the shared explanation', code => {
    expect(importStopFailure(code)).toBeUndefined()
  })

  it.each(['GENERATION_PARENT_INVALID', 'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE'])('registers a readable explanation for %s', code => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const message = knownAppErrorMessage(shown(locale), `Error invoking remote method 'generation:begin': Error: ${code}`)
      expect(message).toBeTruthy()
      expect(message).not.toBe(knownAppErrorMessage(shown(locale), 'GENERATION_DISPATCH_BLOCKED'))
    }
  })

  it.each(['ROOT_BUDGET_EXHAUSTED', 'GENERATION_DISPATCH_BLOCKED', 'GENERATION_DIRECTORY_CONTINUATION_BLOCKED'])('keeps the shared explanation of %s for other generation paths', code => {
    expect(knownAppErrorMessage(shown('zh-CN'), code)).toBe('这项生成已停止、暂停或用完了额度，不能再向模型发请求。需要时请重新生成。')
  })
})

describe('导入旧项目副本的拒绝原因', () => {
  const FALLBACK = '导入时出了问题'
  it.each([
    ['LEGACY_IMPORT_NOT_LEGACY_PROJECT', '不是旧版项目'],
    ['LEGACY_IMPORT_PATH_INVALID', '选择已失效'],
    ['LEGACY_IMPORT_TARGET_EXISTS', '同名文件夹'],
    ['LEGACY_IMPORT_PATH_OVERLAP', '互相包含'],
    ['PROJECT_STORAGE_PATH_UNSUPPORTED', '路径太深'],
    ['LEGACY_IMPORT_UNSUPPORTED_SOURCE', '不支持旧项目导入'],
    ['LEGACY_IMPORT_UNMAPPED_ASSET', '资料不完整'],
    ['LEGACY_IMPORT_INVALID_MANIFEST', '资料不完整'],
    ['LEGACY_IMPORT_UNSAFE_PATH', '符号链接'],
    ['LEGACY_IMPORT_TARGET_UNSAFE_PATH', '副本位置'],
    ['LEGACY_IMPORT_SOURCE_CHANGED', '别的程序占用'],
    ['LEGACY_IMPORT_COPY_CHANGED', '别的程序占用'],
    ['LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_UNAVAILABLE', '知识库'],
    ['LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_INVALID', '知识库'],
    ['LEGACY_IMPORT_IO_FAILED', '写入权限'],
    ['LEGACY_IMPORT_SQLITE_CONTENT_CHANGED', FALLBACK],
    ['LEGACY_IMPORT_SQLITE_VERIFICATION_FAILED', FALLBACK],
    ['LEGACY_IMPORT_AVATAR_UNRESOLVED', FALLBACK],
    ['LEGACY_IMPORT_AVATAR_INVALID', FALLBACK],
    ['LEGACY_IMPORT_VECTOR_INVALID', FALLBACK],
    ['LEGACY_IMPORT_IDENTITY_INVALID', FALLBACK],
    ['LEGACY_IMPORT_HISTORY_INVALID', FALLBACK],
    ['LEGACY_IMPORT_HISTORY_FREEZE_INVALID', FALLBACK],
    ['LEGACY_IMPORT_HISTORY_AUTHORITY_INVALID', FALLBACK],
    ['LEGACY_IMPORT_ROSTER_UNAVAILABLE', FALLBACK],
    ['VECTOR_MIGRATION_NOT_REGISTERED_ANYWHERE', FALLBACK],
  ])('%s 的说明先讲原文件没动，再讲原因，不露码', (code, reason) => {
    const message = legacyImportFailureMessage(shown('zh-CN'), code)
    expect(message.startsWith('没有导入，原文件没有改动。')).toBe(true)
    expect(message).toContain(reason)
    expect(message).not.toContain(code)
  })

  it('英文也给完整说明', () => {
    expect(legacyImportFailureMessage(shown('en-US'), 'LEGACY_IMPORT_IO_FAILED'))
      .toMatch(/^Nothing was imported\. Your original files were not changed\. .*write access/u)
  })
})

describe('日文界面的已登记错误', () => {
  it('按日文目录说明，句子之间不加空格；未知错误的兜底仍是英文', () => {
    expect(legacyImportFailureMessage(shown('ja-JP'), 'LEGACY_IMPORT_IO_FAILED'))
      .toMatch(/^何も取り込まれませんでした。元のファイルは変更されていません。[^ ]/u)
    expect(failureText(shown('ja-JP'), importStopFailure('GENERATION_STORAGE_FAILED', false, 'author-manuscript')))
      .toMatch(/。原稿の本文は取り込まれ/u)
    expect(displayedErrorMessage(shown('ja-JP'), 'PROJECT_NOT_OPEN')).toBe('先にプロジェクトを開いてください。')
    expect(displayedErrorMessage(shown('ja-JP'), '')).toBe('Unknown error')
  })

  it('附不附原因看界面语言：日文界面保留原因，英文界面丢掉含汉字的原因', () => {
    const japanese = displayedErrorMessage(shown('ja-JP'), 'PROJECT_NOT_OPEN')
    expect(englishWithReason(shown('ja-JP'), 'Could not merge the revision.', japanese)).toBe(`Could not merge the revision. ${japanese}`)
    expect(englishWithReason(shown('en-US'), 'Could not merge the revision.', '项目数据库未打开：ファイル.md')).toBe('Could not merge the revision.')
    expect(englishWithReason(shown('en-US'), 'Could not merge the revision.', 'disk full')).toBe('Could not merge the revision. disk full')
  })
})

describe('damagedReviewCycleMessage', () => {
  it.each([
    ['zh-CN', { chapterNumber: 2, chapterTitle: '沉船', inTrash: false }, '作品没有改动。第 2 章「沉船」有条审稿记录损坏，存档没生成。请把这条提示反馈给我们。'],
    ['zh-CN', { chapterNumber: 2, chapterTitle: '沉船', inTrash: true }, '作品没有改动。回收站里第 2 章「沉船」有条审稿记录损坏，存档没生成。请把这条提示反馈给我们。'],
    ['en-US', { chapterNumber: 2, chapterTitle: '', inTrash: false }, 'Your book is unchanged. A review record in Chapter 2 is damaged, so no archive was made. Please report this message to us.'],
    ['zh-CN', { chapterNumber: null, chapterTitle: '', inTrash: false }, '作品没有改动。有一项数据无法安全打包，存档没有生成。请把这条提示反馈给我们。'],
  ] as const)('%s：只写章号、章名和是否在回收站，不写稿的版本和删除时间（#702）', (locale, damaged, expected) => {
    expect(damagedReviewCycleMessage(shown(locale), damaged)).toBe(expected)
  })
})

describe('archiveFailureMessage', () => {
  it.each([
    ['PORTABLE_PATH_UNSAFE', 'Your book is unchanged. The name or location of a file (a prompt, skill, avatar or finalized manuscript) cannot go into an archive, so no archive was created. Please report this message to us.'],
    ['PORTABLE_KNOWLEDGE_INVALID', 'Your book is unchanged. A document record in the knowledge base is incomplete or damaged, so no archive was created. Please report this message to us.'],
  ])('英文界面导出报 %s：说出是哪类内容，不露原码（#723）', (code, expected) => {
    expect(archiveFailureMessage(shown('en-US'), 'export', code)).toBe(expected)
  })

  it.each([
    ['export', 'PORTABLE_TARGET_INSIDE_SOURCE', '作品没有改动。存档不能放进作品自己的文件夹，没有生成。请再点「导出本地存档」，换到作品文件夹以外的位置。'],
    ['export', 'PORTABLE_ASSET_MISSING', '作品没有改动。作品文件夹里的数据文件找不到了，存档没有生成。请重新打开这部作品，再点「导出本地存档」。'],
    ['export', 'PORTABLE_ARCHIVE_PUBLISH_UNSUPPORTED', '作品没有改动。所选位置（常见于 U 盘、网络盘）存不了存档。请再点「导出本地存档」存到本机文件夹，再复制过去。'],
    ['export', 'PORTABLE_ARCHIVE_TARGET_UNWRITABLE', '作品没有改动。所选位置写不进去，可能没有权限或磁盘满了。请再点「导出本地存档」，换一个位置。'],
    ['export', 'PORTABLE_EXPORT_FAILED', '作品没有改动。导出时出了意外错误，存档没有生成。请再点「导出本地存档」；还不行，请把这条提示反馈给我们。'],
    ['restore', 'PORTABLE_RESTORE_INVALID', '没有新建副本。所选文件不是完整的书童存档，可能坏了或没下载完。请换一个存档，再点「从本地存档恢复副本」。'],
    ['restore', 'PORTABLE_ARCHIVE_TARGET_UNWRITABLE', '所选文件夹写不进去，可能没有权限或磁盘满了，里面可能留下没恢复完的副本文件夹，可以删掉。请换一个文件夹，再点「从本地存档恢复副本」。'],
    ['restore', 'PORTABLE_RESTORE_UNSAFE_TARGET', '所选文件夹没法安全写入，里面可能留下没恢复完的副本文件夹，可以删掉。请换一个文件夹，再点「从本地存档恢复副本」。'],
    ['restore', 'PORTABLE_GRANT_INVALID', '没有新建副本。选好的存档或文件夹已失效。请再点「从本地存档恢复副本」重新选。'],
    ['restore', 'PORTABLE_RESTORE_ARCHIVE_MISSING', '没有新建副本。找不到所选存档。请再点「从本地存档恢复副本」重新选一次。'],
    ['restore', 'PORTABLE_RESTORE_ARCHIVE_UNREADABLE', '没有新建副本。所选存档读不了，可能没有权限或正被占用。请换一个存档，再点「从本地存档恢复副本」。'],
    ['export', 'PORTABLE_EXPORT_SOURCE_UNREADABLE', '作品没有改动。作品文件读不了，可能正被同步盘或杀毒软件占用。请稍后再点「导出本地存档」。'],
    ['restore', 'PORTABLE_RESTORE_FAILED', '恢复时出了意外错误，所选文件夹里可能留下没恢复完的副本文件夹，可以删掉。请再点「从本地存档恢复副本」；还不行，请把这条提示反馈给我们。'],
  ] as const)('中文界面%s报 %s：说清原因和下一步，不露原码（#702）', (operation, code, expected) => {
    expect(archiveFailureMessage(shown('zh-CN'), operation, code)).toBe(expected)
  })

  it.each([
    ['export', 'PORTABLE_TARGET_INSIDE_SOURCE', "Your book is unchanged. An archive cannot go inside the book's own folder, so none was created. Click Export local archive again and choose a location outside the book folder."],
    ['restore', 'PORTABLE_ARCHIVE_TARGET_UNWRITABLE', 'The chosen folder cannot be written to; you may lack permission or the disk may be full. An unfinished copy folder may be left in it; you can delete it. Choose another folder, then click Restore a copy from local archive again.'],
    ['restore', 'PORTABLE_RESTORE_UNSAFE_TARGET', 'The chosen folder cannot be written to safely. An unfinished copy folder may be left in it; you can delete it. Choose another folder, then click Restore a copy from local archive again.'],
    ['restore', 'PORTABLE_GRANT_INVALID', 'No copy was created. The archive or folder you chose is no longer valid. Click Restore a copy from local archive and choose again.'],
    ['restore', 'PORTABLE_RESTORE_ARCHIVE_MISSING', 'No copy was created. The chosen archive could not be found. Click Restore a copy from local archive and choose it again.'],
    ['restore', 'PORTABLE_RESTORE_ARCHIVE_UNREADABLE', 'No copy was created. The chosen archive cannot be read; you may lack permission or another program may be using it. Choose another archive, then click Restore a copy from local archive again.'],
    ['export', 'PORTABLE_EXPORT_SOURCE_UNREADABLE', 'Your book is unchanged. Some book files cannot be read; a sync or antivirus app may be using them. Wait a moment, then click Export local archive again.'],
    ['restore', 'PORTABLE_RESTORE_FAILED', 'Something unexpected went wrong during restore. An unfinished copy folder may be left in the chosen folder; you can delete it. Click Restore a copy from local archive again. If it still fails, please report this message to us.'],
  ] as const)('英文界面%s报 %s：说清原因和下一步，不露原码（#702）', (operation, code, expected) => {
    expect(archiveFailureMessage(shown('en-US'), operation, code)).toBe(expected)
  })

  it.each([
    ['PORTABLE_GRANT_INVALID', 'コピーは作成されていません。選んだアーカイブまたはフォルダーは無効になりました。もう一度「ローカルアーカイブからコピーを復元」をクリックして選び直してください。'],
    ['PORTABLE_RESTORE_ARCHIVE_MISSING', 'コピーは作成されていません。選んだアーカイブが見つかりません。もう一度「ローカルアーカイブからコピーを復元」をクリックして選び直してください。'],
    ['PORTABLE_RESTORE_ARCHIVE_UNREADABLE', 'コピーは作成されていません。選んだアーカイブを読み込めません。権限がないか、ほかのプログラムが使用中の可能性があります。別のアーカイブを選んでから、もう一度「ローカルアーカイブからコピーを復元」をクリックしてください。'],
    ['PORTABLE_ARCHIVE_TARGET_UNWRITABLE', '選んだフォルダーに書き込めません。権限がないか、ディスクがいっぱいの可能性があります。途中までのコピーのフォルダーが残っていれば削除してかまいません。別のフォルダーを選んでから、もう一度「ローカルアーカイブからコピーを復元」をクリックしてください。'],
    ['PORTABLE_RESTORE_UNSAFE_TARGET', '選んだフォルダーには安全に書き込めません。途中までのコピーのフォルダーが残っていれば削除してかまいません。別のフォルダーを選んでから、もう一度「ローカルアーカイブからコピーを復元」をクリックしてください。'],
    ['PORTABLE_RESTORE_FAILED', '復元中に予期しない問題が発生しました。選んだフォルダーに途中までのコピーのフォルダーが残っていれば削除してかまいません。もう一度「ローカルアーカイブからコピーを復元」をクリックしてください。それでも失敗する場合は、このメッセージをご報告ください。'],
  ] as const)('日文界面恢复报 %s：说清原因和下一步，不露原码（#702）', (code, expected) => {
    expect(archiveFailureMessage(shown('ja-JP'), 'restore', code)).toBe(expected)
  })

  it('日文界面导出时作品文件读不了：说是作品文件被占用，不叫作者换位置（#702）', () => {
    expect(archiveFailureMessage(shown('ja-JP'), 'export', 'PORTABLE_EXPORT_SOURCE_UNREADABLE')).toBe('作品は変更されていません。作品のファイルを読み込めません。同期アプリやウイルス対策ソフトが使用中の可能性があります。少し待ってから、もう一度「ローカルアーカイブをエクスポート」をクリックしてください。')
  })
})

describe('恢复报错只在确定还没建副本文件夹时才说没有新建副本（#702）', () => {
  const locales = ['zh-CN', 'en-US', 'ja-JP'] as const
  const noCopy = { 'zh-CN': '没有新建副本', 'en-US': 'No copy was created', 'ja-JP': 'コピーは作成されていません' }
  const unfinished = { 'zh-CN': '没恢复完的副本文件夹', 'en-US': 'unfinished copy folder', 'ja-JP': '途中までのコピーのフォルダー' }
  const beforeInstall = [
    'PORTABLE_ARCHIVE_SOURCE_CHANGED', 'PORTABLE_ARCHIVE_SOURCE_UNSAFE', 'PORTABLE_ARCHIVE_INVALID', 'PORTABLE_RESTORE_INVALID',
    'PORTABLE_SCHEMA_UNSUPPORTED', 'PORTABLE_GRANT_INVALID', 'PORTABLE_RESTORE_ARCHIVE_MISSING', 'PORTABLE_RESTORE_ARCHIVE_UNREADABLE',
  ]
  const mayFollowInstall = ['PORTABLE_ARCHIVE_TARGET_UNWRITABLE', 'PORTABLE_RESTORE_UNSAFE_TARGET', 'PORTABLE_RESTORE_FAILED']

  it.each(locales.flatMap(locale => beforeInstall.map(code => [locale, code] as const)))(
    '%s 界面 %s 只会在建副本文件夹前出现：仍说没有新建副本', (locale, code) => {
      expect(archiveFailureMessage(shown(locale), 'restore', code).startsWith(noCopy[locale])).toBe(true)
    })

  it.each(locales.flatMap(locale => mayFollowInstall.map(code => [locale, code] as const)))(
    '%s 界面 %s 可能在副本装到一半时出现：不说没有新建副本，提醒所选文件夹里可能有没恢复完的副本', (locale, code) => {
      const message = archiveFailureMessage(shown(locale), 'restore', code)
      expect(message).not.toContain(noCopy[locale])
      expect(message).toContain(unfinished[locale])
    })

  it.each(locales)('%s 界面云端恢复失败（装到一半也报这个码）：不说没有新建副本', locale => {
    const message = displayedErrorMessage(shown(locale), 'CLOUD_BACKUP_RESTORE_FAILED')
    expect(message).not.toContain(noCopy[locale])
    expect(message).toContain(unfinished[locale])
  })

  it.each(locales)('%s 界面云端世代来自新版本（解包时就拒绝）：说没有新建副本', locale => {
    expect(displayedErrorMessage(shown(locale), 'CLOUD_BACKUP_RESTORE_ARCHIVE_NEWER').startsWith(noCopy[locale])).toBe(true)
  })

  it.each(locales)('%s 界面云端恢复时所选文件夹写不进（装到一半也会报）：不说没有新建副本', locale => {
    const message = displayedErrorMessage(shown(locale), 'CLOUD_BACKUP_RESTORE_TARGET_UNWRITABLE')
    expect(message).not.toContain(noCopy[locale])
    expect(message).toContain(unfinished[locale])
  })
})

describe('云备份已有的说明不变（#702）', () => {
  it.each([
    ['zh-CN', '作品没有改动。连不上「网络代理」里设置的代理。请检查「主机地址」和「端口」，打开代理软件，或关掉「启用代理」，再试一次。'],
    ['en-US', 'Your book is unchanged. Could not reach the proxy set in Network proxy. Check the Host and Port, start your proxy app, or turn off Use a proxy, then try again.'],
    ['ja-JP', '作品は変更されていません。「Network proxy」で設定したプロキシに接続できません。「Host」と「Port」を確認するか、プロキシアプリを起動するか、「Use a proxy」をオフにしてから、もう一度お試しください。'],
  ] as const)('%s 界面代理连不上', (locale, expected) => {
    expect(displayedErrorMessage(shown(locale), 'CLOUD_BACKUP_PROXY_UNREACHABLE')).toBe(expected)
  })
})

describe('omittedReviewCyclesMessage', () => {
  it.each([
    ['zh-CN', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }], '第 2 章「沉船」有条审稿记录损坏，没放进存档。正文和其他审稿内容都在。'],
    ['zh-CN', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: true }], '回收站里第 2 章「沉船」有条审稿记录损坏，没放进存档。正文和其他审稿内容都在。'],
    ['en-US', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }], 'A damaged review record in Chapter 2 "沉船" was left out of the archive. The text and other reviews are included.'],
    ['ja-JP', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }], '第2章「沉船」のレビュー記録が破損していたため、アーカイブに含めませんでした。本文とその他のレビュー内容は含まれています。'],
    ['zh-CN', [{ chapterNumber: 5, chapterTitle: '', inTrash: false }, { chapterNumber: 2, chapterTitle: '沉船', inTrash: true }, { chapterNumber: 5, chapterTitle: '', inTrash: false }],
      '第 5 章、回收站里第 2 章「沉船」有审稿记录损坏，没放进存档。正文和其他审稿内容都在。'],
    ['en-US', [{ chapterNumber: 2, chapterTitle: '', inTrash: false }, { chapterNumber: 5, chapterTitle: '', inTrash: false }],
      'Damaged review records in Chapter 2, Chapter 5 were left out of the archive. The text and other reviews are included.'],
    ['en-US', [{ chapterNumber: 2, chapterTitle: '', inTrash: false }, { chapterNumber: 2, chapterTitle: '', inTrash: true }],
      'Damaged review records in Chapter 2, Chapter 2 in the trash were left out of the archive. The text and other reviews are included.'],
    ['ja-JP', [{ chapterNumber: 2, chapterTitle: '', inTrash: false }, { chapterNumber: 2, chapterTitle: '', inTrash: true }],
      '第2章、ゴミ箱の第2章のレビュー記録が破損していたため、アーカイブに含めませんでした。本文とその他のレビュー内容は含まれています。'],
    ['zh-CN', [{ chapterNumber: 2, chapterTitle: '港口', inTrash: false }, { chapterNumber: 2, chapterTitle: '沉船', inTrash: true }, { chapterNumber: 2, chapterTitle: '港口', inTrash: false }],
      '第 2 章「港口」、回收站里第 2 章「沉船」有审稿记录损坏，没放进存档。正文和其他审稿内容都在。'],
    ['zh-CN', [{ chapterNumber: null, chapterTitle: '', inTrash: false }], '有条审稿记录损坏，没放进存档。正文和其他审稿内容都在。'],
    ['zh-CN', [{ chapterNumber: null, chapterTitle: '', inTrash: false }, { chapterNumber: null, chapterTitle: '', inTrash: false }],
      '有几条审稿记录损坏，没放进存档。正文和其他审稿内容都在。'],
    ['zh-CN', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }, { chapterNumber: null, chapterTitle: '', inTrash: false }],
      '第 2 章「沉船」等处有审稿记录损坏，没放进存档。正文和其他审稿内容都在。'],
    ['en-US', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }, { chapterNumber: null, chapterTitle: '', inTrash: false }],
      'Damaged review records in Chapter 2 "沉船" and elsewhere were left out of the archive. The text and other reviews are included.'],
    ['ja-JP', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }, { chapterNumber: null, chapterTitle: '', inTrash: false }],
      '第2章「沉船」などのレビュー記録が破損していたため、アーカイブに含めませんでした。本文とその他のレビュー内容は含まれています。'],
  ] as const)('%s：%j', (locale, omitted, expected) => {
    expect(omittedReviewCyclesMessage(shown(locale), omitted)).toBe(expected)
  })
})

describe('打开作品时文件暂时读不了（#702）', () => {
  it('三种界面语言都指向作者要再点的那个按钮，书名填进去', () => {
    expect(projectOpenFailureMessage(shown('en-US'), { errorCode: 'PROJECT_OPEN_FILES_BUSY' }, 'Lighthouse'))
      .toBe('Your saved content is not affected. The book’s files are in use right now, so it could not be opened. Wait a few seconds, then click Open “Lighthouse” again.')
    expect(projectOpenFailureMessage(shown('ja-JP'), { errorCode: 'PROJECT_OPEN_IO_FAILED' }, '灯塔'))
      .toBe('作品のファイルを今回は読み込めませんでした。数秒待ってから、もう一度「Open “灯塔”」をクリックしてください。')
  })

  it('其他打开失败照旧说明，不接「再点打开」', () => {
    expect(projectOpenFailureMessage(shown('zh-CN'), { errorCode: 'PROJECT_NOT_OPEN' }, '灯塔')).toBe('请先打开项目。')
  })
})
