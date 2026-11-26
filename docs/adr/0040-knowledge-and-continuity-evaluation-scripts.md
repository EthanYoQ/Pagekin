# 检索重排与连续性校准评估脚本的约定

2026-11-26，注释清理（#852）第 1 个 PR（scripts）。

## 背景

`scripts/eval/knowledge-rerank.mjs` 比较知识库检索的重排效果，`scripts/lib/continuity-calibration*.mjs` 给连续性审稿校准提供模型消息与机械校验。两者都是离线评估工具，不属于产品运行路径，其设计取舍原先写在注释里。

## 决定

### 一、检索重排评估

1. 块 id 每次导入都随机，跨运行比较会混入召回差异，所以重排只和**同一次运行、同一组候选的原序**比较；全文组平分段的顺序也会因块 id 随机而变，需要在比较结果里单独标出。
2. 评估显式打开自动复用，借检索档案的同一端点与 Key；生产默认关闭。
3. 构造查询的规则要与 `generate-draft.command.ts` 保持一致；嵌入空间的命名要与 `knowledge-base.ts` 的 `embeddingSpaceFor` 一致，否则生产代码抛 `SPACE_NOT_MATCHED`。
4. 生产源码在模块顶层用 `import.meta.url` 建 `require`；打成 CJS 后要换成本文件的 URL（脚本用 esbuild banner 注入）。

### 二、连续性校准

1. 解析与机械校验模型响应时，定位到引文只证明该引用存在于输入包里，从不证明发现在语义上是对的；汇总只统计格式与引用有效性，人工金标评分刻意缺席。
2. 测试文件用 `.node-test` 后缀避开 Vitest 的自动发现，须显式 `node --test` 运行；子进程的 fetch 在 runner 加载之前就被替换，测试不发任何网络请求；失败的一对消耗其两次 attempt、停止后续用例且不能重试。
