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
