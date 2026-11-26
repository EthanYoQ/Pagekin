# 定稿提交与实体稿发布

定稿以编辑器提交的不可变正文快照为输入，SQLite 中的定稿内容是事实源，根目录章节文本是可恢复的实体稿发布投影。一次定稿在数据库事务中更新正文与状态并登记发布任务，随后由实体稿发布器原子落盘并记录结果；落盘失败表现为“定稿已提交、实体稿待发布”，可以安全重试。完成结果携带定稿 ID、内容哈希和编辑器修订号，只有仍对应已提交快照的标签页才能清除未保存状态；提交后继续产生的本地编辑必须保留并显式进入冲突状态。

## 修订：章节的定稿可以被替换（2026-11-03，[ADR-0024](0024-replace-finalized-chapter-via-reopened-draft.md)）

每份定稿的正文快照和收据一经提交就不再改变。章节的权威定稿可以被替换：登记过重开关系的重开稿定稿时，commit 在同一事务里把本章原来的定稿降为只读的 `superseded`，再提交新定稿与收据。同一章任何时刻至多一行 `finalized`，由唯一写入口 `FinalizationRepository.commit` 在事务里保证。被替换的定稿不再发布实体稿，它留下的实体稿和知识库文档由新定稿后处理里的清理步骤处理。

## 修订：finalized 与 superseded 的唯一写入者（2026-11-05，[ADR-0025](0025-chapter-trash-soft-delete-and-restore.md)）

`finalized` 与 `superseded` 只由 `FinalizationRepository` 写。commit 替换、遗留重复定稿修复、从回收站作为旧版本放回，都经 `demoteToSuperseded`；从回收站放回原位经 `reinstateDeleted`，它在同一事务里检查本章至多一行 `finalized`，并把这份定稿的实体稿重新置为待发布。删除只把行标为 `deleted`，由 `ChapterDeletionRepository` 写。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/finalization-step-error.test.ts`

- `contractCodes`：合同解析函数抛出的每个码都会在提交时记到「角色状态更新」步骤上（#552）；从源码取全集，新增的码漏登记时这里先红。

### `src/shared/finalization-generation.ts`

- `notesBaseline`：notesBaseline 是实际的先前派生笔记，只作提交时的比较基线（原文：Actual prior derived notes, used only as a commit-time comparison baseline.）
- `latestAttempt`：本运行（不是整个 root）最近一次尝试。章节要点与角色状态共用一个 root，作者重试据此判断本运行是否还有在途请求、上次结果能否提交。
- `finalization-generation:begin`：retryRunId：作者点重试时看到的那次运行。它没有留下可以提交的结果时，主进程在同一 root 另开运行， 按 modelId（作者现在的分工模型）重新生成；有可提交的结果时沿用它。
- `finalization-generation:execute`：recoverFrom：以最近一次未成功尝试的 attemptId 为幂等键重新请求一次。界面重试改用 begin 的 retryRunId，不再发它。

### `src/shared/finalization-step-error.ts`

- `StepRetry`：失败后再点「重试」有没有用，决定界面摆不摆重试、说明末尾补不补「请点『重试』」： prompt 有用，说明末尾补提示；described 可能有用，说明里已写明前提，不再补；never 结果也一样，不摆重试； after 要等那一步成功后才有用，整卡重试会把它排在那一步之后一起重跑。
- `CHAPTER_RESTORED_REPROJECTION_PENDING`：从回收站恢复的章：知识库文档在删除时已清掉，kb_import 记这个码等重导（ADR-0025）。
- `POST_PROCESS_INTERRUPTED`：后处理在这一步做完之前就停了（取消、前面的步骤失败或应用退出）。
- 定稿后处理步骤的错误码。步骤记录里存错误码本身，界面展示时再按当前界面语言换成作者可读说明。
- `FINALIZATION_STEP_ERRORS`：enMany：{names} 有多个文件时的英文。
- 写生成记录失败时主进程把整个 root 阻断，重试同样被拦下。
- 生成记录缺了没写进去的尾部、已被丢弃或校验不符，不能拿来提交或修正。
- 角色状态字段已由更晚章节写过或来源对不上（#491），提交拒写；正文定稿不受影响。
- 模型连续几次的回答都不合角色状态的格式要求（#552）。重试另开一次运行，按现在「定稿后处理」的分工模型重新生成。 章节要点与角色状态提交都会抛这个码，说明不能只讲角色卡。
- 生成期间字段被作者或其他提交改过（#484）。重试沿用生成开始时冻结的角色状态，仍会拒写。
- 生成开始后正文依据的连续性记录变了（#512）：运行冻结的上下文不会变，重试先按来源已变拒绝。 CONTEXT_CHANGED 比对的字段提交前的来源校验已整组比过，按同一情形说明。
- 定稿时在场的角色后来被删除（#512），重试同样先按来源已变拒绝。
- 作品放在不支持硬链接的磁盘上，知识库每次提交都失败（#571）；搬到支持的磁盘后重试才有用。
- `entryOf`：旧版本存下的步骤错误带 IPC 包装，先去掉再查表。
- `finalizationStepErrorCode`：本流程认识的错误码（去掉 IPC 包装）；不认识时返回 undefined，原错误照常保留。
- 用函数替换：文件名里的 $ 不当替换模式。
- `planFinalizationRetry`：一张定稿后处理卡（步骤名到结果）的重试安排。rows：可以单独重试的未成功步骤，各自对应这次重试要跑的步骤； card：「重试失败步骤」要重跑的步骤，按卡上顺序；retired：现在流程已没有的步骤，不重试。 现有步骤没有错误或错误没登记的照常可以重试。
