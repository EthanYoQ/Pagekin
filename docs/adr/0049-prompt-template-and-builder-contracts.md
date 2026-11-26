# 提示词模板、目录与 Builder 的契约

2026-11-27，注释清理（#852）第 4 个 PR（src 其余，不含 shared、components、services/workflows）。

## 背景

`src/services/builtin-prompt-templates.ts`、`prompt-catalog.ts`、`prompt-templates.ts`、`prompt-language.ts` 与 `prompts/prompt-builder.ts` 决定作者看到和模型收到的提示词如何解析、覆盖与拼装。注释里写着哪些部分作者能编辑、哪些永远由内置模板追加，代码只剩字段名与调用顺序。

## 决定

提示词有三级来源，当前会话项目级大于全局级大于内置，水合与持久修改都归提示词目录这一个所有者，调用方不需要知道它来自磁盘、缓存、项目租约还是内置。作者只能编辑任务指导，不可编辑的系统约束（输出格式、JSON schema）始终从内置模板追加在正文末尾，自定义正文删掉占位符后权威上下文变量也必须由 Builder 补上。可选变量为空时留下的标签与空段落整段裁掉，作者确实填写的内容保留。面向模型的内置提示词只由项目写作语言选择，不由界面语言选择，前向写作用到的模板键每一个都必须有英文覆盖。下面按文件列出各条口径。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/builtin-prompt-templates.ts`

- `content`：模板内容（支持 {{变量}} 插值）
- `systemSuffix`：不可编辑的系统约束（输出格式、JSON schema 等），渲染时自动追加到 content 末尾
- `systemRole`：LLM system message 角色定位（由模板统一定义，command 不再硬编码）
- `taskGuidance`：用户可编辑的补充创作指导；不可替换内置任务与输出合同。
- `requiredContextVariables`：自定义正文即使删掉占位符，也必须由 Builder 追加的权威上下文变量。
- `EDITABLE_PROMPT_KEYS`：允许用户自定义编辑的模板 Key 列表（其余为系统模板，不可编辑）
- `PROMPT_VARIABLE_DESCRIPTIONS_EN`：Prompt 正文保持原始创作语言；这里只维护设置页会显示的变量说明。 以变量名集中索引，便于自动检查所有可编辑模板是否都有英文 UI 文案。
- `composePromptSystemRole`：现行规则：不可变的系统约束追加在可编辑的创作角色之后（原文：Immutable system contract appended after the editable creative role.）
- `OPTIONAL_PROMPT_SECTION_HEADING_PATTERN`：章节草稿中由运行时按需填充的上下文段：标题可带同行说明，正文可能只剩“- 标签：”空条目。 整段为空时连同标题一起删除，避免模型看到空段或引用不存在的内容。
- `pruneEmptyOptionalPromptSections`：清理可选变量为空时留下的提示词标签。 只删除“标签后立即是空行或文本末尾”的可选标签；如果作者确实填写了指导内容，标签与内容会保留。 可选上下文段的正文若只剩空的“- 标签：”条目，同样视为空段删除。
- `getBuiltinPromptTemplate`：现行规则：只有面向模型的内置模板才按项目写作语言解析（原文：Resolve only model-facing built-ins through the project's writing language.）

### `src/services/prompt-catalog.ts`

- `PromptPersistence`：现行规则：持久化是真正的接缝，生产用 Electron IPC，测试用内存替身（原文：Persistence is the real seam: Electron IPC in production, an in-memory fake in tests.）
- `PromptCatalog`：现行规则：提示词的水合、优先级与持久修改归它所有，调用方不需要知道它来自磁盘、缓存、项目租约还是内置（原文：Owns prompt hydration, precedence and durable mutation. Callers never need to know whether a prompt came from disk, cache, a project lease or a built-in.）

### `src/services/prompt-language.ts`

- `CORE_LOCALIZED_BUILTIN_PROMPT_KEYS`：现行规则：前向写作生命周期用到的内置模板，列表里每个键都必须提供英文覆盖，命令不能让英文项目悄悄退回历史中文模板（原文：Built-in templates used by the forward-writing lifecycle. Every key in this list must provide an English overlay; commands may not silently fall back to the historical Chinese template for an English project.）

### `src/services/prompt-templates.ts`

- `promptCatalog`：提示词生命周期唯一所有者；工作流通过 async resolve 自动完成水合。
- `getPromptTemplate`：根据 key 获取 Prompt 模板（三级优先级：当前 session 项目级 > 全局级 > 内置）
- `resolvePromptTemplate`：工作流读取入口：首次调用会自动等待全局与当前项目覆盖水合。

### `src/services/prompts/prompt-builder.ts`

- `BasePromptBuilder`：基础抽象 Prompt 建造者 用于安全地拼装 LLM 生成所需的不可变上下文片段，避免漏传变量。
- `safeValue`：使用 replaceAll 避免正则注入风险，安全替换所有匹配项
- `builtinTemplate`：自动追加 systemSuffix（始终从内置模板获取，与 renderPrompt 行为对齐）
- 空变量段落裁剪：与 renderPrompt 保持同一套规则。
- `ChapterPromptBuilder`：章节生成专用 Builder 提供全链条上下文强类型注入，拒绝 raw Record<string,string> 的 "盲打模式"

### `src/services/style-presets.ts`

- `applyPreset`：应用预设到当前配置（只注入 globalGuidance，不覆盖其他元数据）

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/settings/PromptSettings.tsx`

- 用户层只追加创作指导；内置任务与输出合同保持隐藏且不可改。
