# 角色状态与连续性投影绑定定稿来源

`characters.currentState` 继续保存在既有角色表中，但它不是一组来源一致的作者事实。每个动态字段分别记录作者输入、定稿派生或 legacy 来源。作者编辑只改变实际编辑字段的来源；同一状态对象可以同时包含作者值和派生值。升级前无法归属的非空值保留为 legacy，不推断为作者确认，也不由新的章节后处理静默覆盖。

章节后处理只提交模型实际返回的动态字段补丁。派生字段绑定既有定稿收据的 `draftId`、`finalizationId`、章节号和正文哈希；主进程在写入时重查该收据和当前定稿状态。作者值及来源未知的 legacy 值优先保留。人工状态的章节号只说明该输入的已知时点，不使伤势、位置或物品持有成为永久约束。

章节摘要与连续性事实继续使用 `summary_snapshots`，不建立第二套角色事实库。新投影绑定同一份定稿收据；引用必须能在该不可变正文中精确定位，但精确定位不证明摘要或陈述在语义上正确。较早章节被删除时不推进水位（2026-11-05 按 [ADR-0025](0025-chapter-trash-soft-delete-and-restore.md) 修订，原为从被删章起推进水位）：被删章自己的投影经 live 视图排除，不进写作提示；后续各章的投影绑定它们自己的正文，照常可信，可能依赖被删章情节的代价在删除确认里交给作者。补写缺口章与从回收站恢复也不推进水位。较早章节被重开稿替换时不推进水位（2026-11-03 按 [ADR-0024](0024-replace-finalized-chapter-via-reopened-draft.md) 修订）：该章自身的投影绑定旧收据，随来源绑定失效；后续各章的派生状态保留，继续进写作提示，它们与新正文可能的冲突由影响提示交给作者。替换后重跑该章的角色状态时，字段当前由后续章的派生值拥有、且那一章的来源仍是权威定稿的，不被覆盖。

派生投影过期而定稿原文仍可校验时，调用方回退到带版本的原文并可重建确定性定位。它不得把旧摘要重放成正确语义，也不得默认触发全书模型重抽取。正文提交、删除收据和现有自动定稿失败停批规则保持不变。

现在只有打开项目时修复遗留的重复定稿会推进水位。水位推进后，某一章的章节要点行过期，它的待确认项（角色状态与人物关系建议）没有有效的行可存，角色状态那一步以 `GENERATION_FINALIZATION_PREDECESSOR_REQUIRED` 拒绝（2026-11-12 修订）。作者在这一章点重试时，章节要点由模型重新生成并写到当前水位，再跑角色状态；旧要点不重放。只有作者重试的那一章重新生成，其他过期的章不动。重新生成时，蓝图里的章节要点若已被作者改过，不覆盖。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/character-continuity.ts`

- `ContinuityProvenance`：节点的来历，与 character_continuity_events.provenance_json 的 kind 一一对应。
- `kind: 'legacy'`：authorChapter：升级前这个状态字段就是作者填的，值是当时记下的章号。
- `value`：空串表示已清除。
- `seq`：同一系列内的写入次序。基线节点没有记录，按 0 算。
- `matchedAuthor`：只有定稿关系带：抽取这一章时，这条说法和作者当时的设定一样。作者之后怎么改设定都不改它。
- `CharacterRelationPair`：同一对角色（不分方向）的有效关系。conflict 为真表示说法互相冲突，交给读者判断，不替作者选。
- `firstVisibleChapter`：作者定的值「自第 N 章起」生效；派生值和基线是第 N 章写完后的状态，重写第 N 章时还不存在。升级前作者填的状态按当时记下的章，不按升级快照章。
- `seriesKey`：状态每角色每字段一个系列；关系每一行一个系列，同一对角色的多行互不覆盖。
- `DerivedRelationRun`：定稿对一对人物的说法里，值、方向、matchedAuthor 都相同的连续几章是一段，head 是最早那一章。 作者拒绝过其中一章的说法，整段都算拒绝。
- `authorMovedOn`：正文当时是照着作者设定写的，作者之后给这对人物换了从更晚的章起生效的设定：这段说法不再算数，也不和新设定并存。 作者只删掉设定、没写新的时，定稿记录照旧生效。
- `derivedRelationRuns`：按 relationshipId 分组，段按章升序。同一章重跑过几次时只认最后写入的说法。
- `latestNodesBefore`：写第 chapter 章时已经生效的最新节点。传 Infinity 得到当前值。ids 只筛结果里的主语，判断冲突时两个方向的节点都算。 定稿关系返回所在那一段的段首，不是最新一章的节点。 nodes 应来自只含有效节点的读取（派生节点的稿仍是定稿，见 ADR-0024、ADR-0025）。
- `StateChapterRange`：last 是下一章和蓝图最后一章里较大的那个。
- `resolveStateEffectiveChapter`：章号不合法时退回下一章。上限挡住手误：节点不早于同系列已有的章，写太大的章号后这个字段之后的改动都会被推到那一章。
- `value`：removed 时是被去掉的旧值，其余时候是节点的值。
- `replaced`：作者采用定稿发现的关系时被换掉的旧值，这时 node 带着定稿的原文。
- `foldAdoptedRelations`：采用在事件表里是解除旧行、派生值、作者新值三个节点，作者看到的是一件事。靠同一次操作认定，手工改的不合并。
- `withoutRelationRestatements`：时间线只列变化：一段定稿关系只留段首，重述的段首也不留。 和作者设定一致的段只有在上一段是定稿自己的另一种说法时才算变化（正文回到了作者设定）。 说法和上一段一样、上一段和作者一致而这一段不一致时，是作者中途改了设定，正文没跟，算变化。 nodes 要带上这对人物两个方向的节点，只有一边时会把隔着对方说法的两段并成一段。
- `characterTimeline`：同章同字段的取舍规则与 latestNodesBefore 相同。

### `src/shared/character-identity.ts`

- `resolveCharacterIdentity`：候选来自项目与来源限定的精确别名查找，绝不用相似度（原文：Input candidates come from a project/source-scoped exact alias lookup; never similarity.）
- `advancesProjectContinuity`：验证过的转移来源共享拷贝的投影世代计数，同世代允许、章与修订顺序仍拒回退（原文：A verified transfer origin shares the copied projection generation counter: `${origin}:G` is treated as `${projectId}:G`, so an equal generation is allowed and chapter/revision order below still rejects regressions.）
- `decideDerivedPatch`：调用方在同一同步提交事务里重算哈希并读字段与权威（原文：Caller recomputes hashes and reads field/authority in the same synchronous commit transaction.）
- `rejectedCharacterProposalKey`：拒绝键按来源与值精确去重，新的定稿来源可以再提（原文：Exact source/value-scoped dedupe; a new finalization source may propose again.）
- `resolveScopedCharacterIdentity`：名字单独从不证明身份，匹配是精确、限定范围且带版本的（原文：Names alone are never proof of identity. Matching is exact, scoped and versioned.）
- `action`：作者动作由主进程显式给出，绝不从生成文本推断（原文：Main-process explicit author action, never inferred from generated text.）

### `src/shared/character-proposal.ts`

- `edits`：对规划材料候选的作者改动，只在显式采用决定时才应用（原文：Author changes to planning-material candidates, applied only with an explicit adoption decision.）

### `src/shared/character-role.ts`

- `normalizeCharacterRole`：角色值规整：未知旧值有意回退到最不意外的可编辑角色（原文：Normalize persisted or external role values before they enter application state. Unknown legacy values deliberately fall back to the least surprising editable role.）
- `getCharacterRoleLabels`：与语言无关的显示数据，供渲染端使用（原文：Locale-neutral display data for renderer consumers.）

### `src/shared/character-timeline-prompt.ts`

- `CharacterTimelinePromptLines`：按 characterId 存的提示词行。没有任何节点的角色不在里面，档案沿用原来的行。
- `withTimelessBaselineRelations`：M08 基线的状态是升级那一刻的快照；关系基线没有章号，是名单里一直有的事实，按开篇就有算。

### `src/shared/finalized-continuity.ts`

- `FinalizedSourceIdentity`：现有定稿收据字段，用来把派生材料绑到不可变正文（原文：Existing finalization receipt fields needed to bind derived material to immutable prose.）
- `projectionGeneration`：语义抽取开始前冻结的项目连续性水位（原文：Project continuity watermark frozen before semantic extraction starts.）
- `characterRefs`：显示标签保持可读，只有这些证明过的 ID 才是身份引用（原文：Display labels remain readable; only these proven IDs are identity references.）
- `FinalizedCharacterStateCandidate`：机器派生的定位器，从不成为作者确认的事实（原文：A machine-derived locator only; it never becomes an author-confirmed fact.）
- `characterId`：仅在保留的旧定位器上缺失，不足以作新写入（原文：Absent only on preserved legacy locators, never sufficient for a new write.）
- `candidateKey`：当前来源绑定的决定上存在，仅保留的旧行省略（原文：Present on current source-bound decisions; omitted only by preserved legacy rows.）
- `FinalizedCharacterEvidence`：偏移按 JS UTF-16 码元计，作用于不可变、未规整的正文（原文：Offsets count JS UTF-16 code units in the immutable, unnormalized prose.）
- `authorRelations`：只用来告诉模型作者已有的关系，不参与身份比较。升级前冻结的在途定稿没有这个字段。
- chapterNumber 标识已验证项目谱系内的章，草稿 ID 标识版本不是章（原文：chapterNumber identifies the chapter within the verified project lineage; draft IDs identify versions, not chapters.）
- `finalizedCharacterPromptCards`：只用于渲染，原字段仍是 CAS 基线；originProjectId 必须是主进程验证的转移权威（原文：Render only: the original fields remain the CAS baseline. originProjectId must be main-verified transfer authority.）
- `FinalizedCharacterStateOccurrence`：需要显式身份决定的模型出现项，绝不自动合并（原文：A model occurrence requiring an explicit identity decision, never an automatic merge.）
- `FinalizedRelationChange`：模型报告的一条关系变化，角色身份和原文都已校验。
- `FinalizedRelationCandidate`：派生关系与作者设定不一致时留给作者的待确认项，存在 summary_snapshots.character_state_candidates 里。
- `authorLinesAtCreation`：建议创建时这对人物两个方向的作者行，每项是 [来源, 目标, 关系] 的 JSON，已排序。升级前写的候选没有这个字段。
- `authorRelations`：列出时现读，作者后来改过就是改后的值。
- `parseRelationChanges`：relations 是附带产物：不合格的条目丢掉，绝不让它挡住状态更新或触发重新生成。
- `parseFinalizedCharacterStateResponse`：主进程用自己冻结的上下文重新解析已落定产物后才做领域提交（原文：Main re-parses the settled artifact with its own frozen context before domain commit.）
- 独立的码让修复回合能点名缺失字段，而不是只给空退出（原文：A distinct code lets the repair turn name the missing field instead of offering only the empty exit.）
- `sharedLabel`：即使模型给了明确 ID 也无法区分冻结显示标签相同的两个来源角色，保留出现项交作者批准（原文：Even an explicit model ID cannot disambiguate two source characters with the same frozen display label. Preserve the occurrence for author approval.）
- `currentFinalizedDraftId`：派生定位器过期时要读的当前定稿正文（原文：Current finalized prose to read when this derived locator is stale.）
- `characterStateCandidates`：只用来定位绑定的定稿正文，从不作为事实显示（原文：Used only to locate the bound finalized prose, never rendered as a fact.）
- `source`：仅缺失于来源无法安全重建的 v2 之前行（原文：Missing only for pre-v2 rows whose source cannot be safely reconstructed.）
- `sourceStatus`：缺失的旧调用方须与 legacy 完全同等对待，绝不算 current（原文：Missing legacy callers must be treated exactly like `legacy`, never current.）
- `projectionGeneration`：抽取前冻结的水位，过期的在途结果不得推进它（原文：Watermark frozen before extraction; stale in-flight results must not advance it.）
- `source`：抽取前冻结，主进程提交时重新校验（原文：Frozen before extraction; the main process revalidates it at commit time.）
- `projectionGeneration`：抽取前冻结的水位，过期的在途结果不得推进它（原文：Watermark frozen before extraction; stale in-flight results must not advance it.）
- `source`：抽取前冻结，主进程提交时重新校验（原文：Frozen before extraction; the main process revalidates it at commit time.）

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/workflow-guards.ts`

- `chars`：检查角色卡是否存在（不变量 1 的反向约束）
- `chars`：检查角色卡是否存在（不变量 1 的反向约束：无角色卡则阻断写稿）
- `prevScope`：不变量 2 的反向约束：前一章定稿后处理必须全部通过
- `guardCharacterRegeneration`：角色卡重新生成/补齐的前置校验： 不变量 1：角色卡仅允许在蓝图目录为空时重新生成， 否则会破坏已有蓝图/章节的角色状态链。

### `src/stores/character-rename-ledger.ts`

- `mergeCurrentStateDraftWithRemote`：定稿后处理按字段写入当前状态，作者也按字段改。作者改过的字段保留草稿值， 其余字段、来源标记与 updatedAtChapter 都取数据库最新值。刷新会把数据库快照当成新基线， 作者输入可能与基线文本相同，所以来源标记不同也算改过。

### `src/stores/character-store.ts`

- `currentDerivedFields`：现行规则：这是 IPC 校验过的展示授权，原始角色卡仍是作者编辑与历史的来源（原文：IPC-verified display grant; raw cards remain the author edit and history source.）
- `rosterLoads`：定稿发现的建议不改名单版本，建议列表靠这个计数重读。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/editor/character-state-fields.ts`

- `stateFieldView`：当前状态档案的一个字段：定稿派生、但已不在当前派生集合里的值是历史记录，编辑框留空，原值只作参考显示。
- `rosterStateChanged`：口径与保存时判定要写节点的字段相同。
- `authorStateEdit`：作者手改一个状态字段：记为作者输入，章节号沿用最后更新的那一章。
