# 按 issue 补的场景（#382 起）

> 历史说明：`issue-scenarios/` 下的说明按当时的改造或 issue 记录场景与对照步骤，不随当前构建更新。其中的对照命令（旧外壳场景、`--shell`、指向 trunk 的 `--app-root`）只适用于当时的 trunk，在当前构建上不能照抄。当前构建的做法以正文和 `driver.md` 为准；某个场景现在能不能对 head 跑，以 `driver.md`「RD-10 删除旧外壳之后」的分类为准。

RD 之后为具体缺陷补的场景。修同一块功能时，先在这里找已有场景。

说明放在 `issue-scenarios/<短名>.md`，短名是 `scripts/redesign/<短名>-scenarios.mjs` 去掉 `-scenarios.mjs`。拆分前写成的说明有的一节讲了几个场景文件，归在它最先提到的那个短名下，所以不是每个场景文件都有同名说明；页面类场景的说明在 `rd-stage-scenarios.md`、`rd-review-scenarios.md`。按短名、场景名或 issue 找，用 grep：`grep -rl 'e763' .claude/skills/verify/references/`、`grep -l '#702' .claude/skills/verify/references/issue-scenarios/*.md`。

新加场景时，新建 `scripts/redesign/<短名>-scenarios.mjs` 和 `issue-scenarios/<短名>.md` 两个文件，驱动自动收进来，不用改 `drive.mjs` 或本文件。
