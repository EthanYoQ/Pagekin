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

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/__tests__/app-open-shortcut.browser.tsx`

- 主进程的回复按渠道给出最小的合法形状（同 app-no-chat）；选文件夹回 null，即作者取消了选择。 App 挂载时按 config 的 locale 初始化语言，缺省就跟系统语言走，英文系统的 CI 上会渲染成英文。

### `src/__tests__/runner-locale.browser.tsx`

- `invoke`：与 App 挂载时一样：config 里没有 locale，语言初始化退回浏览器的 navigator.language。

### `src/i18n/__tests__/localized-text.typecheck.ts`

- `japaneseCopyComesBeforeParams`：tsc 检查：日文只能写在英文之后，参数对象只能放在最后。

### `src/i18n/__tests__/shown-locale.ts`

- `shown`：测试里直接指定作者看到的界面语言；生产代码只从 locale-store 与主进程配置取得。

### `src/i18n/core.ts`

- `copyLocale`：界面语言对应的文案语言：ja-JP 读英文。运行与存档只记这一种。
- `errorLocaleForRun`：冻结了文案语言的运行（运行卡片、工作流、导入）查报错目录用的语言：运行的文案语言与界面一致时用界面语言 （日文界面看英文运行得到 ja-JP），不一致时用运行自己的语言，原因和运行里其余文字是同一种语言。
- `localize`：现行规则：共用文案走带键目录，单组件私有的一次性文案就近放，保持目录聚焦（原文：Localize short copy that belongs to a single component. Shared language uses the keyed catalog above; colocating one-off copy keeps the catalog focused.）

### `src/i18n/messages/ja-JP.ts`

- `jaJP`：现行规则：日文文案尚未补齐处，按钮与页面标签保持英文（#722）（原文：Labels of buttons and pages stay in English while the colocated copy that shows them has no Japanese yet (#722).）

### `src/i18n/types.ts`

- `SUPPORTED_LOCALES`：界面事实：作者在「设置 → 外观」里选界面语言，常量列表看不出入口位置（原文：Interface languages the author can choose in Settings → Appearance.）
- `COPY_LOCALES`：现行规则：就地文案以中英文写成，ja-JP 界面在该区域补出日文之前读英文（#722）（原文：Languages that colocated copy (`text(zh, en)`, `localize`, …) is written in. A `ja-JP` interface reads this copy in English until each area gains Japanese copy (#722).）
- `ErrorDisplayLocale`：查报错目录用的语言，是作者在设置里选的界面语言；文案语言 `Locale`（日文界面下是 en-US）传不进来。

### `src/services/__tests__/export-service-integration.test.ts`

- `globalEnvironmentKeys`：主进程提示文案按全局数据里的界面语言取。

### `src/services/agent/__tests__/writing-skill-bindings.test.ts`

- 绑定报错按界面语言说明；下面的断言按英文界面写。

### `src/services/agent/tool-registry.ts`

- `uiLocale`：现行规则：整轮 Agent 对话冻结可见的界面语言（原文：Visible interface language frozen for this complete Agent turn.）
- `interfaceLocale`：查报错目录用的界面语言，与 uiLocale 同时冻结。
- `writingLanguage`：现行规则：整轮 Agent 对话冻结面向模型的写作语言（原文：Model-facing language frozen for this complete Agent turn.）

### `src/services/agent/tools/__tests__/project-read-tools.test.ts`

- `call`：登记过的码按作品写作语言说明，不把主进程转来的中文原文交给英文作品。

### `src/services/project-clear-service.ts`

- 对话框标题已写「清除失败」：中文界面只给主进程原因，英文界面不转出中文原文。

### `src/services/prompt-catalog.ts`

- `DIAGNOSTIC_TEXT`：项目提示词的损坏原因按码缓存，报错时再按当时的界面语言说明：缓存会跨越界面语言切换。

### `src/services/prompt-language.ts`

- `EN_US_BUILTIN_PROMPTS`：现行规则：面向模型的内置提示词翻译只由项目写作语言选择，不由应用界面语言选择，界面文案故意不在其中（原文：Model-facing built-in prompt translations. UI copy is deliberately absent: the project writing language, not the application locale, selects this map.）

### `src/services/workflow-guards.ts`

- `shown`：不传语言时按写出提示这一刻的界面语言，查询期间切换了语言也不会用旧语言。
- `missing`：只记下缺了哪几块，等最后一次查询回来再按当时的语言写出名字。
- `shown`：不传语言时按写出提示这一刻的界面语言，查询期间切换了语言也不会用旧语言。

### `src/stores/__tests__/locale-store.test.ts`

- `outcomes`：两次连续选择 zh-CN → en-US → ja-JP，各自成败、谁先返回，八种组合。 主进程按发出顺序写配置，失败的不写：保存下来的是最后一次成功的选择。

### `src/stores/locale-store.ts`

- `interfaceLocale`：字段语义：作者选的界面语言，包括就地文案尚无对应日文的语言（原文：Language chosen for the interface, including languages that colocated copy does not have yet.）
- `locale`：界面语言对应的文案语言（ja-JP 读 en-US），运行冻结的就是它。
- `activeInterfaceLocale`：现行规则：只设 locale 的代码（测试里的 setState）会留下 interfaceLocale，这时 locale 胜出，保证目录与就地文案不分歧（原文：Interface language in effect. Code that sets only `locale` (as tests do with setState) leaves `interfaceLocale` behind; then `locale` wins, so the catalog and the colocated copy never disagree.）
- `localeReaders`：现行规则：组件常只选 t 或 text，随语言刷新这些读取器身份使订阅响应变化，函数从回调调用时仍解析最新语言（原文：Components commonly select only `t` or `text`. Refreshing these reader identities with the locale makes those subscriptions reactive while the functions still resolve the latest locale when called from callbacks.）

### `src/stores/workflow-store.ts`

- `writingLanguage`：现行规则：项目写作语言在工作流启动时冻结（原文：Project writing language frozen when the workflow starts.）
- `uiLocale`：现行规则：可见的界面语言在工作流启动时冻结（原文：Visible interface locale frozen when the workflow starts.）
- `interfaceLocale`：查报错目录用的界面语言，与 uiLocale 同时冻结；只在执行上下文里，不进运行记录。
- `uiLocale`：现行规则：持久化的工作流可以独立于当前应用设置冻结界面语言（原文：Persisted workflows may freeze the UI locale independently of the current app setting.）
