# 按 issue 补的场景（#382 起）

> 历史说明：`issue-scenarios/` 下的说明按当时的改造或 issue 记录场景与对照步骤，不随当前构建更新。其中的对照命令（旧外壳场景、`--shell`、指向 trunk 的 `--app-root`）只适用于当时的 trunk，在当前构建上不能照抄。当前构建的做法以正文和 `driver.md` 为准；某个场景现在能不能对 head 跑，以 `driver.md`「RD-10 删除旧外壳之后」的分类为准。

RD 之后为具体缺陷补的场景。修同一块功能时，先在这里找已有场景。

每条场景的说明放在定义它的 `scripts/redesign/<短名>-scenarios.mjs` 对应的 `issue-scenarios/<短名>.md`，`scripts/redesign/__tests__/issue-scenarios-docs.test.mjs` 检查这一点。有说明文件的模块，定义的每个场景都要有说明行，写在本模块的说明文件里，或者写在页面场景表 `rd-stage-scenarios.md`、`rd-review-scenarios.md`、`baseline-scenarios.md` 里，同一个测试也查这一点。没有补过 issue 场景的模块没有说明文件，测试不查。文件头只写本文件全部场景共有的前提，只对部分场景成立的写在那一行。场景在 `requires` 里声明的前提（平台写「只在 Windows」、环境变量写变量名、主题写 `--theme dark`），同一个测试只查 `issue-scenarios/` 下的说明文件有没有写进去，页面场景表里的行不查。按 issue 找：`grep -l '#702' .claude/skills/verify/references/issue-scenarios/*.md`。

新加场景时，新建 `scripts/redesign/<短名>-scenarios.mjs` 和 `issue-scenarios/<短名>.md` 两个文件，驱动自动收进来，不用改 `drive.mjs` 或本文件。
