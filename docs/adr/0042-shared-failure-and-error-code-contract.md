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
