# 写作 Skill 是按阶段冻结的补充指导

写作 Skill 只能补充设定与规划、章节正文、AI 审稿、修稿与定稿前润色四个阶段的创作方法。每个项目每阶段最多绑定一个 Skill；工作流启动时按项目写作语言冻结当次内容，运行中的配置变化不影响已启动任务。

作者事实、项目写作语言、结构化输出格式和工具协议始终高于 Skill。第一版只接受自包含的提示词型 Skill；带脚本、hook、子代理、相对引用或任意工具执行要求的包不得作为写作指导安装执行。Skill 内容计入提示词预算，预算不足时明确失败，不静默截断。

内置 Skill 可停用但不可删除；用户 Skill 可以在确认后安装、解除绑定或卸载。运行日志记录实际使用的冻结 Skill，使生成结果可以追溯到本次工作流输入。

## 测试口径

`test/helpers/installed-writing-skill-fixture.ts`（注释清理 M30 第 2 个 PR 迁入）：

- 对拍基准：`MASTER_*` 与 `master*` 函数是 origin/master（d21207c8）上 `inspectWritingSkillMarkdown` 的逐字副本。没有安装清单的已安装 Skill（本地导入出现之前装的全部，以及 GitHub 导入）必须与它逐字节一致。不要随实现一起修改这份副本。
- `masterVisibleFields` 只取 master 检查结果里的字段：`metadata`、`content`、`compatible`、`reasons`、`suggestedStage`、`utf8Bytes`。比对的是用户能看到的判定与提示词，不比新增的附带文件字段。
- `LegacyInstalledSkillCase.name` 既是 Skill 目录名，也是 frontmatter 里的 `name`。
- `LegacyInstalledSkillCase.plant(directory, outside)` 在 Skill 目录里放进被引用的文件；`outside` 是 Skill 目录之外的临时目录。
- `LEGACY_INSTALLED_SKILL_CASES` 是复审员列出的写法：Skill 目录里真有被引用的文件（旧版 `~/.vela` 迁移会原样复制，用户也可能手动放），但目录里没有安装清单。按 master，这些文件一概不读。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/builtin-writing-skills.ts`

- `whenToUse`：使用场景（用于 Agent 自动匹配）
- `getBuiltinWritingSkills`：每次返回新数据，使对注册表的改动碰不到主进程的来源权威（原文：Fresh data keeps registry mutations out of the main-process source authority.）
- `readBuiltinWritingSkill`：所选语言的正文恰是渲染端 Skill 绑定使用的正文（原文：The selected language body is exactly the body used by renderer skill bindings.）

### `src/shared/ipc-channels.ts`

- `return`：bundle：按安装清单读到的附带文本；没有清单的 Skill 为 none，只看 SKILL.md。
- `skills:pick-local`：主进程弹出系统对话框选择本机 SKILL.md 或 Skill 文件夹，只读检查后返回候选。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/agent/skill-registry.ts`

- Skill 注册中心 管理所有可用的 Skill（基于 SKILL.md 的模块化知识包）。 支持： - 内置 Skill（随 Vela 发布的预设 Skill） - 用户 Skill（用户放在 ~/.vela/skills/ 下的自定义 Skill） - 项目 Skill（放在项目的 .ai-novel/skills/ 下的项目级 Skill） Skill 格式兼容 Cursor 的 SKILL.md 生态。
- `whenToUse`：使用场景（用于 Agent 自动匹配）
- `skillId`：字段用途：skillId 是稳定的项目绑定键，按它查找，不同于可重名的 metadata name（原文：Stable project-binding key.）
- `writingSkill`：现行规则：只含提示词的工作流兼容检查，不兼容的包仍然可见但从不注入（原文：Prompt-only workflow compatibility; incompatible packages remain visible but are never injected.）
- 从主进程管理的用户 Skill 目录加载，渲染进程不接触 VELA_HOME 路径。
- `userCount`：用户 Skill 路径只能由主进程的固定应用数据服务访问。

### `src/stores/workflow-store.ts`

- `writingSkills`：字段用途：启动时冻结的写作 Skill 的安全展示元数据（原文：Safe display metadata for workflow-start-frozen writing skills.）
- `writingSkills`：现行规则：完整不可变内容在第一步开始前冻结一次（原文：Full immutable content frozen once before the first workflow step starts.）
