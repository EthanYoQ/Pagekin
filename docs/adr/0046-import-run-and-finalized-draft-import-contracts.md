# 导入运行与定稿草稿导入的共享契约

2026-11-26，注释清理（#852）第 3 个 PR（src/shared）。

## 背景

`import-run.ts`、`import-generation.ts`、`import-global-facts.ts`、`import-fill-empty.ts`、`finalized-draft-import.ts` 定义导入运行的阶段、冻结的来源快照与收据。注释记录了哪些字段只在主进程、哪些对渲染端安全。

## 决定

导入运行的来源清单、授权与身份只留在主进程；渲染端拿到的是有界、安全的显示视图。作者原稿导入要把确认绑到被检查的章节清单与权威指纹，并在提交事务里复核。反推全局事实分整体写入与只补空白两种模式。下面按文件列出各条口径。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/finalized-draft-import.ts`

- `expectedAuthorityFingerprint`：作者原稿预览时冻结，提交事务里复核（原文：Frozen during author-manuscript preview and rechecked in the commit transaction.）
- `expectedManifestFingerprint`：把确认绑定到被检查的那份章节清单（原文：Binds confirmation to the exact inspected chapter manifest.）
- `expectedCommitManifestFingerprint`：把收据绑定到本次操作写入的恰好那批新增章节（原文：Binds the receipt to the exact new-only chapter subset written by this operation.）

### `src/shared/import-fill-empty.ts`

- `ImportFillField`：作者原稿反推只补空白：每个可补字段按类型判空，非空且与反推值不同的进建议。
- `FILL_RULES`：suggest=false：导入章数不是作者计划的总章数，只在项目没有总章数时补上，不当作建议。

### `src/shared/import-generation.ts`

- `IMPORT_SLOT_MAX_REQUESTS`：一个导入 slot 最多发出的请求数（含推演、语法修复和补卡）。主进程按请求序号核对，根的额度更大也不能超过。
- `ImportGenerationSlot`：持久的导入检查点，绝非渲染端选定的生成根（原文：A durable import checkpoint, never a renderer-selected generation root.）

### `src/shared/import-global-facts.ts`

- `ImportGlobalFactsMode`：replace：参考小说整体写入；fill-empty：作者原稿只补空白，非空字段的反推值进 suggestions。

### `src/shared/import-run.ts`

- `IMPORT_STAGE_PLANS`：阶段顺序由运行用途和冻结的反推选项决定；作者原稿的反推放在后处理之后，知识库里已经有定稿正文。
- 蓝图分批、持久收据与仓库检查点共用的规范身份（原文：Canonical identity shared by blueprint batching, durable receipts, and repository checkpoints.）
- 存储提交前与渲染端重放共用的绑定检查（原文：Common binding checks used before storage commit and renderer replay.）
- `ImportSourceDisplayMetadata`：仅作显示的来源事实，路径、授权、凭据与服务商数据一律禁止（原文：Display-only source facts. Paths, grants, credentials, and provider data are forbidden.）
- `ImportSourceFileIdentity`：外部文件授权签发时捕获的别名，仅主进程用（原文：Main-process-only aliases captured while the external file grant is issued.）
- `sourceIndex`：主进程来源列表的下标，绝不由渲染端输入（原文：Index into the main-process source list; never supplied by renderer input.）
- `sourceChapterNumber`：单个来源内稳定的章归属（原文：Stable chapter affiliation within one source.）
- `content`：项目自有的冻结快照，外部授权有意不持久化（原文：Project-owned frozen snapshot; external grants are deliberately not persisted.）
- `ImportRunChapterSnapshot`：对渲染端安全的冻结章节快照，来源归属仍仅主进程（原文：Renderer-safe frozen chapter snapshot; source affiliations remain main-process-only.）
- `sourceIds`：与 sourceDisplay 对齐的每来源不透明 ID，仅主进程（原文：Opaque per-source IDs aligned with sourceDisplay. Main-process only.）
- `sourceFingerprints`：与 sourceIds 对齐的旧单来源集合指纹，仅主进程（原文：Legacy single-source collection fingerprints aligned with sourceIds. Main-process only.）
- `authorityFingerprint`：作者原稿必填，从只读项目预览冻结（原文：Required for author manuscripts; frozen from a read-only project preview.）
- `expectedManifestFingerprint`：作者原稿必填，把确认绑定到被检查的章节清单（原文：Required for author manuscripts; binds confirmation to the inspected chapter manifest.）
- `authorInference`：作者原稿：「同时反推设定、架构、角色和蓝图」，创建运行时冻结。
- `ImportChapterTargetStatus`：对渲染端安全的检查元数据，章节正文与来源身份留在主进程内存（原文：Renderer-safe inspection metadata. Chapter content and source identities stay in main memory.）
- `targetStatus`：持久项目账本给目标章分过类之后才有（原文：Present once the durable project ledger has classified the target chapter.）
- `previewRemaining`：有界持久预览才有，旧的内存检查可省略（原文：Present for bounded durable previews; legacy in-memory inspections may omit it.）
- `authorInference`：「同时反推设定、架构、角色和蓝图」，创建运行时冻结。
- `ImportNovelFileSelectionRequest`：当前项目选择把解析绑到一个冻结的项目租约，早于读任何来源（原文：Current-project selection binds parsing to one frozen project lease before any source is read.）
- `manifestFingerprint`：作者原稿快照只暴露恢复其已确认提交所需的哈希（原文：Author-manuscript snapshots expose only the hashes needed to resume their confirmed commit.）
- `authorInference`：作者原稿：创建运行时冻结的「同时反推设定、架构、角色和蓝图」。
- `unfinishedSourceDisplay`：仍需用户重新授权的来源的安全显示事实（原文：Safe display facts for sources that still need user reauthorization.）
- `inspection`：由主进程冻结清单派生的、有界且渲染端安全的视图（原文：Bounded renderer-safe view derived from the main-process frozen manifest.）
