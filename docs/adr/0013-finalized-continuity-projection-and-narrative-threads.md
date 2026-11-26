# 定稿连续性投影只源于已确认事实；叙事线索计划与投影分层

连续性事实与当前角色状态只由已定稿正文及既有结构化项目事实重建。叙事线索的人工计划（类型、目标章节范围和作者理由）是项目规划事实；AI 识别只生成候选，确认后追加带章节证据的线索事件，当前状态由计划与已确认事件折叠，重建不得覆盖人工计划。冲突检查始终是可继续的证据化警告，不自动改写蓝图、设定或正文；作者确认的修改或带理由的“这是有意安排”豁免才会持久化。

## 测试口径

`test/helpers/schema8-continuity-archive.ts`（注释清理 M30 第 2 个 PR 迁入）：

- 连续性基线的升级验收用的便携包，是从 db03cf70（schema 8）导出的真实包，不是合成数据。它保证验收覆盖真实旧库的形状，而不是夹具作者假设的形状。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/blueprint-continuity-check.ts`

- `ContinuityCheckChapter`：只放作者写的文本：时间戳进来的话，空保存也会让结果失效。
- `since`：节点的来历，和规则卡同一种说法。只给作者看，不进模型请求。
- `isChapterAsChecked`：比对的是检查时那份文本：改回原样，结论就回来。
- `selectContinuityCheckScope`：从第一章起按顺序放，放不下就停在上一章。单章要么整章进，要么不进。第一章总是放进去：预算只决定放多少，不拒绝检查（ADR-0026）。
- `promptId`：模型只见 e1、e2：真实 eventId 带 UUID，又长又容易抄错。
- `parseBlueprintContinuityCheck`：一条引用不成立只丢这一条；整段读不出来才算失败。
- `continuityFindingKey`：键只取自节点，章号由豁免行的 chapterNumber 承载：这样按章豁免和全书豁免都成立。

### `src/shared/blueprint-continuity-suggest.ts`

- `BLUEPRINT_PATCH_FIELDS`：建议只改这些规划文字。作者指导、备注和出场角色由作者自己管。
- `ContinuitySuggestionView`：一章一张卡：before 是检查时那份蓝图的原文，接受时写进去的就是 after。
- `parseBlueprintContinuitySuggest`：一条引用不成立只丢这一条；整段读不出来才算失败。 同一章的几条改的字段不重叠就合成一条；重叠时整章丢掉，免得写进去的文字对不上卡片上的任何一条说明。

### `src/shared/blueprint-relation-conflict.ts`

- `RELATION_TURN`：蓝图自己写了关系转折，相反就是作者要的安排，整章不报。
- `HINT_TURN`：「成为、变成」在蓝图其他字段里太常见，只在关系提示里算转折。
- `TURN_DENIED`：不含「原本、昔日、曾经、former」：它们修饰转折前的关系，不否定转折。
- `hintAssertsTurn`：先去掉转折词再查否定：冰释前嫌、重修旧好里的字不算否定。
- `relationPolarity`：只认词表里明确的说法。两类都沾、带否定或不确定词的一律不判，宁可漏报，不要误报。
- `continuityBasis`：派生节点没有定稿原文就没有依据（ADR-0017）。基线节点的章号是迁移时补的，不当章号给作者看，sourceChapter 记 0。
- `findRelationReversals`：键只取自节点：同一节点在别的章要用同一个键，全书豁免才管用。
- `findUndecidedRelations`：作者一直没决定时每换一种说法就留一条建议，这里每对人物只提示本章之前最新的一条。pending 按章升序。

### `src/shared/blueprint-semantic-contract.ts`

- `BlueprintNewCharacterCandidate`：新角色候选的定义：本蓝图首次引入的反复出现的具名角色（原文：A recurring named character first introduced by this blueprint.）
- `BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST`：来源清单稳定：校验代码与资格构建对同一份清单求哈希（原文：Stable provenance input; validation code and qualification hash this same manifest.）
- `BlueprintSemanticItem`：生成事实与服务商无关，持久化专用字段刻意缺席，由调用方在结果过缝之后补（原文：Provider-neutral generation fact. Persistence-only fields are deliberately absent: callers add those after the model result has crossed this seam.）
- `parseBlueprintJsonText`：只接受恰好一个 JSON 根或一个完整 Markdown JSON 围栏，绝不从叙事正文里搜嵌套 JSON（原文：Accepts exactly one JSON root or one complete Markdown JSON fence. It never searches narrative prose for a nested JSON fragment.）

### `src/shared/consistency-preflight.ts`

- `chapterNumber`：null 表示全书豁免。
- `authorSetting`：依据是作者自己写的设定：sourceChapter 只是生效章，不是出处。
- `relationshipHints`：未校验的 JSON，形状和 BlueprintData 的同名字段一致，由规则解析。
- `BlueprintRuleContext`：规则只产出 ConsistencyFinding，豁免在规则表外统一处理。
- `terminalCharacterScheduled`：故意收窄：只有结构化的死亡终态才和「本章出场」冲突。
- `findBlueprintContinuityRisks`：审稿入口不传 nodes 和 pendingRelations：它的结果冻结在审稿上下文里，恢复时要逐字段相等，升级后不能多出关系提示。
