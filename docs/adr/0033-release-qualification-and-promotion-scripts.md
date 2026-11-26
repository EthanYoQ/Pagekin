# 发布资格与升级验证脚本的约定

2026-11-26，注释清理（#852）第 1 个 PR（scripts 与 .github）。

## 背景

发布链上的脚本（`scripts/release-*.mjs`、`verify-github-update-release.mjs`、`windows-in-app-update-e2e*`、`real-provider-generation-qualification.mjs`、`smoke-*`、`windows-test-failure-metadata.ps1`、`canonical-pnpm-lockfile-hash.mjs`、`build-windows-safe-file-system.mjs`）及其测试，和 `cross-platform-runtime-artifact-promotion.yml` 工作流里，散落着解释「为什么这样验证」的注释。本 ADR 收拢这些决定，源码注释随之删除。Windows 发布闸的进程监控另见 ADR-0039，产品改名带来的新旧名并存见 ADR-0022。

## 决定

### 一、晋升与哈希

1. 晋升引擎整份取自 github-desktop-release 技能（`github-desktop-promotion.mjs`、`validate-release-profile.mjs` 逐字复制到 `.release/scripts/`，文件名不变），不自写项目专属晋升引擎；项目只提供发布档案和资格验收适配器。工作流里固定的验证器运行时不是应用工具链。
2. pnpm lockfile 哈希只规范行尾：Windows 资格作业与 Linux 晋升作业可能以不同工作区行尾检出同一个 Git blob，规范化只动行尾字节、其余逐字保留，所以不会掩盖依赖或 lockfile 内容的变化。
3. Windows 安全文件 helper 用 .NET Framework 4.x 编译器构建，它随每个受支持的 Windows 出厂，构建不需要 SDK。

### 二、发布后校验

1. 上传后校验公开的 GitHub Release：小文件 `latest.yml` 逐字节核对；安装包、元数据与 blockmap 靠 GitHub 的 SHA-256 资产摘要与本地已验证的构建核对。
2. 无策略修订号的发布证据收据保留其历史的原地含义；测试里的历史包是就地合成的，真实归档收据保持不可变。
3. Windows 发布验证里监控器最多花 5 秒排空存活进程，再要求 5 秒静默，超时设置据此留余量；`.NET` ticks 超过 `Number.MAX_SAFE_INTEGER`，须以文本保留精确身份。

### 三、真实供应商资格（real-provider-generation-qualification）

1. 安全准备用 `--dry-run`；计费执行另要求精确的进程内确认环境值，Gemini key 只来自父环境或剪贴板，凭据从不作为命令行值接受，脚本从不把证据写盘。
2. 三个执行档案是冻结的内存档案，从不序列化，收据只露固定模型标签与哈希身份。从 OpenAI 兼容表单创建的既有应用档案会以 `custom` 保存，即便指向 xAI 的官方端点；资格可以把它当内存里的密钥来源，但冻结的执行身份仍须是规范 xAI。
3. 预检账本先于产品运行时加载；每次物理补全在其 delegate 调用 fetch 之前先预留 campaign 与供应商额度。提示的 UTF-8 字节数是保守的硬输入 token 估计（一个 UTF-8 token 不会少于一个字节）；美元数只是基于快照的可选估算，永远不参与授权，估价取高峰价（缓存未命中），只会高估。
4. 档案顺序运行，使安全预算对每个供应商独立执行、可审计；函数从不持久化档案、提示、生成正文、端点或凭据。过滤 `GIT_CONFIG` 的 KEY/VALUE 对后不留悬空的 `GIT_CONFIG_COUNT`，命令显式提供唯一需要的 `safe.directory` 规则。

### 四、Windows 应用内更新 E2E（windows-in-app-update-e2e）

1. 发布源刻意不可由工作流输入或 CLI 参数配置：只抓固定的官方仓库，校验正式 Release 及其摘要认证的更新资产，持久化无密钥的计划；`fetcher` 仅为单元测试可注入；公开 CLI 接缝上不存在仓库、URL、安装包或版本源的覆盖。输入只能指向最终发布：只规范可选的历史 `v` 前缀，不接受 ref、URL、预发布或构建元数据。
2. v0.5/v0.6 的升级器调用 `quitAndInstall(false, false)`，会启动辅助 NSIS 向导，所以存在仅测试用的桥；它在 v0.7.0 作为源后刻意不可用——v0.7.0 自带原生静默调用，必须不借助 harness 替代就证明该行为。桥所需的安装元数据全部取自摘要认证的发布计划，调用方不能选别的仓库、资产或待装路径。
3. 每个子进程（含被测的已安装应用）拿到的环境都不含工作流令牌：应用像真实用户一样匿名检查更新，看不到认证本脚本 API 请求的令牌。
4. 冷启动的 GitHub Windows runner 编译监视器的原生 Job Object 辅助程序约需 15 秒才能发布 `ready`，超时据此留足。Node 启动器在放行 PowerShell 进程之前先启动 `monitor-win-release-gate.ps1`，保持其 fail closed 的 NSIS 辅助分类；复用现有安装/错误窗口监视器，`/S` 加最终 `/D` 的形式是现有 NSIS 静默安装契约，这里不新增放宽的辅助例外。
5. 驱动里点的是触达 `UpdateService.requestInstall` 与 Electron 真实 `autoUpdater.quitAndInstall` 的渲染端动作，不走测试 IPC 捷径。
6. `from_tag` 与 `expected_tag` 可能跨越产品改名（ADR-0022），两个产品名都要追踪；更新可能改名，更新后的可执行文件须在安装器退出后才解析。
7. 失败元数据只读投影：绝不打印 `Event.Message`、XML、路径或转储；访问被拒、日志不可用、无事件不算测试失败，异常文本可含机器路径，只发固定分类。

### 五、测试时限的依据（实测）

- 构建机负载下，f05 旅程脚本在复制作者源时空闲约 0.8 秒、负载下实测到 7.2 秒（#428），旧版只等一个子进程，所以验收契约测试的等待要放宽。
- WinForms 作业的第一个子窗口在 CI 上曾需约 4.8 秒，5 秒界限失败；20 秒约为其 4 倍，加上 5 秒关闭超时仍在集成预算内。
- `execFileSync` 会阻塞事件循环，它自带的超时必须先于 Vitest 用例超时结束卡住的探针。
- smoke 测试里预期的 `EEXIST`（复用 scratch 的用例）会污染 CI 日志，故抑制 stderr；失败的调用仍在错误消息里带 stderr。

### 六、规范业务 API 的边界

独立的旧夹具在显式规范化前后仍验证原生查询，但普通规范业务 API 必须拒绝这类未限定的旧根，而不是授予迁移权限；规范搜索与注册表读取保持同一未限定项目的边界。

### 七、release-win-verify 测试约定

- 清理路径测试须先证明生产式清理保留了未解析的控制根，再删除没有进程的夹具。
- 归因错误的失败，或被「结果所有者豁免」放行的链成员，都意味着分类器丢了链。
- 消费者可能在写 `EXIT` 之前停止：缺 `EXIT` 保持不可观测，任何可用的 `EXIT` 都不得捏造已捕获的结果。
