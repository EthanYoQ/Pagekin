# 仓库守卫与产物检查脚本的约定

2026-11-26，注释清理（#852）第 1 个 PR（scripts）。

## 背景

`scripts/check-test-determinism.mjs`、`product-identity.mjs`、`pr-docs-only.mjs`、`vitest-worker-diagnostics.cjs`、`smoke-win-app.ps1` 与 `smoke-win-installer.ps1` 的产品名部分，以及相关测试里，有若干解释「守卫为什么这样判」的注释。本 ADR 收拢这些决定。

## 决定

### 一、测试确定性守卫

1. 守卫拦两类只在 CI 慢机上才会红的写法（#620、#818）：墙钟差值与固定上限比较；`fs.watch` 回调声明文件名参数（macOS 上可能为 null）。
2. **只拦新增。** 现有命中记在 `test-determinism-baseline.json`，按「文件 + 规则 + 命中文本」计数，不看行号，改动无关行不会让基线失效。
3. 声明按名字就近查找，因为长测试文件里不同用例常复用 `started`、`elapsed` 这类名字。
4. 入口路径要先解析符号链接与 junction 再与 `import.meta.url` 比较，否则经链接运行时什么都不扫就退出 0。

### 二、产品名与可执行文件

1. 安装包产品名决定 exe、`.app` 与卸载程序的文件名。1.3.0 及以前叫「AI小说作家」，之后改为「书童」（ADR-0022）；升级测试会启动旧版本，所以凡是可能碰到旧版本的地方两个名字都认：窗口标题（书童 Pagekin 与旧标题）、卸载程序名、安装目录下的 exe。新名优先，都不存在时返回新名路径，由调用方报缺失。
2. 名单在 `product-identity.mjs` 与 PowerShell 脚本里各有一份（`smoke-win-app.ps1`），改一处要一并改另一处；`package-win-zip.ps1` 的产品名与 exe 名统一取自 `smoke-win-app.ps1` 的库函数；默认 exe 名取自共享名单的第一个，名单与 `productName` 一致由 `product-identity.test.ts` 保证。
3. 验收脚本选 exe 时 `freshBuild` 表示随后会在本进程里重新打包：目录里现有文件会被清掉，产物一定是当前产品名，不能按构建前的文件去找（同版本号下可能还留着改名前的构建）。macOS 的可执行文件与 `.app` 同名。
4. 烟测安装器里最终目标路径上限须与 `project-storage-preflight.ts` 对齐，由契约测试覆盖。

### 三、PR 文档判定

`pr-docs-only.mjs` 的规则与 GitHub `paths` 过滤同语义：后面的规则覆盖前面的。代理指令目录会让代理执行命令，按代码对待，不算纯文档。

### 四、Vitest worker 诊断 reporter

只读元数据 reporter，与默认 reporter 并行加在 CI 里。它永不改变 worker 参数、返回值、错误、重试策略或超时；只观察 Vitest 的 fork worker，不检查任意测试子进程；诊断输出失败时不得改变测试结果，原始 `send` 的返回值与错误语义原样保留。fork 观察器用 Node 的 live builtin 导出，使 CLI 先于 reporter 初始化加载的情况下 Vitest 的 ESM fork 导入也能看到它。

### 五、测试约定

- `.node-test` 后缀用来避开 Vitest 的自动发现，须显式 `node --test` 运行。
- 图标测试要求四角透明：满版帧的图形铺满画布，上面的留白检查发现不了背景不透明；图标是圆角方块，四角按设计透明。

## 测试与实现注记

以下是注释清理（M30）时从脚本、测试与工作流里迁入的注释，按文件归并。

### __tests__/product-identity.test.ts

- 同一版本号下 win-unpacked 里还留着改名前的构建：本次构建会清掉它、产出新名 exe。
- 复用已有产物时，仍按实际存在的文件找。

### build-windows-safe-file-system.mjs

- vitest globalSetup 的入口，同时是无参数直接运行本脚本时的默认动作。

### check-color-literals.mjs

- 去掉注释但保留换行，使行号不变。字符串里的 // 与 /* 不算注释（单双引号字符串不跨行，模板字符串可以）； CSS 没有行注释，url(//…) 照常扫描。
