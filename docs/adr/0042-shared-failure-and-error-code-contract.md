# 失败、错误码与作者可读说明的共享契约

2026-11-26，注释清理（#852）第 3 个 PR（src/shared）。

## 背景

`src/shared/failure.ts`、`connection-failure.ts`、`structured-contract-diagnostic.ts` 与 `finalization-step-error.ts` 定义了跨进程的失败形状。它们的注释解释了「为什么异常原文没有槽位」「为什么码只拿去查目录」这类决定，代码本身只看得到类型。

## 决定

失败由稳定的大写下划线码和可选的作者可读说明组成。码只用于查目录与分流，从不直接显示；异常原文没有槽位，只有作者自己的数据（文件名、书名、章节名、模型名）才能经 `AuthorOwned` 插进说明。过 IPC 的失败是纯数据，说明只带目录键与参数。认失败发生在 catch 处，认不出的一律走旧字段。定稿后处理步骤的错误码单独成表，步骤记录里存码本身，展示时再按当前界面语言换成说明，并决定界面摆不摆重试。下面按文件列出各条口径。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/failure-cases.typecheck.ts`

- `legalShapes`：tsc 检查（原文放不进说明）：合法写法编译通过，下面每条反例都必须报错。

### `src/shared/connection-failure.ts`

- `CONNECTION_FAILURE_BY_CODE`：fetch 的 cause.code → 连接失败码，文案在 src/i18n/app-errors.ts。
- `connectionFailureCode`：fetch 只报「fetch failed」，原因在 cause.code；认不出的返回 undefined。

### `src/shared/failure.ts`

- `FailureCode`：类型只挡小写和不带下划线的值，挡不住汉字句子，边界上一律用 failureCode() 判。
- `AuthorOwned`：作者自己的数据（文件名、书名、章节名、模型名），可以插进说明。
- `AuthorNote`：带私有字段，按名义比较，对象字面量和展开出来的对象都不是它；显示时再用 minted() 认一次，挡住 as 硬转。
- `LegacyReason`：还没迁移的主进程通道给的原因：来路不明的文字，按旧规则显示。
- `Recovery`：run-failure.ts 凭它出按钮，不凭码。
- `Failure`：一次失败：码和说明至少有一个。码只拿去查目录和分流，从不直接显示；异常原文没有槽位。
- `WireNote`：过 IPC 的失败是纯数据：类实例过不了结构化克隆，所以说明只带目录键和参数。
- `failureOf`：catch 处认失败。认得出三种：AuthorError；整条 message 就是码；message 为空而 code 或 errorCode 上挂着码。 message 是句子又另挂码（句子可能比码的目录文案具体），或 message 与对象上的码不一致，都认不出，走旧字段。

### `src/shared/ipc-channels.ts`

- `httpFailure`：供应商返回非 2xx 时的状态码与响应正文；error 为 LLM_REQUEST_FAILED，由连接测试按界面语言写进说明（#474）。

### `src/shared/structured-contract-diagnostic.ts`

- `StructuredContractDiagnostic`：对服务商安全的结构化输出失败：只带稳定码与 schema 路径，候选值与解析器消息绝不跨过这个边界（原文：Provider-safe structured output failure. It deliberately carries only a stable code and schema path; candidate values and parser messages never cross this boundary.）
- `structuredContractDiagnosticText`：作者手写的结构化内容（如蓝图恢复稿）不合契约时，给作者看的说明：哪个位置出了什么问题。
- `root`：根路径 `$` 对作者是暗号，说成「整体内容」。

### `test/helpers/legacy-failure-scan.ts`

- `failureTypeAssertions`：只有 src/shared/failure.ts 可以断言成这些类型。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/i18n/__tests__/app-errors.test.ts`

- `raw`：主进程可能已经处理完，只是结果因会话失效被拒；文案只能说结果不可用。
- GENERATION_MODEL_CHANGED 由主进程续跑情节大纲时抛出，GENERATION_IMPORT_MODEL_CHANGED 由导入生成抛出；GENERATION_SOURCE_CHANGED_MODEL 由 #453 抛出。
- 这两个码在保存时的来源复核里也会抛出，那时模型已经回答过。
- 审计点名的四个码与已登记的 GENERATION_SOURCE_CHANGED 走同一条转发路径、同一种作者情境（生成途中依据变了）。
- 名单版本冲突与角色不存在既来自批准角色提议，也来自普通的角色卡保存：说明不能只指向提议（#474 审计）。
- db 读通道原样抛出：Electron 包上通道名，错误类名代替了 "Error"。
- db 写通道返回 { error: String(error) }。
- IPC 之外 reject 的普通对象：有字符串 message 就用它，没有就用兜底，不显示 [object Object]。
- project:create / project:open 的 catch 把 resolveDirectoryPath 抛出的码经 String(error) 原样放进 result.error。
- 可写 db 通道返回 { error: String(error) }。
- kb 通道的结果值：{ success: false, error: 码 }。
- 检索与读取原样抛出：Electron 包上通道名与 "Error: "。
- vector-store 的 catch 曾用 String(error) 交出 "Error: 码"。
- llm-controller 的 catch 用 String(error) 交出 "Error: 码"。
- 执行租约的码由 ModelExecutionLeaseError 抛出，带自己的类名。
- mcp 通道的结果值与工具调用的 String(error)。

### `src/i18n/__tests__/error-catalog-locale-callers.test.ts`

- `MINTS`：报错目录只收 ErrorDisplayLocale，文案语言传进去 tsc 就报错（见 error-display-locale.typecheck.ts）。 类型挡不住的只剩手写断言和借用测试辅助，这里把生产代码里造出这个类型的地方限定为下面几处来源。

### `src/i18n/__tests__/error-display-locale.typecheck.ts`

- `copyLocaleIsRejected`：tsc 检查：文案语言（日文界面下是 en-US）不能拿去查报错目录，放宽成 InterfaceLocale 也不行。

### `src/i18n/__tests__/generation-error-codes.test.ts`

- `COVERED_PREFIXES`：生成 IPC 会把任何 GENERATION_* 码原样转给渲染端，工作流失败面板对未登记的码只能显示原码。 下面这些前缀的码同样会进工作流失败面板：工作流与生成运行时直接抛出，或由工作流调用的主进程服务 （角色提议、定稿角色状态、旧版角色名单、生成记录）经 IPC 转来（#471）。 所以代码里出现的每个码都要二选一：在 app-errors.ts 登记文案，或在这里按理由列为不登记。 角色建议页（待批准的角色提议、定稿角色状态建议）的决策请求同样经生成 IPC 原样转来码，按同一约定登记（#474）。 项目会话与外部文件授权（#474 B4）的码经各控制器的 { error: String(err) } 或 IPC 异常原样到项目页、知识库与工作流： 同样要么登记、要么写明理由。 角色名单、蓝图与剧情资料（#474 B2）的码经 db 通道的 { error: String(err) } 或 IPC 异常到角色页、蓝图与剧情页； CHARACTER_ROSTER_* 还会经生成 IPC 原样转给工作流失败面板（generation-controller 放行 CHARACTER_ 前缀）。 定稿、实体稿、修订、恢复稿、摘要与章节删除（#474 B5）的码经 finalization:*、chapter:* 与 db 通道的 { error } 到定稿运行卡片、 删除提示、修订合并与恢复列表；摘要与角色状态的校验还经生成 IPC，在那里统一成 GENERATION_REQUEST_FAILED。 模型调用、模型设置与执行租约（#474 B6）的码经 llm 通道的 { error } 或 IPC 异常到模型设置与生成运行时； 连接测试的结果由主进程按界面语言写好再交给模型表单。 其余前缀（备份与迁移、安全文件系统、头像与图片、EPUB 导入、外观、编辑器等）不在这里： 它们不经生成 IPC，由各自的主进程控制器或页面按自己的映射说明，逐族审显示面随主进程批次处理。
- 角色身份提交链路（批准角色提议时同一事务内提交）：经生成 IPC 原样转给角色建议页（#474）。
- 项目会话、项目路径守卫，打开、创建、删除项目与外部文件授权（#474 B4）。
- 角色名单、蓝图、剧情树与叙事线索，以及 db-controller 里草稿与导入断点的直接拒绝（#474 B2）。
- 定稿、实体稿、修订、恢复稿、连续性摘要、一致性豁免、后处理与章节删除（#474 B5）。
- 回收站：恢复、彻底删除与列表的拒绝原因（#564）。
- 知识库、项目副本与检索索引（#474 B3）：经 kb 通道的 { error } 或 IPC 异常到知识库页、设置的检索索引检查， 以及导入创作资料、定稿收入知识库与参照导入的工作流。
- 模型调用、模型设置与执行租约（#474 B6）。
- 导入运行、导入回执、全局事实与作者原稿定稿导入、导入来源身份与文件检查（#474 B1）：经 db:import-run-*、 db:import-global-facts-commit、kb:import-reference-text 与 dialog:select-novel-files 到导入对话框、导入运行卡片 与可继续的导入列表。主进程在这些通道的边界按导入运行的语言把码写成说明（electron/controllers/import-run-failure.ts）。
- `postProcessStepRecord`：只写进后处理步骤记录，不作为错误抛出；步骤面板按 finalization-step-error.ts 的说明显示。
- `legacyImportWarning`：副本已建好，只是最近项目写失败：主进程放在 warning 字段，界面不显示。
- `contractViolation`：请求形状、句柄、事务、收据、哈希与谱系的完整性校验：只有我们自己的代码缺陷、被篡改的 IPC 或被外部改坏的作品库才会触发。界面给不出作者能照做的建议，原码留给反馈定位。
- #471 扩到的前缀：生成运行时与主进程生成记录的句柄、租约、快照和收据校验， 角色提议与定稿角色状态的事务与来源证明，旧版角色名单的身份与采用收据。
- #474 扩到的前缀：角色身份提交的请求形状、事务、批准收据与回读校验。
- #474 B4：项目路径与回滚快照的内部校验、删除目标与当前会话的一致性、只读字段写入与旧库迁移的完整性。 界面只从项目页对当前项目发起这些请求，作者照常操作碰不到；碰到说明代码缺陷或项目文件夹被外部改坏。
- #474 B2：名单与蓝图提交的请求形状、幂等回执、冻结输入、回读与库内事实的校验，草稿生成请求与目标字数的参数校验， 导入断点阶段的通道参数。界面按自己的流程构造这些请求，作者照常操作碰不到；碰到说明代码缺陷或作品库被外部改坏。
- #474 B5：删除请求与冻结删除收据、待删章节与定稿收据的一致性。界面只对列表里已定稿的这一章发起删除。
- #564 M07：drafts 删除三列与 deleted 状态不同进退时触发器拒写。只有删除事务写这三列，碰到说明代码缺陷。
- #474 B5：定稿快照的形状、会话与哈希，定稿收据与发布记录、导出快照的一致性，实体稿目标路径的边界。 界面从冻结的编辑器快照与库内收据构造这些请求；碰到说明代码缺陷或作品库、正文文件夹被外部改坏。
- #474 B5：修订稿与目标草稿的从属关系、审稿修订只能走原子合并入口。界面只合并这一稿自己的修订稿。
- #474 B5：恢复稿的请求身份、库内哈希与替代关系，一致性豁免的事实键，草稿定稿只能走原子定稿提交， 后处理运行必须绑定定稿收据。界面从运行记录与库内事实构造这些请求。
- #474 B5：连续性事实与读取请求的形状、失效章节号、定稿来源草稿号。蓝图与导入提交、读前文时由界面或主进程自己构造。
- 知识库与检索索引（#474 B3）：重建计划与执行之间的内部约定、新代际写入后的完整性复核。 updateChunkVectors 只有测试调用。
- `modelOutputContract`：模型输出不合角色提议的结构契约（#471）。工作流里由结构化重试或调用处的按语言说明接住。 定稿角色状态的同类码已在 app-errors.ts 登记（#552）。
- `recoverySequencing`：恢复与续跑的顺序约束：界面只从恢复列表或当前运行发起这些请求，按记录状态给出可用操作； 只有绕过界面直接调用才会撞上。
- 后处理步骤收据只由这次定稿后处理自己的运行写入；步骤已被新的后处理运行替换时才会撞上（#474 B5）。
- #471 扩到的前缀：目录续跑只从进度列表里未完成的一项发起；旧版名单恢复面板按记录状态给出可用操作； 采用角色前必须先看过提议预览；素材裁决未就绪时不会发起写稿。
- 模型返回的叙事线索候选不合结构（#474 B2）。
- #474 B1：导入运行的请求形状、来源身份与指纹、冻结章节快照、批次与阶段检查点、执行租约以外的状态转换、 效果收据与谱系，全局事实与作者原稿定稿导入的幂等收据，导入来源身份与文件检查数据。界面从冻结的运行记录、 检查令牌与库内收据构造这些请求；碰到说明代码缺陷或作品库被外部改坏。导入通道的边界给出带码的通用说明。
- `handledElsewhere`：不经工作流失败面板：界面自己识别并给出专门提示、主进程内部捕获，或只在启动装配与关闭收尾时抛出。
- 定稿连续性摘要与角色状态候选只经定稿生成 IPC 提交（#474 B5）：generation-controller 不放行 CONTINUITY_ 前缀， 记下诊断日志后统一成 GENERATION_REQUEST_FAILED；原码只进日志。
- 主进程中止请求时用的 AbortSignal.reason，只用来给调用记录分类，不会作为报错交给界面。
- 错误本身带按界面语言写好的说明，码只供调用方分流：素材容量冲突、目录部分提交与范围过大。
- 启动时外观设置与主进程握手，失败只影响主题初始化，不进任何失败面板。
- 外部文件授权的路径、范围、窗口与签发参数校验（#474 B4）：external-file-grant-controller 按码换成按界面语言的说明， 归档、知识库、云备份与旧项目导入各自折叠成不含路径的码或说明，不原样交给界面。 新建、打开项目经 String(error) 原样转出：作者能遇到的 TARGET_CHANGED 已登记；其余只有窗口或调用参数不对才会出现。
- 剧情页对读取、清除剧情树与线索的增删改按固定的按语言说明提示，不显示主进程原文（#474 B2）； AI 生成的线索与剧情树经生成确认保存，这些码在那里统一成 GENERATION_REQUEST_FAILED。
- 模型执行租约失效或过期（#474 B6）：渲染端生成运行时把租约通道的失败统一成 LEASE_* 码， 主进程生成经生成 IPC 统一成 GENERATION_REQUEST_FAILED，这两个码只进日志。
- 模型供应商的请求与响应流失败（#474 B6）：流式失败只进调用记录，主进程生成按码分成网络失败、 上下文超长（GENERATION_CONTEXT_LENGTH_EXCEEDED）或 GENERATION_PROVIDER_FAILED，渲染端生成运行时统一成租约请求失败； 非流式失败只有连接测试显示，由 llm-controller 带上 HTTP 状态与供应商返回按界面语言写成说明。
- MCP 连接前的配置与传输检查（#474 B6）：connect 与 mcp:connect 通道把它们统一成 MCP_CONNECT_FAILED。
- 选择导入文件时的数量、大小与章节上限，以及启动时的导入资源上限配置（#474 B1）：import-controller 的 importSelectionErrorMessage 按上限写成说明（读不出文件大小时说明为无法读取所选文件、请重新选择）； 资源上限只在注册导入通道时校验，失败只让启动失败。
- 批注审阅面板就地接住并换成自己的说明，原码不进失败面板（#653）。

### `src/services/agent/tools/project-context.ts`

- `agentToolErrorDetail`：工具失败的原因：主进程登记过的码按作品写作语言说明（工具结果同时显示给作者、回给模型）， 其余去掉通道前缀后原样保留；原因是 undefined、null 或空白字符串时返回 undefined，由工具用自己的兜底说明 （没有可读 message 的对象会得到「未知错误」）。

### `src/services/generation/generation-harness.ts`

- `TerminalProviderFailureError`：现行规则：错误的 message 就是登记过的码，各个失败视图都能解释它，回执留下已派发调用的记录（原文：Its message is the registered code, so every failure view can explain it; the receipt keeps the dispatched call on record.）

### `src/stores/__tests__/llm-settings-errors-locale.test.ts`

- llm-controller 的 catch 用 String(error) 交出 "Error: 码"。

### `src/stores/__tests__/project-access-errors-locale.test.ts`

- `refusal`：主进程打开或创建被拒时的回包：数据库仍在原处，报错是 String(err) 形式的错误码。

### `src/stores/__tests__/project-close-lifecycle.test.ts`

- #702：打开失败、原来开着的书也没能恢复时，主进程只回首个原因的登记码。
- #702：主进程只回登记码，书名由渲染端从书架上取。
- #702：文件夹没删完但库文件还在、原来的书恢复回来了，作品仍开着，可以再删一次。

### `src/stores/draft-store.ts`

- 交出 message 而不是 String(e)：再套一层「Error: 」会盖住 Electron 的通道前缀，显示处就认不出主进程的错误码。

### `src/stores/mcp-store.ts`

- `mcpErrorText`：主进程转来的 MCP 失败原因：登记过的码按界面语言说明，其余原样保留，没有原因时用兜底。

### `src/stores/project-store.ts`

- 主进程已按界面语言写好清理未完成的说明（带原始文件系统错误），不再套「发生错误」。

### `src/stores/workflow-store.ts`

- `failure`：只有 caughtFailure 把认不出的原文记进控制台；message 非空时原文已在旧字段，不重复记。
- `reason`：普通步骤失败交原错误，带 code 的按码说明；预算失败已写好说明。

## 过 IPC 的失败形状（#844 PR-B）

- 失败结果另带 `failure`：码加可选的目录键说明。迁移期旧 `error`、`errorCode` 照旧写，值与以前相同。
- 目录键只有 `wireNote()` 造得出（`WireNoteKey` 是品牌类型），手写的句子放不进来。`error.unknown` 整句只装原文，排除在外。
- 主进程出口 `publicIpcResult` 和渲染端入口 `receivedIpcResult` 各校验一次：码没登记换成 `IPC_HANDLER_FAILED`，说明不合格只留码。db:* 等直连通道不经 `handle()`，渲染端入口是它们唯一的校验。
- 渲染端读失败走 `resultFailure`：先 `failure`，再旧字段里的码。旧 `error` 里不是码的文字不显示，只进日志。
- 导入运行的失败只在码已登记时带 `failure`。没登记的码由渲染端照旧读 `errorCode`，参照导入的取消判定只凭这个码。
