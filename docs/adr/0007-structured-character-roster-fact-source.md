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
