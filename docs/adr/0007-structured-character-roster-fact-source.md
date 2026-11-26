# 结构化角色名单是角色事实源

角色身份、定位、资料与关系只以 SQLite `characters` 中的结构化角色名单为事实源；`characters_arch` 是由角色名单确定性生成的只读角色图谱投影，旧项目的原始 Markdown 另行保留作迁移证据。新生成直接要求版本化结构数据，并在完整校验后用单个事务提交角色名单与角色图谱；正常运行时不再从 Markdown 反向提取角色卡。这样牺牲角色图谱自由编辑和部分排版自由，换取角色卡、角色图谱与工作流成功状态不可分裂，并消除模型排版变化导致角色名单归零的故障类别。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/relationship-presentation.test.ts`

- 展示层不自动改写持久化数据；用户主动编辑前保留原有值。

### `src/shared/character-roster.ts`

- `CharacterRole`：结构化角色名单的跨进程契约。 角色的持久化事实仍只存在于 SQLite characters 表；本文件只定义读写 seam 的数据形状，不引入第二份 roster JSON 事实源。
- `characterRosterIdentityKey`：角色名单变更边界共用的规范身份键（原文：Canonical identity key shared by roster mutation boundaries.）
- `CharacterRosterStatus`：面向界面的可执行状态。migrationState 保留持久化来源，status 则把安全 判断收敛为调用方真正需要处理的四种情形。
- `targetCharacterId`：M02 作者编辑需要 ID，target 只是显示快照（原文：Author editing on M02 requires an ID; target remains a display snapshot.）
- `provenance`：来源按字段记录，因为同一个状态对象可同时含作者值与派生值（原文：Field-level because one state object may contain author and derived values.）
- `CharacterRosterEntry`：旧候选里名字仍可读，M02 作者编辑要求稳定 ID（原文：Names remain readable in old candidates; M02 author edits require stable IDs.）
- `characterId`：draft:UUID 是本地作者创建的选择键，从不是持久 ID（原文：draft:<UUID> is a local author creation selection key, never a persisted ID.）
- `legacyRelationshipNotes`：旧 characters.relationships 的自由文本证据。只会由 read 返回，或由 manual_edit 原样回写；模型生成、导入、蓝图同步、章节推进与旧图谱修复 均不可提交此字段。
- `currentDerivedFields`：只读界面视图：由写稿来源投影证明为当前的派生字段，不持久化不提交（原文：Read-only UI view: derived fields proven current by the drafting source projection. Not persisted or committed.）
- `factHash`：覆盖角色资料、结构化关系与 currentState 的完整事实哈希。 身份 schema 项目按稳定 characterId 与关系目标 targetCharacterId 派生， 因此角色改名或同名目标重指向都会改变它；旧项目沿用姓名版本，保持兼容。
- `nameOnlyFactHash`：持久化在 `character_roster_meta.fact_hash` 的姓名版本哈希。 身份 schema 项目升级后公开 `factHash` 会变成 ID 版本，但按姓名写入的历史 收据（例如旧项目导入回执）只能与这个值比较；读取路径不改写它。 已知限制：同名角色之间的**纯 ID 变化**（例如 A→B 重指向同名目标）只体现在 `factHash` 上，不会改变这个值，因此按姓名写入的历史收据看不到它。这是按姓名 记录回执本身的性质，不是本字段的缺陷；重放返回的是当前快照，不是历史事实。 需要区分 ID 版本历史时，应改为按 facts 契约版本记录回执，而不是重定义本字段。
- `legacyMarkdown`：升级前的 characters_arch 原文，仅作迁移证据，绝不反向解析为角色名单。
- `expectedIdentityRevision`：M02 作者编辑边界要求与名单修订号一起提供（原文：Required by the M02 author-edit boundary, alongside roster revision.）
- `renames`：仅 manual_edit 使用；由角色管理的草稿账本明确给出身份映射。
- `stateEffectiveChapter`：仅 manual_edit 使用。
- `revision`：始终等于 snapshot.revision；幂等 replay 返回当前无写入观察，不重放历史 payload。

### `src/shared/generation-owner-contract.ts`

- `characterRosterRevision`：authorInputs 和提示词里的档案读自哪个名册版本；没读到名册时不填。

### `src/shared/ipc-channels.ts`

- `db:character-roster-read`：结构化角色名单的唯一提交 seam。角色条目仍持久化于 characters 表； 返回的快照经过主进程事务内 read-back 验证。

### `src/shared/relationship-presentation.ts`

- `parseStructuredRelationships`：接受旧项目已持久化的结构化关系形状；返回 null 区分无结构的用户笔记与有意为空的结构化关系列表（原文：Accepts the structured relationship shapes already persisted by legacy projects. Returning null distinguishes unstructured user notes from an intentionally empty structured relationship list.）
- `formatRelationshipsForEditor`：为角色编辑器格式化结构化持久数据：自由笔记有意原样不动，语法合法但不认识的 JSON 给修复指引，不向用户暴露存储语法（原文：Formats structured persistence data for the character editor. Free-form notes deliberately stay untouched; syntactically valid but unrecognized JSON receives repair guidance instead of exposing storage syntax to the user.）
- `relationshipStorageFromEditor`：仅当每个非空行都是对已知角色的无歧义关系时才转成图谱可读 JSON，否则保留原文，由名单接缝按旧笔记保存（原文：Converts an editor value to the canonical graph-readable JSON only when every non-empty line is an unambiguous relation to a known character. Otherwise it retains the original text, which the roster seam preserves as legacy notes.）
- `parseRelationshipEdges`：持久 JSON 与旧纯文本笔记的共享图谱解析接缝，调用方可传可见名单防悬空边（原文：Shared graph/parser seam for persisted JSON and existing plain-text notes. Callers may supply the visible roster to prevent dangling graph edges.）

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/__tests__/vela-protocol-character-roster.test.ts`

- 清空创作字段经作者退休路径删除角色卡，不直接写 roster 表或 characters_arch 投影。

### `src/services/character-roster-client.ts`

- `characterRosterEntryFromCard`：Renderer/workflow 侧只负责把现有角色卡形状送入唯一 roster seam；最终 schema、闭包与事务校验都留在主进程 CharacterRosterRepository。

### `src/services/project-fact-targets.ts`

- `PROJECT_FACT_TARGETS`：现行规则：这些规范文件名的含义属于结构化项目事实，通用文件写入绝不能造出第二份 Markdown 形态的事实来源（原文：Canonical filenames whose meaning belongs to structured project facts. Generic file writes must never create a second, Markdown-shaped fact source.）

### `src/stores/__tests__/character-project-context.test.ts`

- 断言前提：同一 ID 且规范化字节与已持久化卡片相同，则不再留有脏草稿（原文：Same ID and normalized bytes equal the persisted card; no dirty draft remains.）

### `src/stores/character-rename-ledger.ts`

- `mergeCharacterDraftWithRemote`：角色改名尚未落盘时，base/remote 仍使用旧主键，draft 已使用新主键。 先按改名账本统一身份，再对同一角色执行字段级三方合并。
- `baseById`：现行规则：名称与旧的改名元数据从不建立身份，未绑定的草稿单独保留，稳定 ID 写入器不能保存它们（原文：Names and legacy rename metadata never establish identity. Unbound drafts are retained separately and cannot be saved by the stable-ID writer.）
- `rebuildCharacterRenamesAfterSave`：保存期间允许继续编辑。除了把显式的二次改名接到刚落盘的新主键后，还要从 本次实际落盘的角色与当前草稿中恢复“改回原名”的身份链： A -> B 正在保存时，用户可能把 B 改回 A。此时普通草稿账本会正确认为草稿 回到了旧基线并清空 A -> B；但首个事务成功后，数据库基线已变成 B，所以 后续仍必须记录 B -> A。

### `src/stores/character-store.ts`

- `characterSelectionKey`：现行规则：未绑定草稿的选择键只是本地界面地址，绝不是持久化的角色身份（原文：Unbound draft selection keys are local UI addresses, never persisted character identities.）
- 现行规则：账本在磁盘上是异构的，只经类型化编辑器辅助函数读取请求的项目，其他项目的负载保持不透明并逐字节原样带过（原文：The ledger is heterogeneous on disk. Only the requested project is ever read through the typed editor helpers; foreign payloads stay opaque and are carried through byte-for-byte at the value level.）
- `rosterRevision`：当前角色卡来自的 roster revision；所有保存都必须带回这一乐观并发令牌。
- 现行规则：历史元数据只保留，绝不用作身份（原文：Historical metadata is preserved, never used as identity.）
- 删除同样是完整手工名单保存：由 roster seam 在一次事务中清理关系、 蓝图引用、投影、revision 与 receipt。失败时草稿仍在本地可重试。
- 空名单仍通过既有 roster 原子提交；主进程据此同步删除角色、关系和投影。
- `payload`：角色主键改名、删除、蓝图结构化引用、角色图谱、revision 和 receipt 都由主进程 roster seam 在同一事务内完成。

### `src/stores/project-editor-draft-ledger.ts`

- `mergeObjectDraftWithRemote`：以 base 为共同祖先执行字段级三方合并。 本地实际改过的字段保留 draft；其余字段采用最新 remote。
- `mergeNamedRecordDraftWithRemote`：角色名是现有角色卡的稳定记录键。对每条记录执行三方合并： 本地改/增/删优先，未改记录以及远端新增记录采用最新 remote。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/characters/CharacterProposalSelectionPanel.tsx`

- `CharacterProposalSelectionPanel`：分工：面板只受控展示作者选择，确认归宿主、原子写入归主进程（原文：Controlled author choices; the host owns confirmation, main owns the atomic effect.）

### `src/components/editor/character-extraction-policy.ts`

- `isCharacterExtractionReady`：零条角色只有在当前项目角色数据已成功加载并完成绑定后才代表“真的为空”。 加载中、未绑定或加载失败都不能开放会覆盖角色记录的重新提取操作。

### `src/components/editor/character-roster-repair-controller.ts`

- `CharacterRosterRepairPort`：分工：控制器管请求顺序，hook 提供 React 状态与实时项目会话守卫（原文：Renderer-specific port for the structured roster read / explicit legacy migration seam. The controller owns request ordering; the hook supplies React state and the live project-session guard.）
- `CharacterRosterRepairController`：不变式：名单读取、显式迁移与错误状态在项目会话切换时保持内部一致，且不依赖 React 以便直接测会话竞态（原文：Keeps the roster's read, explicit migration and error state internally consistent across project-session switches. It has no React dependency so the session race boundary remains directly testable.）
- 契约：invalidate 作废全部在途操作，且不触碰已卸载的视图（原文：Invalidate every in-flight operation without mutating an unmounted view.）

### `src/components/editor/character-roster-repair-state.ts`

- `getCharacterRosterRepairPresentation`：将持久化状态翻译为作者能理解的动作。这里不做任何数据访问或自动修复， 组件必须显式调用 migrateLegacyCharacterRoster 才会产生写入。

### `src/components/editor/use-character-roster-repair.ts`

- `settled`：本会话至少读完过一次名单（成功或失败），之前的 snapshot 为空不代表没有名单。
- `useCharacterRosterRepair`：分工：hook 共享只读名单状态与作者显式的旧名单迁移动作，加载视图时从不写入，控制器守完整项目会话身份（原文：Shared renderer hook for the read-only roster status and the author's explicit legacy migration action. The controller guards complete project session identity; it never writes while merely loading a view.）
- `projectId`：原因：只订阅身份字段，配置字段更新才不会重建名单请求或使有效编辑草稿作废（原文：Subscribe only to identity fields so a config-field update does not recreate a roster request or invalidate a valid editor draft.）
- `rosterRevision`：角色名单保存后修订号前进，名单全文投影与名单状态随之重读。修订号从无到有是角色卡首次载入， 首次读取已由上面的 effect 负责，不再多读一次。
- `visibleState`：规则：切换项目会话时从不渲染上一会话的状态，旧控制器由上面 effect 清理时作废（原文：The previous session's state is never rendered during a switch, even in the small interval before the next read resolves. The old controller is invalidated by the effect cleanup above.）

### `src/components/stage/architecture/ArchitectureSection.tsx`

- `RosterNotice`：角色名单需要修复或采用旧角色卡时的提示条，以及保存过的旧修复运行。
- 旧修复运行要查 generation:list（主进程串行处理，运行多时要几十毫秒），等四节读完再挂，不挡在打开架构的路上。

### `src/components/stage/architecture/StageArchitecture.tsx`

- `useCastSummary`：角色名单一节的摘要。角色卡在打开作品后单独载入（角色多时要几百毫秒），载完之前只这一节写「正在读取」，其余三节照常可用。
