# 打开作品时封存读不出的生成记录

2026-11-18，#702。本 ADR 替换 ADR-0029「后果」第 2 条原来的做法（恢复中断运行时跳过读不出的根）。

## 背景

ADR-0029 承诺一条记录坏了，只有读写它的操作报错。生成账本做不到这一点：

- 账本四张表有六个 JSON 列：`generation_roots.action_json`、`budget_json`，`generation_runs.binding_json`，`generation_attempts.attempt_json`、`usage_receipt_json`，`generation_artifacts.artifact_json`。
- 有近 30 条跨记录的语句，在条件里对这些列用 JSON 函数，或者整列取出再 `JSON.parse`。任何一格读不出，这些语句整条报错。新建生成、全书进行中查询、连续性检查页、选区建议都会因为一条无关的坏记录失败。
- 在读取点上逐个补守卫补了三轮，每轮审计都报出新的读取点，也没有东西拦住以后新写的读取点。
- 应用自己写不出读不出的 JSON，SQLite 的提交是原子的。这种格子只可能来自外部工具改库、躲过 `integrity_check` 的磁盘损坏或手工改过的存档。没有一例用户数据。

## 决定

1. **打开作品、拿到可写句柄之后做一次进门检查**（`admitGenerationLedger`，在 `initProjectDatabase` 里紧跟 `fenceProjectSession`）。
   - 五列查全部记录：`action_json`、`budget_json`、`attempt_json`、`usage_receipt_json`、`artifact_json`。
   - `binding_json` 只查没静止的树：根的 `action_json` 状态还是 `active`，或树里有「已预留」「已派发」的尝试。这条「没静止的根」查询和启动恢复（`recoverInterrupted`）选根用的是同一条（`UNSETTLED_ROOTS`）。这次要封存的树、记账要写入的运行，绑定也一并查，否则记账的 `json_set` 会让进门事务整条失败。
   - 静止树的绑定在被读的那一刻检查（决定 4 规则 4）。导出与备份前对六列再做一次全量进门（`admitWholeLedgerOfOpenProject`，在 `exportPortableProject` 外层、源库快照之前），这时发现的坏绑定照本决定封存。#702 S2，维护者 2026-11-19 同意。
   - 读得出指四条同时成立：存成 TEXT，不含 NUL 字符，`json_valid` 为真，顶层是对象。`usage_receipt_json` 允许 NULL。
   - 查 TEXT 是因为 BLOB 里的合法 JSON 过不了导出投影。查 NUL 是因为合法对象后面跟 NUL 和别的字节时，`json_valid` 只看 NUL 之前，`JSON.parse` 看全部。查顶层类型是因为 `null` 过得了 `json_valid`，建负责方时却抛错。NUL 按字符查，不按字节：UTF-16 编码的库里健康文本转成字节也带零。
2. **读不出的格子就地换成占位值，同一个事务里封存所属的根。**
   - 占位值只让跨记录的 SQL 不报错、让导出投影通过：项目号为空串，尝试状态是「结果不明」，预算四项都是 1。封存的根不会被解析（决定 4），所以占位值不必是一条看得过去的记录。
   - 所属的根把 `blocked_code` 改成 `GENERATION_LEDGER_UNREADABLE`。原来已有别的阻断码时照样覆盖，原码记进封存记录（`{"column":"blocked_code","previous":原码}`）。之后 `block()` 不再改这条根的码。封存是根的终态，只由这一列决定。
   - 原始字节按十六进制记进所属运行 `binding_json` 的记账区，键是 `$ledgerUnreadable`。根上的格子记在这条根按 rowid 的第一条运行上。`$` 开头的键是运行上的记账区，不属于冻结绑定，导出时整份 `binding_json` 被中性化。记账区原来的 `$ledgerUnreadable` 不是数组时，原值按 JSON 文本存成第一条（`{"previous": "原值的文本"}`），再追加，不加深嵌套。
   - 把树收尾：这条根上「已预留」的尝试改成「派发前取消」，「已派发」的改成「结果不明」，停表（运行中的区间累加进 `active_elapsed_ms`，`active_since_ms` 置空）。全书「有没有进行中的尝试」是一条纯 SQL 查询，不收尾的话封存树会让它永远为真，挡住全书的大纲保存。
3. **作品没有坏格子时，检查只是一条只读查询，不开事务、不写库。** 封存之后再扫是空的，所以重复打开没有写入，不需要「已处理」标记。扫到坏格子时，拿到写锁后再扫一遍，只换仍然读不出的格子：两次扫描之间别的连接可能已经修好了它。
4. **封存的根不透明：三条规则，都在 `GenerationRunRepository`。**
   - 规则 1：`get()` 和 `budget()` 对封存的根在解析任何 JSON 之前抛 `GENERATION_LEDGER_UNREADABLE`。运行和预算回执只能从这两处构造，所以封存根上的继续、重试、提交、写大纲、给批次进度都在第一次读取时被拒绝，不用在各处另写判定。
   - 规则 2：`open()` 按完整 `open_key` 找到同一次点击的已有运行时照常重放；找不到、要建新根或新运行之前，读封存树的两列身份键（根的 `idempotency_key`、运行的 `open_key`），里面有同一个（作品、操作、点击号）就拒绝。所有新派发都经过 `open()`，所以同一次点击不会在封存之后另开新根、再付一次费。定稿、导入、Agent 的点击号由槽位和前驱算出，重算出来的号也会撞上。身份键自己也读不出时按占用处理。
   - 规则 3：恢复中断运行跳过封存的根。树已经在封存时收尾，不需要再暂停。
   - 规则 4：没封存、绑定却读不出的运行（只会在静止的树里）由仓库按读取报 `GENERATION_LEDGER_UNREADABLE`。`get()` 解析绑定前按决定 1 的四条判读得出；按主键取绑定里一个值的读法、按根问「树里有没有某种运行」的读法同样报这个码，不把读不出当成「没有」。只有读写这一次生成的操作报错；列举用 `readableRun()` 略过它，恢复列表因此标「部分读不出」。规划续写指向的下一次生成读不出时，和被封存一样按回执给出「已续写」。
   - 列举一律略过封存的根：运行列表、批次列表、目录进度、清空蓝图时的退役、按登记号找 Agent 工作流。找不到登记而封存树里有 Agent 轮次时报封存码。目录进度回执的续跑句柄先按列比对所属的根，不同根的直接判无效，不去读那条运行。恢复列表在有任何封存根时标「部分读不出」。
5. **按绑定里的槽位查前驱的两处另外查身份键。** 槽位键只在绑定里，绑定被封存后按槽位查不到这条运行。`sealedClaims` 给出封存树占着的点击，两处各自说明怎样算可能匹配：
   - 定稿：点击号是 `finalization:<槽位键>` 或它的重试号时拒绝，免得二次提交角色卡或要点。
   - 导入：点击号以 `import:` 开头、操作是三个导入操作之一时，拒绝这一次导入的全部阶段和批次。同一次导入的各阶段互相检查前一阶段的效果，而槽位键是哈希，认不出属于哪次导入。能证明属于别的导入时放行：开这棵树的点击是全局事实或文风阶段，这两段的批次号固定为 `done`，用当前导入号重算出的槽位键对不上，这棵树就是别的导入的（导入的运行只挂在同一次导入最新的根下，树不跨导入）。只看点击号前缀会把碰巧以 `import:` 开头的普通生成也算进去。
6. **进门之后的代码照常信任账本。** 生产路径拿可写句柄只有 `getProjectDb()` 一个出口，它只发出进过门的句柄。各读取点上的 `json_valid` 守卫、跳过读不出的根、计数读不出的收据都删掉。
7. **清单只有一份**（`ADMITTED_LEDGER_CELLS`），里面没有 `binding_json`。扫描语句从它推导。
   - **绑定只在仓库里按主键或按根解析；跨记录认出一条运行只看身份键。** 仓库之外要绑定里的内容，先按身份键或尝试拿到运行号，再经仓库按主键读（`get()`、`readableRun()`）。
   - 守卫测试扫源码：跨记录语句在条件或取值列表里解析的账本 JSON 列必须在清单里。单表、条件里没有 OR、整个唯一键或 rowid 都等值限定的语句不算跨记录。`binding_json` 另外允许按根等值限定（`root_action_id=?`，没有 OR）：一棵树的运行有限，读不出时由仓库报封存码。子查询单独判，里面的主键条件不限定外层语句。
   - 守卫是按字符串字面量做的正则启发式，拼接的 SQL 和在 JS 里解析的列查不到。所以另有一条文本扫描：`binding_json` 这个词只许出现在仓库、进门模块、M01 结构、M03、导出投影（`project-archive-service.ts`、`portable-project-field-policy.json`）和打开时的证明整理（`review-proof-tidy.ts`，按主键读写，见 ADR-0031 决定 8）里。它不解析 SQL，不会漏报。
   - `open_key` 不进清单：它是唯一身份键，换成中性值会让同一次点击的重试找不到原来的运行。运行索引原样取出 `open_key`，在代码里解析。

## 跨记录认运行

2026-11-19，#702 S2 第一个 PR（#743）加入运行索引时补写，第三个 PR 把绑定移出清单时改写。协调者按设计采纳，待维护者确认。

跨记录找「哪次点击的运行」时只看身份键：

- **根一级看根的身份。** 根的 `idempotency_key` 和 `action_json` 由 `open()` 用同一个 action 在同一条 INSERT 里写入，带的是同一次点击（作品、操作、点击号）。旧名单和图谱的同一次点击、连续性建议按根的 `action_json` 查。
- **运行一级看 `open_key` 里的点击。** 运行索引（`generation-run-index.ts`）按它给候选：点击对上、根没封存的运行。走索引的有：目录进度、清空蓝图时的退役、导入阶段有没有绑过生成、Agent 整理扫描、Agent 会话的各轮、全部 Agent 运行、图谱事件键、同一次导入的各阶段、定稿与导入的槽位链、运行摘要（运行列表、恢复列表、蓝图恢复、批次列表）、可续批次与锁章。
- **`open_key` 读不出的运行**（索引里的 `unidentified`）由查找方各自决定，不统一成一种：
  - 定稿、导入的槽位链按主键读它的绑定，是这个槽位的就报槽位冲突（槽位不明）。
  - 列表类（运行摘要、恢复列表、可续批次、连续性建议）把它算进候选，再按主键读绑定，按作品与操作筛。
  - 目录进度、退役、Agent 整理扫描经仓库的 `runsOfOperation()`：按主键读绑定，认得出是这种操作（和这个作品）的才算。绑定也读不出的认不出，不算。
- **绑定只在按主键读到这条运行以后使用。** 原来的四处例外（定稿、导入的槽位链，锁章用的可续批次，清空蓝图时的退役）不再跨记录按绑定选，改按点击。
- **按尝试选的两处。** 启动与关闭时的恢复按尝试状态选没静止的根，恢复列表按收据里的正式效果略去已保存的审修、写稿运行。两处都只读尝试，不读绑定。读不出的尝试格子在打开时已由准入换成中性值，这两条语句读不到坏 JSON。

身份键和绑定一致，靠的是下面几条：

- 生产代码只有一个开运行入口（`createMainGenerationOwner` 里的 `service.open`）。点击和绑定的 `sourceManifest.operation` 取同一个 `selection.operation`。点击号由槽位、会话或导入号算出，这部分从 v1.2.0-Preview 起没变。重试另加 `:retry:<运行号>` 后缀：定稿从 v1.2.0-Preview 起就有（60865eec8），导入从 v1.5.0 起（762aeb815）。两列身份键写入后没有 UPDATE。
- 仓库在三个写入点断言操作一致，不一致报 `GENERATION_BINDING_INVALID`：`open()` 比请求的操作，`replaceUnstartedBinding()` 和 `resume()` 比库里 `open_key` 的点击操作。点击号和绑定里的槽位键、会话键、导入号是否对应，没有断言，靠的是上面那个唯一入口。
- 应用会写出绑定缺字段的行：进门封存时的占位绑定，导入后的冻结历史（导出投影的绑定不带 `sourceManifest.operation`）。原语句本来就按绑定把它们筛掉，走索引前后结果相同。

应用写不出的不一致行，即操作或点击号两边都有、却不相同的运行，只可能来自外部改库或手改存档。这种行上跨记录查找的结果**不保证与 1.4.0 相同**。S2 第三个 PR 起，原来的四处例外也按点击认，结果改为（方向都是从拒绝变成放行，测试按新结果改写）：

- 定稿槽位链：点击号属于别的槽位、绑定写着这个槽位的运行，不再报槽位冲突。
- 导入槽位链：同上，不再报槽位不明，读这个槽位得到原来那条运行。
- 可续批次与锁章：点击的操作不是批量写稿的批次运行，不列，写过的章也不锁。
- 清空蓝图时的退役：点击的操作不是蓝图目录的运行不退役。

其余按代码逐处推出的后果：

- 运行摘要与恢复列表里的可续批次：运行列表、恢复列表、批次列表漏列这条运行。
- 目录进度：已退役又没有进度回执的运行少一条诊断。
- 导入阶段有没有绑过生成：答「没有」。提交效果仍要生成句柄。
- 图谱事件键：这次运行自己确认过的事件被当成外部改动，报冲突。
- Agent 整理扫描：中断的工具调用停在「进行中」，这个会话不能往下走。
- Agent 会话的各轮：第一轮漏掉时报 `GENERATION_AGENT_ROOT_MISMATCH`。后面一轮漏掉时，会话会把它当成还没开始，可能在同一条根下再开一轮、再派发一次，花费受这条根的预算上限约束。
- 同一次导入的各阶段：漏掉的阶段不算前驱。下一阶段可能另开根，按单根上限重算预算，不沿用原模型；漏掉的那一阶段的效果也不再检查。

不在进门识别不一致行。识别要解析每条运行的绑定，而进门不检查对象内部的字段（决定 1，「后果」最后一条）。在 112 章夹具的副本上，读出全部运行的清单操作中位约 230 ms，这与把 `binding_json` 移出进门清单的方向相反。

## 不采用的做法

- **给 JSON 列加 `CHECK(json_valid(...))`。** 约束被违反时 `integrity_check` 报错，打开校验会把整本书判为损坏。一格的问题变成整本书打不开。
- **隔离表、生成列、索引。** 都会改变结构指纹，要升库版本。迁移通道也不允许在迁移里改已有行的内容，所以改写只能放在打开之后。
- **放在负责方创建时检查。** 负责方之外还有十处直接构造生成运行仓库，导出、删章、重开章节也直接读账本，放在负责方里会漏掉它们。
- **查到就拒绝打开，或停用整本书的 AI。** 比逐点守卫还差，而且作者没有出口。

## 后果

- 书照常打开，其余功能照常。封存的生成在任何地方都看不到，不能继续、不能重试、不能当续写的起点。同一次点击和同一个槽位永久被拒绝，没有手动解除的入口。维护者 2026-11-18 确认这几条。
- 与之前的表现不同：
  - 坏的是运行绑定时，那次生成没保存的候选稿从界面上消失，不能再复制。原始字节在库里。
  - 坏的是某次批量写作的记录时，这一批不出现在批次列表和恢复列表里，恢复列表标「部分读不出」。
  - 坏根没被审修循环引用时，便携存档能导出。之前报 `PORTABLE_UNSAFE_PROJECTION`。
- 坏根被审修循环引用时，那条循环读写报错。M03 遇到循环的根已封存就判失败，不读里面的占位值，所以封存不会让一条原来过不了 M03 的循环通过。证据记录（审稿、修稿、复核的尝试，以及合成里引用的尝试和产物）都要挂在循环自己的根和运行下。反过来会更严：同一条根下另一个尝试坏了，而它本来不是证据（比如没有回执的失败尝试），封存前 M03 不读它、能通过，封存后整条循环失败。升库版本放行已有的坏循环，导出把它留在存档外并指明章节（ADR-0029 决定 1），所以更严只少那一章的审稿记录，不挡整本导出。封存根在存档里按普通记录投影，不当审稿证据；导出会滤掉运行上以 `$` 开头的记账，存档里没有封存记录。
- 只有根、没有运行的根无处记原始字节，照常封存，原始字节不保留。应用建根时总在同一事务里建运行，这种行只可能来自外部改库。
- 四张表的 TEXT 主键允许 NULL，进门检查按 rowid 定位坏格子和它所属的根，主键为 NULL 的行同样换成中性值。这种行只可能来自外部改库，没有主键也就没有别的记录指向它。开书提示的封存条数把这种根也算上。
- 打开作品多一次 JSON 解析：五列全量，绑定只解析没静止的树。代价见下面的测量，随没静止的树的绑定字节数增长。导出与备份前的全量进门随全部绑定字节数增长。
- 回退到 1.4.0 仍能打开：占位值是合法 JSON，`$ledgerUnreadable` 留在绑定的记账区里。旧版本不认识封存，只认阻断码，封存根照样不能派发。
- 不在边界上检查对象内部的字段，比如绑定里某个字段是不是数组。这类错误只有人手改库造得出。

## 已知限制

- **身份键也读不出时拒绝全部新生成，定稿和导入的槽位读取也被拒绝。** 封存树里某个 `idempotency_key` 或 `open_key` 读不出，就认不出它是哪次点击，规则 2 按占用处理，这本书的所有新生成都被拒绝。定稿、导入按槽位读取已有结果时先查封存占位，所以读一个健康槽位的已有结果也报 `GENERATION_LEDGER_UNREADABLE`。这要两处同时坏：六列里有一格坏，身份键这一列也坏。身份键自己坏而六列都好的运行不归进门管，按槽位查前驱的两处在代码里解析它，读不出报槽位冲突。
- **从蓝图批次开的封存导入树挡住全部导入。** 前一条根预算用完或被取消后，蓝图批次会另开新根。这种树的开树点击带的是批次的槽位键，批次号由章节范围算出，重算不出来，认不出属于哪次导入，后面所有导入生成都被拒绝。
- **跨记录的查找读到占位值。** 按绑定或回执里的内容查找时查不到被封存的记录。逐条追过调用方，都不放行动作：
  - 导入阶段有没有绑过生成（`import-run-repository` 的 `bound`）答「没有」。唯一的生产调用方总是带着校验函数，提交效果仍要求生成句柄，带上封存的句柄被规则 1 拒绝。
  - 目录进度按操作号查不到。接着续跑被拒绝（`GENERATION_DIRECTORY_CONTINUATION_INVALID`）；从这次蓝图提交派生的角色提议没有生成出处，批准被拒绝（`CHARACTER_PROPOSAL_PROVENANCE_REQUIRED`）。回执完好而根的其他格子被封存时，读这次提议的出处报封存码；待处理提议列表逐条吞错，只略去它。
  - 审修的来源查找找不到被封存的审稿回执，报 `GENERATION_REVIEW_LINEAGE_UNPROVEN`。
  - 图谱事件的查找键是每次开始时新生成的，只有这次运行自己重建时会查，而它先被规则 1 拒绝。
- **从别的根指过来的句柄。** 规划续写的回执指向下一条根。下一条根被封存时，原运行仍算已续写，回执照存的给出；再续写读到下一条根，被规则 1 拒绝。目录进度的续跑句柄、Agent 的子运行、审修来源都在同一条根下或只在拒绝路径上读。
- **规则 1 管不到不经 `get()`、`budget()` 的写入。** 仓库里有按 `run_id` 直接 `json_set` 绑定的方法，仓库外有 Agent 整理扫描直接改回执（把没做完的工具调用标成结果不明，方向安全）。以后审计若报出一处绕过规则 1 的危险写入，再在连接上加 TEMP 触发器兜底。

## 测量

112 章手动夹具的副本（448 条运行、336 条根），Node 直接跑语句，修前与修后交替各 9 次，取中位数。

- 进门扫描：中位约 0.33 s（修复轮 1 测得，本轮没改扫描语句；本轮同一脚本复测 366 ms，范围 303–451 ms）。几乎全部花在解析 `binding_json`。维护者接受这个代价，到 S2 为止。
- `get()` 每次多一条按主键取 `blocked_code` 的查询：读全部 448 条运行 816 ms → 827 ms，差值在范围内（699–911 对 718–925），没有可测的差别。时间花在解析绑定上。
- `open()` 的封存点击检查：没有封存根时 0.09 ms。
- 运行摘要加了「跳过封存根」的子查询：338 ms → 349 ms，差值在范围内，没有可测的差别。

S2 第三个 PR 把绑定移出清单后，同一夹具、同一方法（修前与修后交替各 9 次）：

| 情形 | 修前 | 修后（打开） | 修后（导出前全量） |
|---|---|---|---|
| 夹具原样（186 条没静止的根，绑定 59.9 MB） | 532 ms | 403 ms | 527 ms |
| 正常关闭之后 | 555 ms | 45.5 ms | 551 ms |
| 正常关闭后加 40 条作者已存的规划根（0.8 MB） | 588 ms | 51.2 ms | 567 ms |

- 正常关闭会把应用中断的根收尾，剩下没静止的只有作者已存、等续写的规划根。每 40 条约多 6 ms。夹具原样时打开仍慢，是因为副本带着上次没正常关闭留下的 186 条在跑的根，下次打开收尾后回到第二行。
- 按主键读一条审稿绑定（112 条，平均约 546 KB）：中位 9.1 ms，范围 1.1–18.7 ms。
- 实机（Electron，隔离数据目录，修前 master d4e798904 与修后交替冷启动各 6 次，取第 2 轮）：打开到画面出现 1817 ms → 1407 ms，`project:open` 1664 ms → 1268 ms，账本 SQL 合计 875 ms → 469 ms。修前最慢的一条是进门扫描（466 ms），修后最慢的是 `PRAGMA integrity_check`（375 ms），进门扫描不在前列。

## 后续

- **S2 运行索引**（已做）：跨记录查找改由索引按身份键认运行，绑定移出清单，只查没静止的树；守卫测试断言清单里没有 `binding_json`，违规 0 处。正常关闭后打开的扫描约 45 ms，没回到十几毫秒：剩下的时间在五列与没静止的树的绑定上，见上面的测量。
- **打开后提示一次**（已做）：`project:open` 的返回值带 `sealedGenerationCount`，即这次新封存的根数（数生成，不数格子），渲染端弹一次提示。同一次打开还有部分加载失败的报错框或重复定稿的修复说明时，提示排在它们之后，作者关掉前一个才弹；这些提示跟着这次打开的会话走：作者换书或关书时（包括提示弹出后，一本在途的书才打开成功），开着的提示撤掉，排着的不再弹，免得落在别的书上。不记「已提示」：封存后再扫是空的，下次打开自然不再提示。代价是提示弹出前应用崩溃或退出（包括前面的提示框还没关时）、这次打开被更新的打开请求顶掉、提示没关之前作者换了书，或封存之后这次打开又失败时，作者看不到这次提示，只有日志里的记录。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/draft-reconciliation.ts`

- `DRAFT_RECONCILE_PURPOSE`：生成前定稿对账：首稿请求之前的一次模型调用，把已定稿事实（含作者最新更正）与本章蓝图的 必需事件逐条对照，产出冲突清单与“与定稿一致的落实方式”。结果注入首稿提示（执行卡之后）以及 自动续写/压缩修订共用的作者资料块。 渲染层与主进程共用本模块：主进程据此从对账尝试的原始输出重算注入块，复核首稿提示除该块外 与材料准入收据绑定的 promptHash 完全一致，渲染层因此无法借“对账结果”夹带任意内容。
- `parseDraftReconciliation`：严格解析对账输出；任何形状不符都返回 null（调用方按“无对账”继续）。
- `states`：模型偶尔把 finalState 写成“要点名: 内容”的对象；按原顺序展开为“要点名：内容”。
- `asWritten`：不冲突的条目也保留模型给出的具体落实方式：只写“按原文”会让首稿按字面执行仍在等待条件的计划。
- `stripDraftReconciliationBlock`：主进程复核：若 prompt 恰好含一次由 output 渲染出的注入块（前接一个空行），返回移除该块后的 原始提示；否则返回 null。两种写作语言都尝试，块内容完全由对账输出决定。
- `withoutDraftReconciliationArtifacts`：写稿候选列表只列正文产物：生成前定稿对账的产物是依据而非正文，不作为候选行展示。

### `src/shared/draft-short-outline.ts`

- `draftShortOutlinePrompt`：生成的计划从不是作者证据或正文（原文：A generated plan is never author evidence or manuscript prose.）
- `draftShortOutlineTask`：章节草稿的首个请求，outlinePrompt 来自 draftShortOutlinePrompt（原文：The first request of a chapter draft; `outlinePrompt` comes from `draftShortOutlinePrompt`.）

### `src/shared/draft-source-dependency.ts`

- `DraftSourceDependency`：旧行省略 kind，都是精确的候选草稿依赖（原文：Old rows omit `kind`; they are exact candidate-draft dependencies.）

### `src/shared/generation-contract.ts`

- `GenerationTransportDiagnostics`：传输诊断是安全元数据，所有相对时间用请求的单调时钟（原文：Safe transport metadata; all relative times use the request's monotonic clock.）
- `safeTransportError`：绝不复制错误消息：服务商错误可能含 URL、凭据或输出（原文：Never copy error messages: provider errors can contain URLs, credentials or output.）
- `actualTokens`：实际用量绝不裁剪到估计值（原文：Actual usage is never clipped to the estimate.）
- 重开渲染端或会话不能把同一个作者 nonce 变成新的预算根（原文：Reopening a renderer/session cannot turn the same author nonce into a new budget root.）
- `assertReservation`：必须在根账本事务里、插入唯一预留之前运行（原文：Must run in the root ledger transaction before inserting a unique reservation.）
- `assertVisibleSnapshot`：只做 CAS 与前缀检查，持久确认属于仓库（原文：CAS/prefix check only; durable acknowledgement belongs to the repository.）
- `TERMINAL_PROVIDER_FAILURE_CODES`：重发同一请求修不好的服务商失败：运行带着码结束（原文：Provider failures that resending the same request cannot fix: the run ends with the code.）

### `src/shared/generation-knowledge.ts`

- `GenerationKnowledgeItem`：主进程签发的来源快照，不含外部路径、嵌入凭据或端点元数据（原文：Main-issued source snapshot. No external paths, embedding credentials or endpoint metadata.）
- `rank`：最终排名，从 1 起，等于数组下标加 1，材料组装重排后仍能取回检索顺序。升级前冻结的快照没有这个字段。

### `src/shared/generation-owner-contract.ts`

- `GenerationAuthorInput`：原始文本是为这次作者动作显式给出的，绝非推断的候选文本（原文：Raw text explicitly supplied for this author action, never inferred candidate text.）
- `authorInputs`：来自原运行不可变来源清单的读取投影（原文：Read projection from the original run's immutable source manifest.）
- `reconciliationPromptHash`：生成前定稿对账请求（`chapter-draft-reconcile`）唯一 user message 的 UTF-8 SHA-256。 存在时，写稿运行的首个物理请求可以是这次对账；随后的首稿提示须等于 promptHash 对应的提示， 或恰好多出由对账输出重算的注入块（见 `src/shared/draft-reconciliation.ts`）。
- `shortOutlinePromptHash`：自动大纲的冻结输入身份，历史运行没有（原文：Frozen input identity of the automatic outline; absent on historical runs.）
- `draftReconciliation`：生成前定稿对账：对账尝试的产物 id（永不作为正文候选），以及首稿应沿用的对账原始输出——首稿尚未发出时为最近一次 完整结束的对账输出；首稿已发出时，只有主进程复核到首稿提示确实带了注入块才返回，否则为 null。
- `draftShortOutline`：原生产物与最初派发的草稿任务，绝非可信的正文证据（原文：Native artifacts and the original dispatched draft task, never trusted prose evidence.）
- `selectedDrafts`：仅当最初选中的草稿仍与冻结来源引用匹配时存在（原文：Present only when the originally selected drafts still match their frozen source references.）
- `MIN_BATCH_CHAPTERS`：单次批量创作的章数边界；渲染层界面与主进程准入共用，主进程据此限定批量根预算（见 batchRootBudget）。
- `nextChapterNumber`：仅当所有请求的效果都已确认才为 null；auto_finalize 要等它的 outbox（原文：Null only when all requested effects are confirmed; auto_finalize waits for its outbox.）
- `GenerationRecoveryList`：运行侧页「可恢复」区的数据：主进程按运行的操作类型一次筛好，只读真正可能恢复的运行。
- `partial`：有运行读取失败；其余照常列出。
- `BeginGenerationRequest`：只表达选择与语义意图，身份、来源哈希与预算归主进程（原文：Selection and semantic intent only. Main owns identity, source hashes and budgets.）
- `importExecution`：仅作准入权威，绝不持久化进来源清单（原文：Admission authority only; never persisted in the source manifest.）
- `outputOverrides`：派发前冻结的有限语义例外，渲染端不能在运行时改契约（原文：Finite semantic exceptions frozen before dispatch; no renderer-time contract changes.）
- `continueDirectoryOperationId`：来自原子提交的目录范围的显式下一阶段导航（原文：Explicit next-stage navigation from an atomically committed directory range.）
- `batchId`：显式批量谱系，只有主进程创建不可变批量意图（原文：Explicit batch lineage; only main creates the immutable batch intent.）
- `preparationId`：主进程在异步起草上下文读取前签发（原文：Main-issued before asynchronous drafting context reads.）
- `finalizedCharacterContextId`：主进程签发，用于从不可变定稿正文按身份绑定的抽取（原文：Main-issued context for identity-bound extraction from immutable finalized prose.）
- `agentWorkflowRegistrationId`：主进程根据真实、已确认的 Agent 工具动作签发的登记（原文：Main-issued registration from an actual, confirmed Agent tool action.）
- `generation:reasoning`：易变的服务商文本，只供当前写作显示，绝不进运行视图或收据（原文：Volatile provider text for the active Writer display; never part of a run view or receipt.）

### `src/shared/graph-generation.ts`

- `key`：主进程签发的稳定上下文与 owner 查找键，不是渲染端事实哈希（原文：Main-issued stable context/owner lookup key, not a renderer fact hash.）

### `src/shared/ipc-channels.ts`

- `sealedGenerationCount`：这次打开时新封存的生成（根）条数，见 ADR-0030。

### `src/shared/recovery-candidate.ts`

- `RecoveryCandidateRecordInput`：渲染端输入，项目身份始终来自经校验的主进程租约（原文：Renderer input; project identity is always supplied by the validated main-process lease.）

### `src/shared/source-ref.ts`

- `ProjectEpoch`：S01 接缝：仓库仍是作者数据的唯一来源（原文：S01 seam only: repositories remain the sole source of author data.）
- `contentHash`：未经改动的 UTF-8 字节的 SHA-256，绝非规整过的作者正文（原文：SHA-256 of the unmodified UTF-8 bytes; never normalized author prose.）
- `span`：编辑器偏移是 UTF-16 码元，终点不含（原文：Editor offsets are UTF-16 code units, end exclusive.）
- `mayUseCandidate`：只有作者选定的当前草稿或已保存的直接前驱才能进上下文（原文：Only author-selected current drafts or the saved direct predecessor may enter context.）
- `transferAuthority`：仅作可携带的收据身份，绝非执行或作者内容的权威（原文：Portable receipt identity only; never an execution or author-content authority.）

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/editor-chapter-context.ts`

- `Read`：读不出（抛错或名册待修）记 unreadable；读到空就不带这一块。
- `prepareEditorChapterContext`：章内编辑时给主进程备候选块。读哪些块只看工具表。threadsLeftOut 是相关线索里超出条数或长度上限、没进线索块的条数，只给编辑器提示用。

### `src/services/editor-inline-generation.ts`

- `createEditorInlineGeneration`：现行规则：任务、模型、随机数与预算都归主进程，这个适配器只持有导航（原文：Main owns the task, model, nonce and budget. This adapter only holds navigation.）
- 回执失败不重试：运行仍列在侧页。

### `src/services/finalization-generation.ts`

- `runFinalizationGeneration`：现行规则：复用同一个持久的主进程槽位，已存的效果不重建提示词也不执行（原文：Reuses one durable main slot. Saved effects never rebuild prompts or execute.）
- `retryRunId`：作者点重试时看到的运行。主进程判断它没有可提交的结果时另开运行，用 modelId() 给出的当前分工模型。
- `latestFailure`：同一根下的另一步骤也有诊断，只看本步骤最近一次请求。
- `requested`：显式引用只对冻结它的那次运行有效；begin 换了新运行时按普通路径重新请求。
- 本次已发请求、或回放的是模型正常结束的候选：模型确实返回过结果，只是不可用，不能说成没发请求。

### `src/services/generation/generation-harness.ts`

- `GenerationTask`：现行规则：生成任务只描述语义，物理的供应商参数故意不在其中（原文：A semantic generation contract. Physical provider parameters are deliberately absent.）
- `budgetDemand`：现行规则：预算需求只表达语义范围，能力检查与物理预留归主进程（原文：Semantic extent only; main owns capability checks and physical reservation.）
- `reasoningStage`：现行规则：推理阶段是显式产品语义，省略时只按输出形状推导（原文：Explicit product semantics; omitted stages derive only from output shape.）
- `promptBudget`：字段用途：对受保护的结构化提示词可选的逐字节安全策略（原文：Optional byte-exact safety policy for protected structured prompts.）
- `maxTokens`：现行规则：物理请求控制只属于本模块的计划，调用方不能带 maxTokens（原文：Physical request controls belong exclusively to this module's plan.）
- `sectionName`：字段约定：稳定且不含敏感信息的段落名，供回执与本地化诊断使用（原文：Stable, non-sensitive section name used by receipts and localized diagnostics.）
- `messageIndex`：字段语义：这段拼好的片段在最终消息数组里出现的下标（原文：Index in the final message array where this exact assembled fragment occurs.）
- `finalText`：字段约定：最终组装请求里的原文片段，绝不进报告或日志（原文：Exact fragment from the final assembled request; never copied into reports or logs.）
- `limitUtf8Bytes`：字段语义：对一段受保护证据的可选独立上限（原文：Optional independent ceiling for one protected evidence section.）
- `displayName`：字段约定：诊断用的安全可读名称，提示词正文绝不拷到这里（原文：Safe human-readable identity for diagnostics; prompt text is never copied here.）
- `PromptBudgetReport`：现行规则：提示词诊断是安全的，提示词正文与供应商端点细节故意不在其中（原文：Safe prompt diagnostics. Prompt text and provider endpoint details are deliberately absent.）
- `modelExecutionLeaseId`：现行规则：租约身份属于主进程，渲染端永远拿不到模型密钥快照（原文：Main-process lease identity; the renderer never receives its model secret snapshot.）
- `endpointFingerprint`：字段约定：主进程租约回执给出的权威非密钥身份（原文：Authoritative non-secret identity supplied by the main-process lease receipt.）
- `resolvedCapabilities`：字段约定：主进程租约回执给出的权威非密钥能力证据（原文：Authoritative non-secret capability evidence supplied by the main-process lease receipt.）
- `maxRequestedOutputTokensPerAttempt`：字段语义：单次物理请求的意图级成本上限，与模型身份无关（原文：Intent-level cost cap for one physical request; independent of model identity.）
- `GENERATION_ABSOLUTE_BUDGET_LIMITS`：现行规则：应用级安全上限，工作流可选更小的意图预算，但任何模型能力或调用方都不能把一次运行放大到超出它（原文：Application-wide safety ceiling. Workflows may choose smaller intent budgets, but no model capability or caller may enlarge one run beyond these bounds.）
- `modelExecutionLeaseId`：现行规则：这是越过完成接缝的唯一模型授权（原文：The only model authorization crossing the completion seam.）
- `onChunk`：字段语义：供应商的临时文本，调用方必须与终态完成结果核对（原文：Provisional provider text. Callers must reconcile it with the terminal completion.）
- `CompletionPort`：现行规则：这是生成模块拥有的唯一真正的外部接缝（原文：The only true-external seam owned by the generation module.）
- `purpose`：字段约定：安全的语义任务标签，绝不含提示词、输出、端点或凭据（原文：Safe semantic task label; never contains prompt, output, endpoint, or credentials.）
- `failureCode`：字段约定：主进程规范化的失败类别，绝不是供应商响应原文（原文：Main-normalized failure category; never provider response text.）
- `throwIfLastAttemptTerminal`：现行规则：按运行回读的客户端以那次运行的最后一次尝试为准，诊断列出根下所有尝试，包括子工作流等其他运行（原文：For clients that read a run back instead of its receipt: that run's last attempt decides. The diagnostics list every attempt under the root, including other runs such as child workflows.）
- `invocationNonce`：字段用途：S05 主进程所有者外观所要求，重复值读到同一个持久尝试（原文：Required by the S05 main-owner facade; repeated values read the same durable attempt.）
- `onChunk`：字段语义：供应商的临时文本，绝不是终态或持久化证据（原文：Provisional provider text. It is never terminal or persistence evidence.）
- `PromptBudgetExceededError`：类语义：请求之前的失败，带安全报告，没有物理尝试回执（原文：Pre-request failure with a safe report and no physical-attempt receipt.）
- `GenerationAttemptError`：类语义：失败的物理尝试，带非敏感的预算回执，供编排与审计（原文：Failed physical attempt with a non-sensitive budget receipt for orchestration and audit.）
- `finishReason`：现行规则：缺失终态证据绝不等同于已完成的创作事实，适配器可保留省略值，这个接缝按失败关闭规范化（原文：Missing terminal evidence is never equivalent to a completed creative fact. Provider adapters may preserve omitted values and this seam normalizes them fail-closed.）

### `src/services/generation/generation-runtime.ts`

- `creativeStrategy`：现行规则：写作策略由调用方在异步准备之前捕获（原文：Project writing policy captured by the caller before asynchronous preparation.）
- `policy`：现行规则：禁止另给物理预算输入，一个预算同时服务两个消费方（原文：Alternate physical budget inputs are forbidden; one budget owns both consumers.）
- `MainGenerationRunHandle`：现行规则：这个句柄只有主进程的 begin 动作能签发（原文：Opt-in S05 handle. Only the main-process begin action may issue this identity.）
- `compositionEligible`：现行规则：只有主进程核实过的已结算 stop 或 length 产物才可组合，单看 status 从不授权（原文：Main-verified settled stop/length artifact; status alone never authorizes composition.）
- `MainGenerationReasoningEvent`：现行规则：供应商推理只送到当前展示，没有持久的运行投影（原文：Provider reasoning is sent only to the active display and has no durable run projection.）
- `MainGenerationRunSummary`：运行列表里的一项：只够认出是哪个运行、什么状态、做什么的；要候选与账本再按 handle 读。
- `MainGenerationTransport`：现行规则：传输接口里没有供应商、模型租约创建、预留或根创建方法（原文：No provider, model lease creation, reservation or root creation methods exist here.）
- `readMainGenerationRun`：现行规则：这是纯读取接缝，不创建根也不续跑（原文：Pure read seam for F04; it neither creates roots nor resumes execution.）
- `installMainGenerationTransport`：现行规则：由中央类型化 IPC 适配器安装一次，没有接线时失败关闭（原文：Installed once by the central typed IPC adapter; absent wiring fails closed.）
- 现行规则：送达顺序可能与提交顺序不同，较旧的已确认视图绝不替换较新的（原文：Delivery order can differ from commit order. Older acknowledged views never replace newer ones.）
- 现行规则：终态读取可能先于最后一条 running 通知到达，产物不变（原文：A terminal read can overtake its last running notification without changing the artifact.）
- 现行规则：旧式 onChunk 不能安全追加独立尝试，改用完整快照回执（原文：Old onChunk cannot safely append independent attempts. Use full snapshot receipts instead.）

### `src/services/generation/main-generation-transport.ts`

- `createMainGenerationTransport`：现行规则：构造是惰性的，调用之前既不读当前会话也不碰 IPC（原文：Construction is inert: neither current session nor IPC is read until a call.）

### `src/services/graph-generation.ts`

- `createGraphGeneration`：现行规则：这里只管导航，来源、任务、候选身份与持久效果归主进程（原文：Navigation only: main owns sources, tasks, candidate identity and durable effects.）

### `src/services/legacy-roster-generation.ts`

- `createLegacyRosterGeneration`：现行规则：固定任务、有限修复、来源证明与提议都只归主进程（原文：Main alone owns the fixed task, bounded repairs, source proof and proposal.）
- `receipt`：现行规则：主进程重放缓存的序号，并独自判定已知的畸形停止能否使用原有有限修复尝试之一（原文：Main replays cached ordinals and alone decides whether a known malformed stop can use one of the original finite repair attempts.）

### `src/services/stats-service.ts`

- `diagnosticWorkflowForCall`：现行规则：只有一步能拥有完整请求区间时才把持久的模型调用与工作流状态关联，含糊的并发运行故意保持工作流字段未知（原文：Relate a persisted model call to workflow state only when one step can own its complete request interval. Ambiguous concurrent runs deliberately keep workflow fields unknown.）

### `src/stores/workflow-reasoning-store.ts`

- `useWorkflowReasoningStore`：现行规则：推理只是易失的展示状态，隐藏的推理永远不进工作流历史或生成产物（原文：Volatile display state. Hidden reasoning never joins workflow history or generation artifacts.）
