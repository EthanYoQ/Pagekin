# 保留不可区分的显式暗色主题意图

版本 0.8.2 中用户主动选择的 `dark` 与更早版本深蓝主题的持久化数据形态相同，升级代码无法可靠识别来源。系统因此保留所有持久化 `dark`，只把明确的历史值 `night` 迁移为 `dark`；不再用缺失标记猜测并改写用户选择。这个决定放弃自动重命名一部分旧深蓝数据，换取升级过程不改变无法证明来源的用户偏好。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/appearance-profile.test.ts`

- `previous`：RD-10 之前写下的配置：v1 的外壳只能是 unset、classic、writer，v2 还可以是 stage。
- 皮肤从来不在外观偏好里，而在主进程全局数据的 skins/manifest.json；那份文件迁移后不再读取，原样留给回退。 这里断言的是：任何版本的外观偏好都表达不了皮肤，所以三种旧皮肤迁移后都是没有背景图的纸墨界面。

### `src/shared/__tests__/fixtures/appearance-profile-v1-parser.fixture.ts`

- `THEMES`：eb0affc1（RD-3 之前的最后一版）外观配置解析器的原样拷贝，只把返回类型换成 unknown、去掉导出的错误类。 新版本写出的配置要能被回退后的旧版本读回，测试用它当旧版本；不要随新版本修改。

### `src/shared/appearance-profile.ts`

- `APPEARANCE_STORAGE_KEY`：外观偏好：浅色或深色、缩放与两种字体，存在渲染进程的 localStorage。 v3 起换了新键：RD-10 之前的配置（带外壳偏好与 galaxy、paper 主题）只读不写，回退到旧版本时它原样还在。
- `LEGACY_THEME_STORAGE_KEY`：更早版本分开存的主题，迁移只读。
- `CanonicalAppearanceProfile`：内存里的外观偏好。schemaVersion 只出现在存储里。
- `legacyFontDefaultsVersion`：字体默认值版本只记来源，从不触发字体重置（原文：Provenance only. Never triggers a font reset.）
- `PREVIOUS_THEME`：旧配置的主题：深色与星空迁为深色，纸面与浅色迁为浅色。
- `parseAppearanceProfile`：读取已保存的 v3 配置，严格校验：别的版本、皮肤、外壳偏好等多出来的字段都拒绝。
- `migratePreviousAppearance`：RD-10 之前的配置（schemaVersion 1、2）按它当时的规则严格校验后迁成 v3：主题按 PREVIOUS_THEME 换算，外壳偏好丢弃， 修订号、缩放、字体与来源照搬。只读旧键，不改它。
- `migrateLegacyAppearance`：最早的版本只存了主题、缩放与字体（ai-novel-writer-theme）。没有这一项时用初始偏好。 跟随系统的主题按当时的系统外观落定，night 是深色的旧名。

### `src/shared/project-storage.ts`

- `mayHydrateAppearance`：主进程的全局数据就绪后，渲染进程才读写外观偏好。

### `src/shared/startup-contract.ts`

- `AppearanceReadbackAck`：渲染进程写好外观偏好并读回后，向主进程确认这一份的修订号与所在的全局数据世代。
- `appearanceRevisionFloor`：这个窗口此前已确认过的外观修订号。重载后存储坏了时，重置要写得比它大，主进程才接受。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/stores/appearance-bootstrap.ts`

- `systemColorTheme`：系统当前的深浅色：外观偏好还没读出来（或要新建）时用它。
- `createAppearanceStore`：现行规则：每个渲染端只有一个写入者，导入模块不做任何存储读写（原文：One writer per renderer. Importing the module performs no storage read or write.）
- `mainRevisionFloor`：主进程按窗口记着确认过的修订号，同进程重载后内存清空但它还在；重置时的修订号不能低于它。

### `src/stores/theme-store.ts`

- `Theme`：纸墨只有浅色与深色两套。
- `resolvedTheme`：当前应用到界面的主题，外观偏好载入之前是浅色
- `createThemeStore`：现行规则：主题 store 只是面向旧调用方的投影，全部持久化归 appearance-bootstrap（原文：Legacy-facing projection only; appearance-bootstrap owns all persistence.）
- `applyTheme`：深色时给根元素加 .dark：纸墨作用域之外的旧颜色变量与 Tailwind 的 dark 变体靠它切换。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/editor/RelationshipGraph.tsx`

- `inkRoot`：深浅色切换时根元素换 .dark，纸墨作用域换 data-theme，两处都要重画

### `src/components/editor/__tests__/RelationshipGraph.browser.tsx`

- `role`：修复前该角色姓名固定使用 #54666E，在深色面板上测得的对比度低于 3:1。

### `src/components/startup/RendererStartup.tsx`

- `theme`：这一层在外壳的纸墨作用域之外，自己挂 .paper-ink 才取得到令牌；外观偏好还没读出（或读坏了）时跟随系统深浅色。
