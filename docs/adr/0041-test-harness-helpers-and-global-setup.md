# 测试辅助与全局 setup 的约定

2026-11-26，注释清理（#852）第 2 个 PR（test/）。

## 背景

`test/` 下的 setup 文件和通用辅助函数里，原有若干解释「这个辅助为什么这样做」的注释。具体到某个产品子系统的夹具注释，已并入该子系统的 ADR（0002、0013、0015、0020、0025、0031、0035 的「测试口径」）。本 ADR 收拢与具体子系统无关的部分。

## 决定

### 一、临时目录树的删除

- `removeTemporaryTree(target, parent)` 只删测试自己建的临时目录树。目标的真实路径必须严格位于 parent 的真实路径之下，否则拒绝删除。
- 先摘掉树里的符号链接与 junction，再递归删除。原因：用 Electron 作 Node 跑测试时，Electron 41 的 `fs.rmSync` 会跟进 junction 删掉链接目标，曾删光工作树的 `electron/` 与部分 `node_modules`（#449）。
- 它的测试（`test/helpers/__tests__/remove-temporary-tree.test.mjs`）模拟 r3-native 夹具：临时目录里有一个 junction，指向临时目录外、仍要保留的目录。删除后目录外的内容必须还在。

### 二、worker 的测试构建

- `portable-export-worker.ts` 把 worker 打成测试能跑的 ESM。输出放在仓库里，worker 里的 `createRequire` 才找得到 `better-sqlite3`。
- `electron` 保持外部依赖，测试走的是生产 worker 里的同一个空模块钩子，不另造一套替身。

### 三、全局 setup

- `setup-buffer-equality.ts`：Vitest 的通用相等对 Buffer 逐字节走迭代路径，约 5 ms 每 KB。先后快照项目数据库的测试，会在一条断言里花掉几秒。字节相等结论相同，改用原生比较。
- `setup-locale.ts`：渲染测试默认断言中文优先的产品文案。每个用例前把 locale 重置为 `zh-CN`，使测试基线不随运行机器的操作系统语言变化。
- `setup-paper-ink.ts`、`setup-stage-styles.ts`：与应用入口 `src/main.tsx` 一致，纸墨样式和新外壳样式在浏览器测试里各全局加载一次；原语组件和外壳组件本身不引入样式。

### 四、源码契约测试读源码

- 源码契约测试有意忽略检出的换行：同一份已跟踪源码在 Windows 上可能检出为 LF 或 CRLF。`normalizeSourceEol` 把 CRLF 和孤立 CR 规整为 LF。
- `readNormalizedSource` 读源码走与契约断言、内容哈希同一道换行规整边界，所以断言和哈希在两种检出方式下得到同一个结果。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/agent-response-protocol.test.ts`

- 断言前提：历史上 null 或缺失的 arguments 表示无参数，不是原始值载荷，用例里的 value 取值看不出这条规则（原文：Historical null/missing arguments mean no arguments, not a primitive payload.）

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/__tests__/app-workflow-complete.test.ts`

- `notify`：测试口径：取 App 里真实的事件处理函数在新上下文里执行，而不挂载无关面板，函数体只见取文本与执行（原文：Execute the actual App event handler without mounting unrelated application panels.）

### `src/services/__tests__/legacy-roster-generation.test.ts`

- 测试口径：先打开一个已知句柄，再让下一次读取处于取消竞争，步骤顺序看不出这层用意（原文：Open a known handle before enabling the cancellation race on the next read.）

### `src/services/__tests__/prompt-local-qwen-contract.test.ts`

- `filled`：有内容的段落及其标题原样保留；只清掉其中的空条目。

### `src/services/__tests__/safe-call-diagnostic.test.ts`

- `requestBody`：变异意图：诱饵字段证明格式化器不会序列化任意输入字段（原文：Lures prove the formatter never serializes arbitrary input fields.）

### `src/services/agent/__tests__/agent-generation.fixture.ts`

- `AgentHostFixture`：夹具边界：合成的主进程传输只供消费方测试，不证明准入、来源校验、持久计账或真实供应商（原文：Synthetic main transport for consumer tests. It does not prove SQLite admission, main source validation, durable accounting, or real providers.）

### `src/services/agent/tools/__tests__/issue-90-agent-project-actions.repro.test.ts`

- `issuedActions`：夹具边界：这个启动器测试用合成的主进程签发动作，真实来源与动作准入由主进程 SQLite 测试覆盖，启动器、守卫、工作流注册、语言与取消保持真实（原文：This launcher test supplies a synthetic main-issued action. Real source and action admission are covered by the main SQLite tests; the launcher, guards, workflow registration, locale and cancellation below remain real.）
- 测试口径：启动器接缝测试观察期间保持真实工作流处于注册状态（原文：Keep the real workflow registered while this launcher-seam test observes it.）

### `src/services/generation/__tests__/context-length-failure.test.ts`

- `result`：工作流会话替执行器补上调用编号；这里直接接主进程运行时，同样补一个。

### `src/stores/__tests__/appearance-bootstrap.browser.tsx`

- `dependencies`：夹具边界：真实的 Chromium localStorage 与 DOM，只用确定性的主进程传输契约夹具（原文：Real Chromium localStorage/DOM, deterministic main transport contract fixtures only.）

### `src/stores/__tests__/project-opening-notice.test.ts`

- `answerOpenAfter`：主进程拒绝打开：这里只看等待提示，回包内容无关。

### `src/stores/__tests__/theme-store.test.ts`

- `waitForMainReady`：夹具边界：确定性的主进程握手夹具，不断言真实桌面启动资格（原文：Deterministic main handshake fixture; does not assert real desktop startup qualification.）

### `src/stores/__tests__/workflow-store-generation-budget.test.ts`

- 工作流夹具显式提供桌面桥接；未知调用仍拒绝，避免掩盖真实 IPC 缺失。

### `src/stores/__tests__/workflow-store-resource-conflict.test.ts`

- 工作流夹具显式提供桌面桥接；未知调用仍拒绝，避免掩盖真实 IPC 缺失。

### `src/stores/navigation/__tests__/chapter-phase.test.ts`

- `hold`：下一次读修稿列表先按当时的记录取好，等它放行才返回。
- `phaseOf`：按数据库里的记录读出这一稿的 facts，再按稿状态判断它走到哪一步，与流程脊、单章视图同一条路径。
