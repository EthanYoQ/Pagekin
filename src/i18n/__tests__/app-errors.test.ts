import { describe, expect, it } from 'vitest'
import { appErrorMessage, damagedReviewCycleMessage, omittedReviewCyclesMessage, displayedErrorMessage, englishWithReason, errorCodeOf, importGenerationStopMessage, knownAppErrorMessage, legacyImportFailureMessage } from '../app-errors'
import { shown } from './shown-locale'

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
  ])('turns %s into a full sentence without the IPC wrapper', (raw, hint) => {
    for (const error of [raw, new Error(raw)]) {
      const zh = knownAppErrorMessage(shown('zh-CN'), error)
      expect(zh).toContain(hint)
      expect(zh).not.toMatch(/Error invoking|GENERATION_|FINALIZED_/u)
      expect(knownAppErrorMessage(shown('en-US'), error)).toMatch(/^[A-Z][^_]+\.$/u)
    }
  })

  it('leaves unregistered codes and prose to the caller', () => {
    expect(knownAppErrorMessage(shown('zh-CN'), "Error invoking remote method 'generation:begin': Error: GENERATION_SOMETHING_NEW")).toBeUndefined()
    expect(knownAppErrorMessage(shown('zh-CN'), '模型服务返回 HTTP 429')).toBeUndefined()
  })
})

it('does not promise that a stale-session action never ran', () => {
  // 主进程可能已经处理完，只是结果因会话失效被拒；文案只能说结果不可用。
  const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_PROJECT_SESSION_STALE"
  const zh = knownAppErrorMessage(shown('zh-CN'), raw)!, en = knownAppErrorMessage(shown('en-US'), raw)!
  expect(zh).toContain('结果不可用')
  expect(zh).not.toMatch(/没有执行|未执行/u)
  expect(en).toContain('result')
  expect(en).not.toMatch(/did not run|was not run/iu)
})

// GENERATION_MODEL_CHANGED 由主进程续跑情节大纲时抛出，GENERATION_IMPORT_MODEL_CHANGED 由导入生成抛出；GENERATION_SOURCE_CHANGED_MODEL 由 #453 抛出。
it.each(['GENERATION_MODEL_CHANGED', 'GENERATION_IMPORT_MODEL_CHANGED', 'GENERATION_SOURCE_CHANGED_MODEL'])('explains %s mid-generation instead of falling back to the raw code', code => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage(shown('zh-CN'), wrapped)).toContain('模型设置被修改')
  expect(knownAppErrorMessage(shown('en-US'), wrapped)).toContain('model settings changed')
})

// GENERATION_SKILL_BUNDLE_DAMAGED 由 #443 抛出，GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE 由 #447 抛出；无论哪个 PR 先合入都已登记。
it.each([
  ['GENERATION_SKILL_BUNDLE_DAMAGED', '重新导入', 'import'],
  ['GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE', '生成记录已变化', 'generation record changed'],
])('explains %s instead of falling back to the raw code', (code, zh, en) => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage(shown('zh-CN'), wrapped)).toContain(zh)
  expect(knownAppErrorMessage(shown('en-US'), wrapped)).toContain(en)
})

// 这两个码在保存时的来源复核里也会抛出，那时模型已经回答过。
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

// 审计点名的四个码与已登记的 GENERATION_SOURCE_CHANGED 走同一条转发路径、同一种作者情境（生成途中依据变了）。
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

// 名单版本冲突与角色不存在既来自批准角色提议，也来自普通的角色卡保存：说明不能只指向提议（#474 审计）。
it.each(['CHARACTER_ID_REVISION_CONFLICT', 'CHARACTER_ID_UNKNOWN'])('explains %s without assuming a proposal is open', code => {
  expect(knownAppErrorMessage(shown('en-US'), code)).not.toMatch(/proposal/iu)
  expect(knownAppErrorMessage(shown('zh-CN'), code)).not.toContain('提议')
})

describe('project session and external file errors from the main process (#474 B4)', () => {
  it.each([
    // db 读通道原样抛出：Electron 包上通道名，错误类名代替了 "Error"。
    ["Error invoking remote method 'db:draft-list': ProjectSessionStaleError: PROJECT_SESSION_DATABASE_MISMATCH", 'The project was switched or reopened'],
    // db 写通道返回 { error: String(error) }。
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
    expect(displayedErrorMessage(shown('en-US'), new Error('PORTABLE_GRANT_INVALID'))).toBe('PORTABLE_GRANT_INVALID')
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
    // IPC 之外 reject 的普通对象：有字符串 message 就用它，没有就用兜底，不显示 [object Object]。
    expect(displayedErrorMessage(shown(locale), { message: '磁盘只读' }, '兜底')).toBe('磁盘只读')
    expect(displayedErrorMessage(shown(locale), { success: false }, '兜底')).toBe('兜底')
  })

  // project:create / project:open 的 catch 把 resolveDirectoryPath 抛出的码经 String(error) 原样放进 result.error。
  it.each(['zh-CN', 'en-US'] as const)('%s：选好的文件夹在使用前被移动或替换时，不把 EXTERNAL_FILE_GRANT_TARGET_CHANGED 交给作者', locale => {
    const message = displayedErrorMessage(shown(locale), 'Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED')
    expect(message).not.toMatch(/EXTERNAL_FILE_GRANT|Error:/u)
    expect(appErrorMessage(shown(locale), 'Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED')).toBe(message)
  })
})

describe('cast, blueprint and draft errors from the main process (#474 B2)', () => {
  it.each([
    // 可写 db 通道返回 { error: String(error) }。
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
    // kb 通道的结果值：{ success: false, error: 码 }。
    ['KNOWLEDGE_BASE_COPY_CHANGED', 'Reopen the material', '请重新打开这份资料'],
    ['EMBEDDING_RESPONSE_INVALID', 'returned an unusable result', '返回的结果不对'],
    // 检索与读取原样抛出：Electron 包上通道名与 "Error: "。
    ["Error invoking remote method 'kb:search': Error: EMBEDDING_SPACE_REGISTRY_INVALID", 'search index records of this book are damaged', '检索索引记录已损坏'],
    // vector-store 的 catch 曾用 String(error) 交出 "Error: 码"。
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
    // llm-controller 的 catch 用 String(error) 交出 "Error: 码"。
    ['Error: LLM_GLOBAL_CONFIG_CORRUPT', 'model settings file is damaged', '模型设置文件已损坏'],
    ['Error: LLM_DEFAULT_MODEL_ROLLBACK_FAILED', 'model was not deleted', '模型没有删除'],
    ['Error: LLM_STAGE_MODEL_UNAVAILABLE', 'no longer available for writing', '不能用于文本生成'],
    ['Error: LLM_STAGE_MODEL_REQUEST_INVALID', 'stage setting was not saved', '分工设置没有保存'],
    // 执行租约的码由 ModelExecutionLeaseError 抛出，带自己的类名。
    ['ModelExecutionLeaseError: MODEL_ENDPOINT_INVALID', 'Base URL is invalid', 'Base URL 无效'],
    ['GENERATION_KIMI_TEMPERATURE_INVALID', 'temperature from 0 to 1', '温度必须在 0 到 1 之间'],
    // mcp 通道的结果值与工具调用的 String(error)。
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
    const requestLimit = importGenerationStopMessage(shown(locale), 'ROOT_BUDGET_EXHAUSTED')
    const activeTime = importGenerationStopMessage(shown(locale), 'ROOT_BUDGET_EXHAUSTED', true)
    const blockedMessages = blocked.map(code => importGenerationStopMessage(shown(locale), code))
    const previousAttempt = importGenerationStopMessage(shown(locale), 'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
    const storage = importGenerationStopMessage(shown(locale), 'GENERATION_STORAGE_FAILED', true)
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
    expect(importGenerationStopMessage(shown('zh-CN'), 'ROOT_BUDGET_EXHAUSTED')).toMatch(/^这次导入的请求次数或运行时长已到上限/u)
    expect(importGenerationStopMessage(shown('en-US'), 'ROOT_BUDGET_EXHAUSTED')).toMatch(/^This import reached its limit on model requests or running time/u)
  })

  it.each(['zh-CN', 'en-US'] as const)('tells an author-manuscript inference stop in %s what is saved and what the author can still do, without Start over', locale => {
    const stops: [string, boolean][] = [['ROOT_BUDGET_EXHAUSTED', false], ['ROOT_BUDGET_EXHAUSTED', true], ['GENERATION_DISPATCH_BLOCKED', false],
      ['GENERATION_STORAGE_FAILED', true], ['GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE', false]]
    const saved = { 'zh-CN': /原稿正文已经导入并保存，只是 AI 反推的设定、文风或蓝图没有做完/u, 'en-US': /manuscript text is imported and saved/u }[locale]
    const startOver = { 'zh-CN': /重新开始/u, 'en-US': /Start over/u }[locale]
    for (const [code, inFlight] of stops) {
      const author = importGenerationStopMessage(shown(locale), code, inFlight, 'author-manuscript')
      const reference = importGenerationStopMessage(shown(locale), code, inFlight)
      expect(author).toMatch(saved)
      expect(author).not.toMatch(startOver)
      expect(author).not.toMatch(/[A-Z]{3,}_[A-Z]/u)
      expect(reference).toMatch(nextStep[locale])
      expect(importGenerationStopMessage(shown(locale), code, inFlight, 'reference')).toBe(reference)
    }
  })

  it.each(['GENERATION_PROVIDER_FAILED', 'IMPORT_RUN_EXECUTION_STALE', 'DEADLINE_EXHAUSTED'])('leaves %s to the shared explanation', code => {
    expect(importGenerationStopMessage(shown('zh-CN'), code)).toBeUndefined()
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
    expect(importGenerationStopMessage(shown('ja-JP'), 'GENERATION_STORAGE_FAILED', false, 'author-manuscript'))
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
  ] as const)('%s：只写章号、章名和是否在回收站，不写稿的版本和删除时间（#702）', (locale, damaged, expected) => {
    expect(damagedReviewCycleMessage(shown(locale), damaged)).toBe(expected)
  })
})

describe('omittedReviewCyclesMessage', () => {
  it.each([
    ['zh-CN', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }], '第 2 章「沉船」有条审稿记录损坏，没放进存档。正文和审稿内容都在。'],
    ['zh-CN', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: true }], '回收站里第 2 章「沉船」有条审稿记录损坏，没放进存档。正文和审稿内容都在。'],
    ['en-US', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }], 'A damaged review record in Chapter 2 "沉船" was left out of the archive. The text and reviews are included.'],
    ['ja-JP', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }], '第2章「沉船」のレビュー記録が破損していたため、アーカイブに含めませんでした。本文とレビュー内容は含まれています。'],
    ['zh-CN', [{ chapterNumber: 5, chapterTitle: '', inTrash: false }, { chapterNumber: 2, chapterTitle: '沉船', inTrash: true }, { chapterNumber: 5, chapterTitle: '', inTrash: false }],
      '第 2、5 章共有 3 条审稿记录损坏，没放进存档。正文和审稿内容都在。'],
    ['en-US', [{ chapterNumber: 2, chapterTitle: '', inTrash: false }, { chapterNumber: 5, chapterTitle: '', inTrash: false }],
      '2 damaged review records in Chapters 2, 5 were left out of the archive. The text and reviews are included.'],
    ['en-US', [{ chapterNumber: 2, chapterTitle: '', inTrash: false }, { chapterNumber: 2, chapterTitle: '', inTrash: true }],
      '2 damaged review records in Chapter 2 were left out of the archive. The text and reviews are included.'],
    ['zh-CN', [{ chapterNumber: null, chapterTitle: '', inTrash: false }], '有条审稿记录损坏，没放进存档。正文和审稿内容都在。'],
    ['zh-CN', [{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }, { chapterNumber: null, chapterTitle: '', inTrash: false }],
      '有 2 条审稿记录损坏，没放进存档。正文和审稿内容都在。'],
  ] as const)('%s：%j', (locale, omitted, expected) => {
    expect(omittedReviewCyclesMessage(shown(locale), omitted)).toBe(expected)
  })
})
