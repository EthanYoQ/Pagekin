# 服务商目录、推理策略与分工路由的共享规则

2026-11-26，注释清理（#852）第 3 个 PR（src/shared）。

## 背景

`provider-presets.ts`、`reasoning-policy.ts`、`reasoning-types.ts`、`model-profile-draft.ts`、`model-stage-routing.ts`、`rerank-config.ts` 等文件决定每个服务商与模型能声明什么、请求怎么映射、阶段用哪个模型。注释里有大量文档出处、实测结论与取舍理由。

## 决定

服务商能力只信应用维护的内置目录与精确端点、协议、模型 slug 的匹配；用户填的能力标志与输出上限只是运行策略，不是协议证据。预算规划用的容量证据与请求特性相互独立。推理策略集中在一个接缝里，调用方只给产品意图。阶段路由只存模型 id，不复制含明文 Key 的档案，也不退到第一个模型，以免把正文发给作者没选过的端点。下面按文件列出各条口径与文档出处。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/model-stage-registry.test.ts`

- `SOURCES`：源码在模块加载时只读一遍，各条用例只做内存匹配：并行套件里同一批读取会从约 200ms 拉长到 9 秒，放在用例里会撞 5 秒超时。
- `notGeneration`：不是生成 operation：source-draft-changed.ts 用它们区分提示文案。
- 接缝在工作流首次开跑时钉住模型，同一工作流后面的步骤沿用它。 所以一个工作流定义里只能有一个环节的 operation，否则后面的环节会悄悄用前一个环节的模型。

### `src/shared/__tests__/provider-presets.test.ts`

- `levels`：思考等级取自 https://ai.google.dev/gemini-api/docs/generate-content/thinking 。

### `src/shared/__tests__/rerank-config.test.ts`

- 默认关闭自动复用的原因见 src/shared/rerank-config.ts 的 AUTO_REUSE_EMBEDDING（#632）。

### `src/shared/embedding-options.ts`

- `EmbeddingModel`：知识库调用检索模型所需的字段。provider 和 baseUrl 一起决定是否需要 Key，见 hasRequiredApiKey。
- `LOW_VRAM_EMBEDDING_OPTIONS`：适合低显存本地 OpenAI 兼容 Embedding 服务的保守起点。
- `normalizeEmbeddingOptions`：将历史配置和手动编辑收敛为 API 可安全执行的范围。

### `src/shared/ipc-channels.ts`

- `model-provider-resource:open`：只接受受信任资源 ID，由主进程映射为固定 HTTPS URL。
- `defaultRerankModelId`：显式选定的重排档案；缺省时按检索档案自动复用。
- `id`：服务商自有的模型标识，原样取自列表 API（原文：Provider-owned model identifier exactly as returned by the list API.）
- `name`：服务商自有的显示名，缺省回落到标识（原文：Provider-owned display name, falling back to the identifier.）
- `value`：可保存到 ModelProfile.modelName 的值（原文：Value that can be saved in ModelProfile.modelName.）
- `capabilities`：仅端点响应里明确无歧义的声明（原文：Only explicit, unambiguous declarations from the endpoint response.）
- `ModelDiscoveryRequest`：请求服务商模型列表所需的未保存端点字段，用途决定哪些模型适合（原文：Unsaved endpoint fields required to request a provider's model list; purposes decide which models fit.）
- `args`：发现用当前设置表单，不先持久化（原文：Discovery uses the current settings form without persisting it first.）
- `creativeStrategy`：项目级写作意图，与所选模型无关（原文：Project-scoped writing intent; independent from the selected model.）
- `modelExecutionLeaseId`：可选的冻结主进程模型快照，存在时具有权威（原文：Optional frozen main-process model snapshot; when present it is authoritative.）
- `purpose`：按项目调用历史的稳定归因（原文：Stable attribution for per-project call history.）
- `creativeStrategy`：渲染端为这次请求捕获的项目级产品意图（原文：Project-scoped product intent captured by the renderer for this request.）
- `reasoningStage`：受控的语义阶段，绝不从诊断用的 purpose 标签推断（原文：Controlled semantic stage; never inferred from the diagnostic purpose label.）
- `projectSession`：冻结的项目租约，缺失或过期的租约绝不写入项目统计（原文：Frozen project lease. Missing/stale leases are never written to project statistics.）
- `ModelExecutionLeaseReceipt`：完整 ModelProfile 快照的非密钥证据，只保留在主进程（原文：Non-secret evidence for a complete ModelProfile snapshot retained only in the main process.）
- `LLMResponse`：每个非流式响应都带明确的终止证据（原文：Every non-stream response carries explicit terminal evidence.）
- `LLMFinishReason`：与服务商无关的生成文本终态，只有 stop 才可被下游工作流与 Agent 当作完整响应（原文：Provider-neutral end state for generated text. `stop` is the only state that downstream workflows and the Agent may treat as a complete response.）
- `capabilities`：新配置使用的端点能力；旧配置缺失时继续使用 maxTokens。
- `capabilitySources`：配置来源记录，绝不授予已验证的服务商上限（原文：Configuration provenance only; never grants verified provider bounds.）
- `maxTokens`：旧配置和当前执行路径使用的输出 token 上限，保持兼容。
- `reasoningOverride`：档案级高级请求，auto 交给项目策略与用途（原文：Profile-scoped advanced request; `auto` defers to project strategy and purpose.）
- `reasoningMapping`：显式高级线上映射，省略时用端点元数据（原文：Explicit advanced wire mapping; omitted profiles use endpoint metadata.）
- `embeddingOptions`：仅用于 Embedding 模型；旧配置省略时沿用原有默认行为。
- `kb:get-vector-rebuild-status`：本地状态读取：绝不向嵌入服务商发文本，渲染端据此决定能否提供重建（原文：This is a local status read only. It never sends text to an embedding provider; the renderer uses it to decide whether it may offer a rebuild.）

### `src/shared/knowledge-ranking.ts`

- `RERANK_CANDIDATE_COUNT`：产品判断第 9 条：召回 40 段，写稿取 5 段，固定不做配置项。
- `KnowledgeRanking`：一次检索的排序方式。不记端点和 Key。

### `src/shared/model-profile-draft.ts`

- `applyModelProfileSelection`：唯一的显式模型选择接缝，刷新列表从不调用它（原文：One explicit model selection seam; refreshing a list never calls it.）
- `preset`：运行限制与目录的服务商最大值分开持久化，新模型不能覆盖作者设的更小输出上限（原文：Persist operational limits separately from the catalog's provider maxima. In particular, a new model cannot overwrite a smaller author output limit.）
- `CreateModelProfileDraftOptions`：创建新模型配置时的输入；不会读取或修改已保存的配置。
- `createModelProfileDraft`：为设置界面创建完整的新模型草稿。 生成模型从 OpenAI 端点起步，模型名留空，等作者从端点拉到的列表里选； 向量模型默认使用 SiliconFlow 的免费 BAAI/bge-m3，检索模型页的引导文案按「填上密钥就能用」写；重排模型同样从 SiliconFlow 起步。

### `src/shared/model-provider-resources.ts`

- `MODEL_PROVIDER_RESOURCE_URLS`：模型服务商设置里展示的固定外部目的地（原文：Fixed external destinations shown in model-provider settings.）
- `isModelProviderResourceId`：拒绝渲染端提供的任意 URL，只接受固定资源 ID（原文：Reject arbitrary renderer-supplied URLs; only fixed resource IDs are accepted.）

### `src/shared/model-stage-routing.ts`

- `StageModelIds`：只存 id，不复制模型档案：档案含明文 API Key（#518）。
- `routeStageModel`：不退到「第一个模型」：那会把正文发给作者从没选过的端点。

### `src/shared/provider-presets.ts`

- 服务商预设配置 — 共享类型定义 渲染进程与主进程共同使用，持久化在 ~/.vela/provider-presets.json
- `capabilities`：单个模型的能力元数据，maxTokens 保持旧的输出上限（原文：Model-specific capability metadata. `maxTokens` remains the legacy output limit.）
- `structuredOutput`：独立验证过的 JSON 模式支持，不蕴含其他特性或容量事实（原文：Independently verified JSON-mode support; does not imply other feature or capacity facts.）
- `budgetCapabilities`：已验证的容量事实，只用于预算规划，独立于特性标志（原文：Verified capacity facts used only for budget planning, independent of feature flags.）
- `reasoningMapping`：对照官方模型文档验证过的服务商请求映射（原文：Provider request mapping verified against the official model documentation.）
- `ModelBudgetCapabilities`：服务商文档给出的容量事实，不蕴含请求特性支持（原文：Provider-documented capacity facts that do not imply request-feature support.）
- `calibration`：目录有意记录不高于服务商取整声明的安全值（原文：The catalog deliberately records a safe value at or below the rounded provider claim.）
- `contextWindowTokens`：null 表示端点没有声明上下文窗口（原文：`null` means the endpoint has not declared a context window.）
- `ModelCapabilityProfile`：解析有效内置能力所需的持久档案字段（原文：Persisted profile fields needed to resolve effective built-in capabilities.）
- `provider`：服务商唯一标识（内置值如 openai/deepseek，用户可自定义如 my-proxy）
- `displayName`：界面显示名称，缺省时使用 provider ID
- `budgetCapabilityBaseUrls`：额外允许提供预算能力证据的精确官方端点（原文：Additional exact official endpoints allowed to supply budget capability evidence.）
- `budgetProviderAliases`：仅对这条预算证据的精确匹配接受的持久服务商标签（原文：Persisted provider labels accepted only for this exact budget evidence match.）
- `protocol`：默认调用协议：openai 兼容 或 gemini 原生
- `embeddingModels`：支持的向量模型列表（embedding 模型不需要 maxTokens）
- `embeddingModelCapabilities`：向量模型的能力元数据，按模型 ID 索引以保持旧的 string[] 配置兼容。
- `rerankModels`：重排模型，第一个是默认值。
- `createProviderCatalog`：创建内置服务商目录。 每次调用均返回新的对象，方便调用方安全地派生 UI 状态而不污染全局预设。
- `budgetCapabilityBaseUrls`：档案持久化带版本的端点，两种写法是同一官方主机，所以只允许预算证据经它匹配（原文：Profiles persist the versioned endpoint; both spellings are the same official host, so only budget evidence may match through it.）
- `maxTokens`：保留旧运行默认；预算证据独立，不当作请求特性支持宣传（原文：Preserve the legacy operational default; budget evidence is separate and never advertised as request-feature support.）
- `maxTokens`：保留 maxTokens 给现有执行路径，同时暴露新设置表单使用的精确能力名（原文：Retain `maxTokens` for existing execution paths while exposing the precise capability names used by new settings forms.）
- `reasoningMapping`：xAI 推理映射的官方文档出处（原文：https://docs.x.ai/developers/model-capabilities/text/reasoning）
- `structuredOutput`：硅基流动 JSON 模式的官方文档出处（原文：JSON mode: https://docs.siliconflow.cn/docs/api/chat-completions-post）
- `reasoningMapping`：硅基流动推理映射的官方文档出处（原文：https://docs.siliconflow.cn/docs/api/chat-completions-post）
- `maxTokens`：保留现有运行默认，单独验证的容量只是规划证据，不扩大用户设置（原文：Preserve the existing operational default. The separately verified capacity is evidence for planning and does not enlarge user settings.）
- `contextWindowTokens`：服务商页面发布取整的 1049K 与 393K，用保守十进制上界而不自造二进制上限（原文：The provider page publishes rounded 1049K / 393K values. Use conservative decimal bounds rather than inventing binary limits.）
- `reasoningMapping`：只登记推理参数；JSON 模式与容量未核实，不登记。
- `structuredOutput`：硅基流动 JSON 模式指南出处（原文：JSON mode: https://docs.siliconflow.cn/docs/userguide/guides/json-mode）
- `reasoningMapping`：硅基流动推理映射文档出处（原文：https://docs.siliconflow.cn/docs/api/chat-completions-post）
- `structuredOutput`：硅基流动 JSON 模式指南出处（原文：JSON mode: https://docs.siliconflow.cn/docs/userguide/guides/json-mode）
- `reasoningMapping`：应用选定的预算，不是服务商定义的 medium 档，附推理文档出处（原文：Application-selected budget, not a provider-defined medium effort. https://docs.siliconflow.cn/docs/userguide/capabilities/reasoning）
- `maxOutputTokens`：保守的受支持输出，不声称模型最大值（原文：Conservative supported output, not a claim of the model's maximum.）
- `rerankModels`：硅基流动重排接口文档出处（原文：https://docs.siliconflow.com/en/api-reference/rerank/create-rerank）
- `reasoningMapping`：DeepSeek 思考模式文档出处（原文：https://api-docs.deepseek.com/guides/thinking_mode/）
- `reasoningMapping`：DeepSeek 思考模式文档出处（原文：https://api-docs.deepseek.com/guides/thinking_mode/）
- `provider`：智谱 BigModel — OpenAI 兼容协议，API 路径为 /v4
- `rerankModels`：https://docs.bigmodel.cn/api-reference/模型-api/文本重排序
- `provider`：智谱 BigModel — Anthropic Messages 兼容协议，API 前缀为 /api/anthropic。 模型 ID 与 OpenAI 兼容端点一致；该协议没有嵌入接口，也不声明 JSON 模式与推理映射。
- `models`：容量见各模型页 https://ai.google.dev/gemini-api/docs/models/<模型 ID>（输入 1,048,576、输出 65,536， 均支持 Thinking 与 Structured outputs）；思考等级见 https://ai.google.dev/gemini-api/docs/generate-content/thinking 。
- `retiredModels`：2.5 Flash-Lite 已不对新用户开放（调用返回 404），老用户已保存的配置仍按原映射调用。
- `reasoningMapping`：Gemini 思考文档出处（原文：https://ai.google.dev/gemini-api/docs/generate-content/thinking）
- `embeddingModels`：text-embedding-004 已不在 models 列表里；gemini-embedding-001 默认返回 3072 维。
- `BUILTIN_PRESETS`：内置默认预设（首次启动时写入持久化文件）
- `isLocalModelEndpoint`：Ollama 和本机地址上的模型服务：不需要 API Key，连接测试也按本机放宽超时。
- `hasRequiredApiKey`：设置页保存、拉取列表和知识库嵌入共用的 Key 规则：填了 Key，或者是不需要 Key 的 Ollama 与本机地址。
- `resolveModelProfileBudgetCapabilities`：解析预算规划用的容量证据，不对推理、结构化输出、用量上报等请求特性作任何声明（原文：Resolve capacity evidence for budget planning without making claims about reasoning, structured output, usage reporting, or other request features.）
- Qwen 证据只限定在发布的国内端点，不适用于 V4 别名（原文：Qwen evidence is scoped to the published CN endpoint, not the V4 alias.）
- `resolveModelProfileCapabilities`：解析已验证的内置服务商事实而不改持久数据；用户存的能力与输出上限是运行策略，不是服务商支持什么的证明，从不覆盖结果（原文：Resolve verified built-in provider facts without mutating persisted data. User-stored capabilities and output limits are operational policy, not proof of what a provider endpoint supports, so they never override this result.）
- `resolveModelProfileStructuredOutput`：在精确的目录端点、协议与模型上解析一个声明的特性（原文：Resolve one declared feature on the exact catalog endpoint, protocol and model.）
- `resolveModelProfileReasoningMapping`：只解析端点与精确模型 slug 匹配应用维护的内置预设的服务商请求映射；用户填的能力标志只是运行提示，从不成为协议证据（原文：Resolve only provider request mappings whose endpoint and exact model slug match an app-maintained built-in preset. User-entered capability flags are operational hints and never become protocol evidence.）
- `preset`：显示标签不定义端点能力；预算别名没有精确端点映射也不授予请求特性（原文：Display labels do not define endpoint capabilities. Budget aliases still do not grant request features without an exact endpoint mapping.）

### `src/shared/reasoning-policy.ts`

- `STAGE_REQUESTS`：extraction 是定稿后从正文整理要点和角色状态。思考 token 占这两步九成以上的耗时，作者要等它们完成才能写下一章。
- Gemini 3 关不掉思考，也有型号拒收 minimal；不发参数会落到服务商的默认档（常是 medium 或 high），所以取最低档。
- `resolveReasoningPolicy`：唯一的推理策略接缝：调用方给产品意图，本模块拥有档案优先级、已验证能力查找、服务商级封顶与用户可见的解析收据（原文：The single reasoning-policy seam. Callers provide product intent; this module owns profile precedence, verified capability lookup, provider-level capping and the user-visible resolution receipt.）
- 提取阶段对关不掉思考的服务商（不支持，或像 Gemini 3 那样被抬到最低一档）沿用审稿档位。
- 对这个 Qwen 集成只定义显式选定的应用预算（原文：Only explicitly selected application budgets are defined for this Qwen integration.）
- 只支持显式、有文档的硅基流动选择，保留自动请求，绝不把 off、low、medium 抬到 high（原文：Only explicit, documented SiliconFlow choices are supported. Preserve automatic requests and never force off/low/medium up to high.）
- 只有提取阶段关思考（enable_thinking:false 实测可用）；其余阶段交给服务商默认。

### `src/shared/reasoning-types.ts`

- `REASONING_STAGES`：受控语义阶段，产品调用方使用，绝不从诊断名推断（原文：Controlled semantic stage used by product callers; never inferred from a diagnostic name.）
- `GEMINI_THINKING_LEVELS`：generateContent 的 thinkingConfig.thinkingLevel 取值。minimal 是官方给的「不思考」档，但不保证完全不思考， 所以只用来承接产品里的「关闭」。https://ai.google.dev/gemini-api/docs/generate-content/thinking
- 没写协议的旧配置按 OpenAI 兼容处理；anthropic 协议暂无经验证的推理参数映射。
- `adapter`：Gemini 3 起用 thinkingLevel 代替 thinkingBudget。
- `thinkingBudget`：0 关闭思考，正数与回答分开预算思考（原文：Zero disables thinking; positive values budget thinking separately from the answer.）
- `requestAliases`：文档记载的从请求产品强度到服务商实际强度的兼容别名（原文：Documented compatibility aliases from a requested product effort to the provider's actual effort.）
- `isReasoningMapping`：校验既有的有限适配器形状，含手动提供的映射（原文：Validate the existing finite adapter shape, including manually supplied mappings.）

### `src/shared/rerank-config.ts`

- `AUTO_REUSE_EMBEDDING`：参考评估没证明重排能提升写作质量（#632），暂不自动借检索档案重排；正式评估通过后再改为 true。
- `isSiliconflowEndpoint`：只看 provider 不够：作者可能把硅基流动档案的地址改成了代理、http 或别的端口，Key 不能跟着去那里。 URL 会把 https 的 :443 规范成空端口。
- `resolveRerankConfig`：显式选了重排档案就只用它；否则只有硅基流动检索档案可以把同一端点和 Key 借给重排。
