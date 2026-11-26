# 质量改造实验协议：协议是唯一权威，账本只增不改

2026-11-26，注释清理（#852）第 1 个 PR（scripts）。

## 背景

`scripts/quality-modernization-driver.mjs`、`quality-modernization-run.mjs`、`quality-modernization-receipt.mjs`、`scripts/fixtures/quality-modernization-production.fixture.mjs` 以及 `scripts/__tests__/quality-modernization-*.test.mjs` 实现一套预注册的质量对比实验：两臂（baseline 与 candidate）经生产代码跑同一批场景，物理请求记进一份追加式账本，收据再交独立评审裁定。这些文件里有约 280 处解释「为什么这样断言、这样登记」的注释。本 ADR 把其中的决定迁到一处，源码注释随之删除。

## 决定

### 一、协议决定一切，桥只执行

1. 生产桥只是协议的执行者。场景登记的 `phase`、`caseId`、`operation id` 必须逐字等于该阶段的预注册内容；不一致就在建任何目录前阻断，而不是跑一个没预注册的实验。未登记 operations 的阶段 fail closed。
2. 阶段场景是协议阶段在桥一侧的对应物，只说明哪些生产命令实现哪些 operation。runner 在开门前逐字段重核，所以桥里的漂移会 fail closed，而不是悄悄跑另一个实验。
3. 每个 operation 的 `kind`、`restore`、`caseIds` 从 v4 起也逐字对齐：哪一案执行哪些后处理与续写只由协议决定，登记的 operation 序由 driver 的选择函数与结果侧校验共用，不按下标切片。
4. baseline 臂跑冻结在历史提交的驱动、走 generation runtime；candidate 臂跑当前驱动、走 generation harness。
5. 门禁与运行后检查用与 `ReviewChapterCommand` 相同的生产解析器；固定历史输入只按字节读取，只有拷出来的 donor 才允许被 SQLite 打开。

### 二、账本：只增不改，终态必须落账

1. 一份追加式 campaign 文件，靠 `wx` 锁防并发预留；撕裂的末记录 fail closed。已 dispatch 或 unknown 的发送永不释放额度，登记按「固定登记」而不是按 invocation 或 SHA 计，所以重启不能退还槽位。
2. `dispatch` 之后必须落 `settle` 或 `unknown`，未知不退款。第二次 UNKNOWN 既不退还登记也不许继续。
3. 终态写入幂等：同一 `attemptId` 只写一条；先写账本再记终态，写失败（如 `LEDGER_BUSY`）不吞终态，调用方可重试；`dispatch` 之前的取消只走 `cancel`。
4. **结算守护。** 桥测试的 120 秒超时是进程内计时器，不投信号、不先跑 `finally`；供应商卡住时「等流结束再写终态」永远等不到，账本只剩 `reserve` 与 `dispatch`，花费不可审计。所以每个 dispatch 的发送各自持有一个短于桥测试超时的截止时间：到点先写 `unknown`（占用、不退款），再 `abort` 其 fetch，先落账、后失败；之后的 attempt 从各自 dispatch 起获得完整预算。
   - **被拒绝的备选：** 改用 process 信号或 `exit` 钩子收尾。超时是进程内计时器，不发信号，SIGTERM 处理器不会触发；`exit` 处理器必须同步、等不了未决的流；worker 被强杀时两者都不运行。守护计时器活在同一事件循环里，`await` 网络时循环空闲，它一定会跑，正常收尾时由 `dispose()` 清除。
5. 超时层级：单个 attempt 的桥内结算预算短于父进程 spawn 预算，spawn 预算短于 Vitest 超时，给 `unknown` 落账与进程收尾留余量。post-UI 每臂最多 15 个登记 attempt（目录 3、正文 8、首审 2、修稿 1、复评 1）；early-review 三次串行发送，外层预算须覆盖三个完整 attempt。压缩使一次 operation 多一个物理 attempt，外层测试预算按 8 个串行 attempt 计。
6. 发送规模证据只记 UTF-8 字节数（纯数字、可 grep，多字节按真实 UTF-8），取自真正出站的请求体，绝不记提示词原文或凭据，让两臂在不花真实调用时可比。确定性的出站检查在记账前失败，不进网络诊断；供应商传输失败只在 `fetchProviderResponse` 一处进入 `fetchFailures`。

### 三、调用额度：只分类，不拒发（用户 2026-09-18 决定，ADR-0019）

1. 用户移除了真实调用硬上限。计划分配总额只用于协议一致性校验与汇报，从不拒绝发送；账本仍逐条记每次占用，上限是决策，记账是证据。最坏情形（压缩 9 次）仍在失败/重试/修复余量 22 以内，总计仍 80。
2. 因此 campaign id 从预注册协议里的 `novel-quality-program-v3-80-v1` 改为 `...-uncapped-v1`，使「80 帽时期」与现在的收据不混成同一 campaign；协议字节保持预注册原样。账本与桥取同一个常量：提交 2f259cd 曾只改桥一侧，早门在第一次发送前就以 `INVALID_CAMPAIGN_BINDING` 阻断（0 真实调用，当时未发现）。取代关系只能写一处。
3. 分配桶由阶段决定：early 用 early 桶，post-UI 重跑用 post-UI 桶（协议 `postUiContext: 2`），不混用；同一 slot 的重复发送或超出计划样本量的发送归入失败/修复余量。

### 四、历史边界：只加性认证，不改判

1. 旧协议 hash 下的真实 invocation 以「历史边界」登记：冻结前缀按边界 hash 逐字节认证，其旧的协议选择与分配只是历史证据，不是当前修订的输入，只重核稳定外壳。
2. 边界记录只含身份与证据字段，不含任何可把该 invocation 解读为「通过/改判/补采」的结论字段；失败事实与独立评审结论只写在 `quality-protocol.md`。
3. 每段的 `fromEventCount` 必须恰为前一段的链末端，更早的起点不能替代本段；事件数与 attempt 数不符一律拒绝；前缀或本段内任一字节被改，整段前缀 hash 即拒绝；整链回放自冻结前缀起依次认证到链末端。
4. `armBindings` 只登记实际出现的臂，每臂 `codeSha`/`sourceHash`/`driverHash` 必填；`parityId` 要么整臂一个值写在 `armBindings`，要么逐 attempt 写在 `reserveAttempts`，二者恰选其一。单一 `armBindings` 无法同时认证两个不同的 candidate 代码身份，所以按代码身份分成相邻两段登记。新段的三项身份都须不同于更早段（`driverHash` 与相邻段相同时用更早段身份替换才能证明三项独立）。
5. 旧协议 hash 的新 reserve 未登记为历史时，一律按当前协议拒绝；协议 hash 必须是候选代码提交里那份 `protocol.json` 的字节 hash（可复核时才断言）。
6. 版本不兼容的旧策略（如 post-UI 评审策略 v2）保留为历史 revision，不再作为可校验策略，旧目标因协议 hash 漂移被拒。前向资格只管新登记，历史 Pro 与 R3 登记保留各自身份；R3 保持八次总调用预算，每个原生审稿用途可替换一次 LENGTH 结果。

### 五、场景修订与「唯一压缩」

1. 场景修订键之间的关系：v3 只改登记（`attemptPolicy` 增加唯一压缩），作者世界设定输入与 v2 逐字相同，沿用语义源里登记给 v2 的同一条附加行，不改动冻结的语义源。场景登记的附加行只追加到作者世界设定，其余 revision 字节不变。
2. 唯一压缩（`draftCondense`）是产品原生能力的登记，不是任意失败的新重试权：只在同一 run/root/项目/epoch 的 `chapter-draft` 首请求已结算为 `stop`、其 hash 可复核的输出按生产计数超出 `draftTargetUnitRange` 上限时，许可一次 `chapter-draft-condense`；正式效果只落在末次 attempt；压缩不能作为首请求，也不能用于未登记的 operation。按臂生效：`draftCondense.arms` 缺省沿用 `attemptPolicy.arms`，post-UI v3 与 full v2 显式只给 candidate，baseline 因此从不获压缩许可、也不加载生产压缩常量。
3. **不对称必须在策略本身披露**，随协议、manifest 与每臂 receipt 的 `evaluationPolicy` 一并给出：candidate 有压缩、baseline 没有，不得据此单独声称相对改善。
4. 判定口径：压缩稿由主进程按同一份生产清洗从末次压缩原文组合（`draft-visible-v1` 组合；清洗只删不增，故结果侧「按生产计数超限」是触发压缩的必要条件，不放宽任何门）；首稿是否超长按首稿物理输出判，压缩稿是否落入范围按压缩稿自身判，最终稿（有修稿时是修稿产物）的范围由原字数门另判。post-UI 被审稿必须是压缩稿而不是被取代的首稿，full 每章没有审修链、保存稿必须就是压缩稿；修稿使最终稿越界时不归因于压缩登记；压缩稿仍越界时产品按原失败语义停下，不能因最终稿在范围内放行。
5. 压缩请求必须带全局写作要求（蓝图块之后紧接标题恰为【全局写作要求】），未登记用途一律拒绝；JSON 块止于其后第一个标题行，初始请求里空的【后续章节大纲预告】会被产品整段删去，此时接下一个标题。
6. 只有登记了压缩的 post-UI 才走 owner artifact 证据；early 与 v2 登记读到的是审稿证据，压缩因此无法放行。原生恢复只读该 attempt 的原始 artifact 与正式效果，同一草稿的旧审稿不代替本次 owner 证据。

### 六、恢复案与重新定稿后处理

1. C17-B 恢复副本内重新定稿后，登记的 notes/cards 后处理 operation 经与 C16 同一的 `RunFinalizePostProcessCommand` 执行，必须绑定替换后的新 `finalizationId`；notes 持久投影与 cards derived provenance 都要回读到同一来源。否则只会读回恢复前已冻结的旧效果。
2. 恢复类型取自本案唯一的续写 operation，而不是首项（C17-B 的首个 operation 是后处理，取首项会整段跳过恢复；开发合成曾实测复现）。`refinalize` 本身只提交定稿，harness 不重写后处理。
3. `physicalProject.readback.predecessors` 是续写实际纳入的必需前驱；替换后 readback 与 parity 同步改为替换后的来源（替换前原样另存），`parityHash` 仍须等于 readback 的 hash，续写 `materialDecision` 须纳入同一来源与 revision。
4. 登记续写的首个物理请求是唯一一次生成前定稿对账（v5），提示与输出落盘并以 hash 绑定；对账之后的写稿请求出站前先等对账流结算，才能从落盘输出重算注入块。
5. 定稿后处理（notes/cards）的原生 repair 与 C17/C18、post-UI 的唯一压缩同规则：同一 operation 只有末次 attempt 带正式效果，各自独立计数、最多两次。

### 七、夹具边界与证据口径

1. 适配器只替换 Electron 传输，不替换任何命令、运行时或仓库；最后一道 provider fetch 是合成与真实响应的唯一开关。真实账本只读认证，不写任何一行。
2. 每条前驱必须在使用前从生产 IPC 原样读回，命令只消费这些 readback，绝不旁路注入正文；第二章前驱须由本臂自己的库提供，不借另一臂输出；`accepted` 只是实验终点而非定稿章节，每次消费前重读真实行；生成的蓝图与正文因臂而异，只有原始作者输入定义初始 parity。
3. 进程内 harness 没有 Electron dialog、不能走选择器，所以与选择器同一 owner（`externalFileGrants`）为本 sender 直接签发一次性精确授权，恢复 IPC 只收授权标识（生产控制器会拒绝原始路径）。导出目标是尚不存在的子项，归档读取授权要求文件已存在，故须在导出成功之后再签发。
4. 证据缺失或畸形一律 fail closed；内部错误身份可安全暴露，自由文本、路径、供应商载荷、凭据保持脱敏；流事件只记形状与标准终态枚举，绝不记供应商文本、ID 或推理。
5. 评分规则变更（用户批准，c16-c18 v3）：作者值始终由桥断言保全；是否出现冲突候选只在模型正式生效输出确实提议改写 `mentalState` 时才要求，证据须绑定末次正式 attempt 的 hash 可复核产物并由生产解析器解析，不读自由文本；合成模式的 transport 必定提议冲突值，因此仍强制冲突候选。

## 测试口径

- 断言「拒绝」的用例按变异列表逐项构造（改 `attemptId`、改 hash、对调顺序、替换身份等），每项独立红。
- 历史账本的行数、hash 与 invocation 清单是快照，不写进注释；以代码里的登记表为准。
- 重复使用同一参数的 `continuityResults` 只落盘一次、之后给深拷贝（每次重建约 150 ms，会让用例堆积），参数一变就重建，盘上文件始终属于最近一次构建。
- 99 次真实持久化更新需要集成测试时限，该用例验证记账合同，不是性能合同。
