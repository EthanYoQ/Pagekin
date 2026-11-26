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
