# 共享层纯函数的文本与计数口径

2026-11-26，注释清理（#852）第 3 个 PR（src/shared）。

## 背景

`draft-units.ts`、`draft-visible-text.ts`、`visible-text-integrity.ts`、`novel-config-ai-sources.ts`、`full-text-search.ts`、`render-prompt.ts`、`sqlite-time.ts`、`plural-en.ts`、`chapter-goal-review.ts`、`editor-inline-generation.ts` 等小型纯函数没有各自的 ADR，它们的注释解释了字数口径、可见文本投影、AI 来源指纹等规则。

## 决定

字数、可见文本与指纹这类会被持久化或比对的口径带版本、保持稳定：旧收据恢复时必须保持原投影与哈希，新写入走新口径。纯函数不访问文件系统，也不改写来源产物。下面按文件列出各条口径。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/chapter-goal-review.test.ts`

- 已覆盖两项，不代表目标已达成。

### `src/shared/chapter-goal-review.ts`

- `threadOutcome`：只出现在线索目标上，且只在模型给出有效结论时出现。
- `coverage`：coverage 只描述清单覆盖，绝不是允许定稿的许可（原文：Coverage describes the checklist, never permission to finalize a chapter.）
- `freezeChapterGoals`：只切分显式的当前章列表边界，不在语义上改写正文（原文：Only explicit current-chapter list boundaries are split; prose is not semantically rewritten.）
- `withChapterThreadGoals`：写稿时冻结的线索任务追加成目标；覆盖率只描述作者配置的目标，不随它变化。
- `locateGoalEvidence`：只允许多一层外层引号，绝不改写标点或空白（原文：Permit only an extra enclosing quotation pair, never punctuation or whitespace rewriting.）
- `normalizeChapterGoalReview`：只做机械的覆盖与证据校验，语义判断仍归模型（原文：Mechanical coverage/evidence validation; the model still owns the semantic judgment.）
- `validThreadOutcome`：存档的目标条目上线索结论是否成立；审稿记录和项目归档共用这一条规则。没有结论时成立。
- `parseChapterGoalReview`：读取持久化的规范报告，含没有这个可选字段的历史报告（原文：Read persisted canonical reports, including historical reports without this optional field.）
- `chapterGoalReviewItems`：确定性的展示投影，不是另一个可编辑的目标事实源（原文：A deterministic presentation projection, not another editable source of goal truth.）

### `src/shared/chapter-role.ts`

- `labels`：null 表示存下的是自定义标签，原样显示（原文：null marks a stored custom label, which is shown verbatim.）
- `chapterRoleOptions`：下拉选项含存下的自定义值或未设置项，让真实值保持选中可见，不悄悄显示第一项（原文：Options for a role <select>: the canonical list, plus an entry for the stored value when it is a custom label or not set yet. That entry keeps the real value selected and visible instead of silently showing the first option.）
- `chapterRoleSelectValue`：显示值取存储值，空白才落到未设置项；trim 只判未设置，不改写存储串，带空白的自定义标签仍匹配其选项（原文：The display value for a role <select>: the stored value when it is non-blank, otherwise the unset option's value. Trimming only decides "unset" here; it never rewrites the stored string, so a padded custom label still matches its option and stays selected.）

### `src/shared/chapter-time-continuity.ts`

- `chapterTimeContinuity`：起草契约在所有使用方之间保持逐字节一致（原文：Keep the established drafting contract byte-for-byte across its consumers.）

### `src/shared/draft-status.ts`

- `DraftStatus`：草稿状态：主进程、草稿索引与工作流共用
- `WORKING_DRAFT_STATUSES`：还能继续写、改、审的工作稿状态；旧版本审稿留下的 reviewed 也算（#411）。
- `CURRENT_DRAFT_STATUS_SQL`：CURRENT_DRAFT_STATUSES 的 SQL IN 列表片段，主进程查询「最新一稿」时共用。

### `src/shared/draft-units.ts`

- `DRAFT_UNIT_ALGORITHM_VERSION`：持久化的字数口径带版本，已缓存的计数可迁移而不在一个项目里混用算法（原文：Version the persisted prose-count contract so existing cached counts can be migrated instead of mixing algorithms inside one project.）
- `countLegacyDraftUnitsV1`：v0.9.0 计数器只为持久幂等兼容保留，新写入与界面必须用 countDraftUnits（原文：The v0.9.0 counter is retained only for durable idempotency compatibility. New writes and UI must use countDraftUnits().）
- `lastCounted`：单章视图首屏与编辑器挂载各数一次同一份正文，动作条每次渲染也数一次；1 万字一次约 1 ms，同一份文本只数一次。
- `countDraftUnits`：字数口径：每个汉字码点算一，任何文字的词算一，数字与其他非词可见码点沿用逐码点，空白标点符号含 emoji 不算（原文：Count the visible prose unit used by chapter targets, storage, and UI. - Every Han code point counts as one, including non-BMP extensions. - Words in any Unicode script count as one, so accented Latin text is not split into an ASCII word plus one or more stray characters. - Digits and other non-word visible code points retain the historical per-code-point behavior. - Whitespace, punctuation, and symbols (including emoji) do not count.）

### `src/shared/draft-visible-text.ts`

- `DRAFT_CONDENSE_PURPOSE`：超长正文唯一一次压缩修订的尝试用途；主进程组合时以其全文替换此前正文。
- `looksLikeReasoning`：缺开标签只在前缀自证是推理、或后接结构化输出时才当隐藏推理，否则保留正文只删畸形标签（原文：A missing opening tag is only safe to treat as hidden reasoning when its prefix identifies itself as reasoning, or when it precedes structured output. Otherwise retain ordinary prose and remove only the malformed tag.）
- `seen`：已有 v1 收据恢复时必须保持原投影与哈希（原文：Existing v1 receipts must retain their exact projection and hash on recovery.）
- `composeDraftVisibleContinuation`：独立原始可见产物的纯投影，来源产物不变（原文：Pure projection of independent raw-visible artifacts; source artifacts stay unchanged.）

### `src/shared/editor-inline-generation.ts`

- `EDITOR_INLINE_INSTRUCTION_MAX_LENGTH`：上限按码点计，不是 UTF-16 单元。
- `EditorContextReadKind`：渲染层从库里读的块。
- `EditorContextDocumentKind`：主进程从冻结的正文里切的块。
- `EDITOR_CONTEXT_PLAN`：每个工具带哪些块，按发给模型的顺序排。
- `EDITOR_CONTEXT_TRIM_ORDER`：窗口不够时可选块被裁的先后。
- `EDITOR_CONTEXT_PREVIOUS_ENDING_BELOW`：选区前的正文短于这个字数时，续写才去读上一章结尾。
- `EditorInlineChapterContext`：章内编辑时渲染层备好的候选块；架构文档、恢复稿和升级前的运行没有。
- `unreadable`：读不出而略去的块。
- `EditorInlineMaterials`：主进程开跑时选定并冻结的材料，重建时原样沿用。
- `filePath`：发起时所在稿的 filePath；升级前的运行没有。
- `editorInlineInsertsAfterSelection`：开跑时带了材料（章内是本章材料，没有章号只有前文和后文）的续写只输出接续的新内容，接受时插在选区之后；升级前的续写和其他工具替换选区。
- `editor-inline:delivered`：气泡把这次的建议显示给作者了；之后运行侧页不再列出它。

### `src/shared/full-text-search.ts`

- `fullTextTerms`：中文没有空格分词，连续汉字拆成相邻二元组；其他文字和数字按整词。
- `rankFullText`：区分大小写计数，与 LIKE 筛行一致，没命中的行不进统计，所以传全部段落和只传筛出的行排序相同。 排序结果只由分数、正文、文件名决定，与行 id 和导入顺序无关。

### `src/shared/novel-config-ai-sources.ts`

- `AI_SOURCE_FIELDS`：设定细则里哪些项的当前内容出自 AI。 每项记 AI 写入时那段文字的指纹；读的时候指纹和当前内容对得上才算 AI 的。 作者、Agent 提案或任何别的写入改了这一项，指纹就对不上，标记自然消失，不用每条写入路径各自去清。
- `AiSourceKind`：filled：整项由 AI 写；expanded：AI 在作者原文后面补写。
- `fingerprint`：FNV-1a 32 位。只用来判断「还是不是 AI 写的那段」，不防篡改。
- `configText`：读出的设定值类型不对时按空文本算：坏数据不让设定页、流程脊或 AI 补全崩。
- `aiSourceOf`：这一项此刻是不是 AI 的内容；作者改过、空着或记录对不上都是 null。
- `recordAiSources`：filled：原来空着或原来就是 AI 写的；expanded：原来有作者内容；没变的项保留仍然有效的旧标记。
- `parseAiSources`：从库里读出的标记：认不出的项丢掉，整段坏了当作没有标记（都按作者内容显示）。

### `src/shared/planning-material-prompts.ts`

- `getPlanningMaterialExtractionTemplate`：内置材料提取指令的唯一来源（原文：Single source for the built-in material extraction instructions.）

### `src/shared/plural-en.ts`

- `pluralEn`：英文里数量后的名词：1 用单数，其余（含 0）用复数。复数默认加 s，不规则的（entry → entries）显式传入。

### `src/shared/render-prompt.ts`

- `appendRequiredPromptContext`：只追加自定义提示正文遗漏的权威值（原文：Appends only authoritative values that a custom prompt body omitted.）
- `fillVariables`：一次扫描代入，变量值按字面写入：值里的 $ 记号与 {{占位}} 都不再被解释。
- `renderPromptTaskGuidance`：只渲染可编辑的创作指导，不含模板正文或隐藏的输出后缀（原文：Render only the editable creative guidance, without the template body or hidden output suffix.）
- `builtinTemplate`：自动追加系统约束（始终从内置模板获取，不受用户自定义影响）

### `src/shared/sqlite-time.ts`

- `SQLITE_TIMESTAMP`：SQLite 的 CURRENT_TIMESTAMP 与 datetime('now') 的写法：不带时区的 UTC，精确到秒。
- `sqliteTime`：数据库记下的时刻。SQLite 写的是不带时区的 UTC，直接交给 Date 会被当成本地时间；其余写法（ISO 等）照常解析。

### `src/shared/visible-continuation.ts`

- `composeVisibleContinuation`：输入已是可见文本，来源产物字节绝不修改（原文：Inputs are already visible text; source artifact bytes are never modified.）

### `src/shared/visible-text-integrity.ts`

- `assertMechanicallyCompleteVisibleText`：AI 产出可见文本的唯一机械完整性门：stop 终态不证明文本通过它，所以首次执行、恢复续跑与主进程提交共用（原文：The single mechanical-integrity gate for AI-produced visible prose. A `stop` finish reason does not prove the text passed it, so every path that accepts such text (first execution, recovery resume, main-process commit) shares it.）
