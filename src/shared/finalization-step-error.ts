/**
 * 失败后再点「重试」有没有用，决定界面摆不摆重试、说明末尾补不补「请点『重试』」：
 * prompt 有用，说明末尾补提示；described 可能有用，说明里已写明前提，不再补；never 结果也一样，不摆重试；
 * after 要等那一步成功后才有用，整卡重试会把它排在那一步之后一起重跑。
 */
type StepRetry = 'prompt' | 'described' | 'never' | { after: string; rerunIfSucceeded?: true }

/** 从回收站恢复的章：知识库文档在删除时已清掉，kb_import 记这个码等重导（ADR-0025）。 */
export const CHAPTER_RESTORED_REPROJECTION_PENDING = 'CHAPTER_RESTORED_REPROJECTION_PENDING'

/** 后处理在这一步做完之前就停了（取消、前面的步骤失败或应用退出）。 */
export const POST_PROCESS_INTERRUPTED = 'POST_PROCESS_INTERRUPTED'

/** 定稿后处理步骤的错误码。步骤记录里存错误码本身，界面展示时再按当前界面语言换成作者可读说明。 */
/** enMany：{names} 有多个文件时的英文。 */
const FINALIZATION_STEP_ERRORS: { code: RegExp; zh: string; en: string; enMany?: string; retry: StepRetry }[] = [
  { code: /^FINALIZATION_GENERATION_INCOMPLETE$/, retry: 'prompt',
    zh: '模型这次没有返回完整结果（连接中断或输出被截断）。', en: 'The model did not return a complete result (the connection dropped or the output was cut off).' },
  { code: /^FINALIZATION_GENERATION_(ARTIFACT_REQUIRED|OUTCOME_UNKNOWN)$/, retry: 'prompt',
    zh: '正文定稿已保存，这一步没有拿到模型的结果（例如连接中断）。', en: 'The finalized chapter text is saved, but this step got no result from the model (for example, the connection dropped).' },
  { code: /^FINALIZATION_GENERATION_RESULT_UNUSABLE$/, retry: 'prompt',
    zh: '模型返回了内容，但结果不可用（例如为空）。', en: 'The model returned a response, but the result was unusable (for example, empty).' },
  { code: /^GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE$/, retry: 'prompt',
    zh: '这一步的生成记录已变化，本次没有重新生成。', en: "This step's generation record changed, so it was not generated again." },
  { code: /^GENERATION_DISPATCH_BLOCKED$/, retry: 'prompt',
    zh: '这一步还有模型请求未结束，本次没有重新生成。', en: 'A model request for this step is still unfinished, so it was not generated again.' },
  { code: /^GENERATION_CONTEXT_LENGTH_EXCEEDED$/, retry: 'never',
    zh: '提示词超出了模型能接受的长度，再点「重试」结果也一样。请换用上下文更长的模型或调低最大输出 Tokens，再重新定稿本章。',
    en: 'The prompt is longer than the model accepts, and retrying gives the same result. Switch to a model with a longer context or lower Max output tokens, then finalize this chapter again.' },
  { code: /^(ROOT_BUDGET_EXHAUSTED|USAGE_EXCEEDED_RESERVATION)$/, retry: 'never',
    zh: '这次后处理的模型调用额度已用完（请求超时或用量超出预留），再点「重试」也不会重新生成。',
    en: 'The model-call budget for this post-processing run is used up (a request timed out or exceeded its reserved usage). Retrying will not generate this step again.' },
  { code: /^(FINALIZATION_GENERATION_SOURCE_CHANGED|GENERATION_FINALIZATION_SOURCE_CHANGED|GENERATION_SOURCE_CHANGED|GENERATION_SOURCE_CHANGED_MODEL|GENERATION_MODEL_CHANGED)$/, retry: 'never',
    zh: '定稿正文或模型设置已变化，这一步不能沿用原记录。请重新定稿本章后再处理。', en: 'The finalized manuscript or model settings changed, so this step cannot reuse its record. Finalize this chapter again, then retry.' },
  // 写生成记录失败时主进程把整个 root 阻断，重试同样被拦下。
  { code: /^GENERATION_STORAGE_FAILED$/, retry: 'never',
    zh: '后处理的生成记录没能保存，已停止，再点「重试」也不会重新生成。请检查磁盘空间后重新定稿本章。',
    en: 'The post-processing record could not be saved, so it stopped. Retrying will not generate this step again. Check disk space, then finalize this chapter again.' },
  // 生成记录缺了没写进去的尾部、已被丢弃或校验不符，不能拿来提交或修正。
  { code: /^GENERATION_FINALIZATION_ARTIFACT_INVALID$/, retry: 'never',
    zh: '这一步的生成记录不完整或已失效，不能沿用。请重新定稿本章后再处理。', en: "This step's generation record is incomplete or no longer valid, so it cannot be reused. Finalize this chapter again, then retry." },
  // 角色状态字段已由更晚章节写过或来源对不上（#491），提交拒写；正文定稿不受影响。
  { code: /^FINALIZED_CHARACTER_SOURCE_CONFLICT$/, retry: 'described',
    zh: '正文定稿已保存，但角色卡没有自动更新：有字段已被后面章节的定稿改过，或来源对不上。项目从备份恢复、且失败发生在升级前的，可以点「重试」；重试仍失败或不属于这种情况，到角色页「当前状态」手动改。',
    en: "The finalized chapter text is saved, but the character card was not updated: a later finalized chapter already changed some fields, or their source does not match. If the project was restored from a backup and this failed before you updated the app, you can retry. If Retry still fails, or this is not your case, edit them in the character's Current state view." },
  // 模型连续几次的回答都不合角色状态的格式要求（#552）。重试另开一次运行，按现在「定稿后处理」的分工模型重新生成。
  // 章节要点与角色状态提交都会抛这个码，说明不能只讲角色卡。
  { code: /^FINALIZED_CHARACTER_IDENTITY_REQUIRED$/, retry: 'described',
    zh: '正文定稿已保存，但这一步没有完成：模型返回的角色和本章角色名单对不上。点「重试」；反复失败就在「分工模型」给「定稿后处理」换个模型。',
    en: "The finalized chapter text is saved, but this step did not finish: a character in the model's reply did not match this chapter's cast. Select Retry. If it keeps failing, choose another model for After finalizing in Models by stage." },
  { code: /^FINALIZED_CHARACTER_(UPDATES_INVALID|UPDATE_INVALID|EVIDENCE_MISSING|EVIDENCE_NOT_UNIQUE|EVIDENCE_INVALID|FIELD_INVALID|DUPLICATE_ID)$/, retry: 'described',
    zh: '正文定稿已保存，但角色卡没有自动更新：模型几次返回的角色状态格式都不对。点「重试」；反复失败就在「分工模型」给「定稿后处理」换个模型。',
    en: "The finalized chapter text is saved, but the character cards were not updated: the model's character-state replies were in the wrong format several times. Select Retry. If it keeps failing, choose another model for After finalizing in Models by stage." },
  // 生成期间字段被作者或其他提交改过（#484）。重试沿用生成开始时冻结的角色状态，仍会拒写。
  { code: /^FINALIZED_CHARACTER_FIELD_CONFLICT$/, retry: 'never',
    zh: '正文定稿已保存，但角色卡没有自动更新：生成期间这个角色的状态被改过，改动已保留，再点「重试」结果也一样。需要本章的变化，到角色页「当前状态」手动改。',
    en: "The finalized chapter text is saved, but the character card was not updated: this character's current state changed while this step was running, and that change is kept. Retrying gives the same result. To apply this chapter's changes, edit the character's Current state view by hand." },
  // 生成开始后正文依据的连续性记录变了（#512）：运行冻结的上下文不会变，重试先按来源已变拒绝。
  // CONTEXT_CHANGED 比对的字段提交前的来源校验已整组比过，按同一情形说明。
  { code: /^(GENERATION_FINALIZATION_IDENTITY_CHANGED|FINALIZED_CHARACTER_CONTEXT_CHANGED)$/, retry: 'never',
    zh: '正文定稿已保存，但这一步没有写入：生成期间有其他章节重新定稿或被删除，再点「重试」结果也一样。请重新定稿本章。',
    en: 'The finalized chapter text is saved, but this step was not saved: another chapter was finalized again or deleted while it was running. Retrying gives the same result. Finalize this chapter again.' },
  // 定稿时在场的角色后来被删除（#512），重试同样先按来源已变拒绝。
  { code: /^FINALIZED_CHARACTER_ID_RETIRED$/, retry: 'never',
    zh: '正文定稿已保存，但这一步没有写入：本章的角色有的后来被删除了，再点「重试」结果也一样。请重新定稿本章。',
    en: "The finalized chapter text is saved, but this step was not saved: a character in this chapter's cast has since been deleted. Retrying gives the same result. Finalize this chapter again." },
  { code: /^GENERATION_FINALIZATION_NOTES_CHANGED$/, retry: 'described',
    zh: '生成期间本章的「章节要点」有改动，改动已保留。点「重试失败步骤」会重新生成要点并更新角色状态；你改的要点可能被新结果换掉，想留就先复制一份。',
    en: "Chapter notes changed while this step was running. The change is kept. Select Retry failed steps to generate the notes again and update the character state. Your edited notes may be replaced by the new ones, so copy them first to keep them." },
  // 作品放在不支持硬链接的磁盘上，知识库每次提交都失败（#571）；搬到支持的磁盘后重试才有用。
  { code: /^KNOWLEDGE_BASE_VOLUME_UNSUPPORTED$/, retry: 'described',
    zh: '正文定稿已保存，但没能收进知识库：作品所在位置不支持知识库要用的硬链接（常见于 exFAT、FAT32 磁盘）。请退出书童，把作品文件夹移到本地 NTFS 磁盘（Mac 用 APFS），从新位置打开后再点「重试」。',
    en: "The finalized chapter text is saved, but it could not be added to the knowledge base: this location does not support the hard links the knowledge base needs (common on exFAT and FAT32 drives). Quit Pagekin, move the book folder to a local NTFS drive (APFS on a Mac), open it from there, then select Retry." },
  { code: /^GENERATION_FINALIZATION_PREDECESSOR_REQUIRED$/, retry: { after: 'chapter_notes', rerunIfSucceeded: true },
    zh: '需要先完成「章节剧情要点」。', en: 'Chapter plot notes must finish first.' },
  { code: /^FINALIZATION_REPLACED_KNOWLEDGE_IMPORT_REQUIRED$/, retry: { after: 'kb_import' },
    zh: '需要先完成「导入知识库」。新定稿收进知识库之前，旧版本的那一份先留着。',
    en: 'Import into knowledge base must finish first. The replaced version stays in the knowledge base until the new final version is added.' },
  { code: /^FINALIZATION_REPLACED_KNOWLEDGE_EDITED$/, retry: 'never',
    zh: '知识库里旧版本那份和旧定稿对不上（可能改过），所以留着没删，写作时仍可能查到。再点「重试」结果也一样。',
    en: "The replaced version's knowledge-base copy differs from its text (it may have been edited), so it was kept. Writing may still find it. Retrying gives the same result." },
  { code: /^FINALIZATION_REPLACED_KNOWLEDGE_NOT_REMOVED$/, retry: 'described',
    zh: '旧版本收进知识库的文档没能删除，知识库可能正忙。稍后点「重试」。',
    en: "The replaced version's knowledge-base document could not be removed; the knowledge base may be busy. Select Retry later." },
  { code: /^FINALIZATION_REPLACED_MANUSCRIPT_PUBLICATION_REQUIRED$/, retry: 'described',
    zh: '新定稿的正文文件还没写入，旧版本的正文文件先留着。请先重新写入本章的正文文件，再点「重试」。',
    en: "The new final version's manuscript file is not written yet, so the replaced version's file stays for now. Write this chapter's manuscript file again first, then select Retry." },
  { code: /^FINALIZATION_REPLACED_MANUSCRIPT_KEPT(?::.*)?$/su, retry: 'described',
    zh: '旧版本的正文文件{names}定稿后被改过，没有删除。不需要的话自己删除或改名，再点「重试」。',
    en: "The replaced version's manuscript file {names} was changed after it was finalized, so it was kept. If you no longer need it, delete or rename it yourself, then select Retry.",
    enMany: "The replaced versions' manuscript files {names} were changed after they were finalized, so they were kept. If you no longer need them, delete or rename them yourself, then select Retry." },
  { code: /^FINALIZATION_REPLACED_MANUSCRIPT_BUSY(?::.*)?$/su, retry: 'described',
    zh: '旧版本的正文文件{names}被其他程序占用或只读，删不掉。关掉占用的程序或去掉只读，再点「重试」。',
    en: "The replaced version's manuscript file {names} is open in another program or read-only, so it could not be deleted yet. Close that program or clear read-only, then select Retry.",
    enMany: "The replaced versions' manuscript files {names} are open in another program or read-only, so they could not be deleted yet. Close those programs or clear read-only, then select Retry." },
  { code: /^FINALIZATION_REPLACED_CLEANUP_PENDING$/, retry: 'described',
    zh: '被替换的旧定稿留下的内容还没清理。点「重试」清理；和旧定稿对不上（可能改过）的会留着。',
    en: 'Content left by a replaced final version has not been cleaned up yet. Select Retry to clean it up; anything that differs from that version (it may have been edited) is kept.' },
  { code: /^POST_PROCESS_INTERRUPTED$/, retry: 'described',
    zh: '后处理中途停了，这一步没做完。点「重试」接着做。', en: 'Post-processing stopped before this step finished. Select Retry to run it.' },
  { code: /^CHAPTER_RESTORED_REPROJECTION_PENDING$/, retry: 'described',
    zh: '这一章从回收站恢复了，还没重新收进知识库。点「重试」收进去。',
    en: 'This chapter was restored from the trash and is not in the knowledge base yet. Select Retry to add it.' },
]

const IPC_PREFIX = /^Error invoking remote method '[^']+': Error: /u

/** 旧版本存下的步骤错误带 IPC 包装，先去掉再查表。 */
const entryOf = (error: string) => FINALIZATION_STEP_ERRORS.find(item => item.code.test(error.replace(IPC_PREFIX, '')))
const retryOf = (error: string | undefined): StepRetry => (error && entryOf(error)?.retry) || 'prompt'

/** 本流程认识的错误码（去掉 IPC 包装）；不认识时返回 undefined，原错误照常保留。 */
export function finalizationStepErrorCode(message: string): string | undefined {
  return entryOf(message) ? message.replace(IPC_PREFIX, '') : undefined
}

function detailNames(error: string): string[] {
  const detail = /^[A-Z][A-Z0-9_]*:(\[.*\])$/su.exec(error.replace(IPC_PREFIX, ''))?.[1]
  if (!detail) return []
  try {
    const parsed: unknown = JSON.parse(detail)
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

/** 步骤表里的错误码换成作者可读说明；表外的返回 undefined，由界面交给通用报错说明。 */
export function describeFinalizationStepError(error: string, text: (zhCNText: string, enUSText: string) => string): string | undefined {
  const entry = entryOf(error)
  if (!entry) return undefined
  const names = detailNames(error)
  const prompt = entry.retry === 'prompt'
  return text(
    // 用函数替换：文件名里的 $ 不当替换模式。
    entry.zh.replace('{names}', () => names.map(name => `「${name}」`).join('、')) + (prompt ? '请点「重试」重新生成这一步。' : ''),
    (names.length > 1 && entry.enMany ? entry.enMany : entry.en).replace('{names}', () => names.map(name => `“${name}”`).join(', ')) + (prompt ? ' Select Retry to generate this step again.' : ''),
  )
}

const FINALIZE_POST_PROCESS_STEP_KEYS = ['kb_import', 'chapter_notes', 'character_cards', 'remove_replaced_knowledge', 'remove_replaced_manuscripts'] as const
export type FinalizePostProcessStepKey = typeof FINALIZE_POST_PROCESS_STEP_KEYS[number]
const CURRENT_STEPS: ReadonlySet<string> = new Set(FINALIZE_POST_PROCESS_STEP_KEYS)

export type ReplacedFinalCleanupStepKey = Extract<FinalizePostProcessStepKey, `remove_replaced_${string}`>

export const REPLACED_FINAL_CLEANUP_STEP_LABELS: Readonly<Record<ReplacedFinalCleanupStepKey, readonly [zhCNText: string, enUSText: string]>> = {
  remove_replaced_knowledge: ['删除旧版本的知识库文档', 'Remove the replaced version from the knowledge base'],
  remove_replaced_manuscripts: ['删除旧版本的正文文件', "Delete the replaced version's manuscript file"],
}

/**
 * 一张定稿后处理卡（步骤名到结果）的重试安排。rows：可以单独重试的未成功步骤，各自对应这次重试要跑的步骤；
 * card：「重试失败步骤」要重跑的步骤，按卡上顺序；retired：现在流程已没有的步骤，不重试。
 * 现有步骤没有错误或错误没登记的照常可以重试。
 */
export function planFinalizationRetry(steps: Readonly<Record<string, { ok: boolean; error?: string }>>): { rows: ReadonlyMap<string, readonly string[]>; card: readonly string[]; retired: ReadonlySet<string> } {
  const entries = Object.entries(steps)
  const retired = new Set(entries.map(([key]) => key).filter(key => !CURRENT_STEPS.has(key)))
  const succeeded = new Set(entries.filter(([, step]) => step.ok).map(([key]) => key))
  const unfinished = entries.filter(([key, step]) => !step.ok && !retired.has(key)).map(([key, step]) => ({ key, retry: retryOf(step.error) }))
  const direct = new Set(unfinished.filter(step => step.retry === 'prompt' || step.retry === 'described').map(step => step.key))
  const pick = (ready: (key: string) => boolean) => unfinished
    .filter(step => direct.has(step.key) || typeof step.retry === 'object' && ready(step.retry.after))
    .map(step => step.key)
  const withSucceededPredecessors = (keys: readonly string[]) => {
    const rerun = unfinished.flatMap(step => keys.includes(step.key) && typeof step.retry === 'object' && step.retry.rerunIfSucceeded && succeeded.has(step.retry.after) ? [step.retry.after] : [])
    return entries.map(([key]) => key).filter(key => keys.includes(key) || rerun.includes(key))
  }
  return { rows: new Map(pick(key => succeeded.has(key)).map(key => [key, withSucceededPredecessors([key])])), card: withSucceededPredecessors(pick(key => succeeded.has(key) || direct.has(key))), retired }
}
