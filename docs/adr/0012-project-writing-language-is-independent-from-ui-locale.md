# 项目写作语言独立于界面语言

界面语言只控制应用文案，项目写作语言控制该项目后续 AI 内置创作指令；首期仅支持 `zh-CN` 与 `en-US`。旧项目缺少该字段时保持中文，新项目只在创建时以当时的界面语言初始化，之后切换界面语言不会改变项目写作语言；用户修改项目写作语言也不会翻译或改写已有设定、正文、审稿或知识库内容。

根目录 `CONTEXT.md` 被公共仓库卫生规则明确禁止跟踪，因此不修改 `.gitignore`、也不强制提交该文件；本 ADR 作为这项领域边界的可发布记录。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/ipc-channels.ts`

- `writingLanguage`：项目内容语言，与应用界面语言无关；仅在读取尚无语言字段的渲染端草稿时缺失，打开项目时规整（原文：Project content language; independent from the application UI locale. Missing only while reading pre-language renderer drafts; project open normalizes it.）
- `key`：尽可能由自有文件名派生，缺失表示整个范围不可读（原文：Derived from the owned filename when possible; absent means the whole scope is unreadable.）
- `writingLanguage`：旧收据上缺失，保留其原来的整范围行为（原文：Absent on legacy receipts, which retain their original scope-wide behavior.）

### `src/shared/writing-language.ts`

- `writingLanguageText`：按项目写作语言选内置文案，不检查用户内容（原文：Select built-in copy by project writing language without inspecting user content.）
