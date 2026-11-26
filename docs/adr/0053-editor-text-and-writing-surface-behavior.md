# 编辑器文字与写作界面的行为约定

2026-11-27，注释清理（#852）第 5 个 PR（src/components）。

## 背景

`src/components/editor/**` 提供正文与设定文档的 CodeMirror 编辑、续写插入、段落缩进、Tab 行为、修稿合并与蓝图草稿账本。注释写着缩进为什么只是显示、Tab 为什么插入 em 空格、键盘用户怎么走出编辑区、合并怎么对齐段落，这些决定只靠函数体读不出来。

## 决定

正文内容与显示分离：首行缩进由样式完成，不改正文；分节线与标题行不是段落。Tab 在正文里插入两个 em 空格，键盘用户先按 Esc 进入 tab-focus 模式才能移出，中间按别的键或失焦就恢复插空格。续写作为独立段落接在选区末尾，缩进与换行照抄选区附近的正文；设定文档是 Markdown，缩进与空行是结构，只去首尾空行。修稿合并按段落相似度对齐，合并结果就是各段文字按顺序以换行连接。下面按文件列出各条口径。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/editor/continuation-insert.ts`

- `continuationInsert`：续写接在选区末尾，作为独立的段落：段间换行与段首缩进照抄选区附近的正文。 返回要替换的范围（选区末尾两侧的换行）和替换成的文字。
- `midParagraph`：选区停在段中：段里剩下的文字另起一段，去掉它开头的空格，下面补上段首缩进。
- `body`：设定文档是 Markdown，缩进和空行是结构，只去掉首尾空行。

### `src/components/editor/live-preview.ts`

- 限制：只有开头 16 KiB 参与页面首字下沉的判定（原文：ponytail: only the opening 16 KiB participates in the page drop cap.）

### `src/components/editor/merge-segments.ts`

- `simFromFreqs`：从预计算的频率 map 计算相似度（避免重复创建 Map）
- `alignParagraphs`：基于相似度的 DP 段落对齐（性能优化版） 预计算所有频率 map，避免 DP 循环中重复创建

### `src/components/editor/paragraph-indent.ts`

- `NOT_PARAGRAPH`：分节线与 # 标题行不是段落：整行只有分节符号与空白、符号至少 3 个（---、* * *、＊＊＊、※※※、◇◆◇、———、·····、～～～ 一类）。 「——他说」这样以符号开头的正文仍是段落。
- `paragraphIndent`：段落首行缩进两字只是显示：给以文字开头的行加 cm-indent，由样式缩进，正文内容不变。 已经以空格开头的行（作者用 Tab 插入了 em 空格，F-188）不再叠加一次；分节线与标题行不缩进。

### `src/components/editor/prose-tab.ts`

- `proseTab`：正文里 Tab 插入两个 em 空格（U+2003，2em 正好是中文首行缩进两字，不依赖 CJK 字体），键盘用户因此出不去编辑区： 先按 Esc 打开 CodeMirror 的 tab-focus 模式，下一次 Tab 或 Shift+Tab 就按正常焦点顺序移出、不插空格； 中间按了别的键或编辑区失焦就关掉，Tab 恢复插空格。CodeMirror 自带的 Esc 只开 2 秒，这里不限时。 Esc 本身不拦，搜索框、沉浸写作等对 Esc 的处理照旧。
- 排在按键绑定之前：方向键等被绑定处理掉的键也要关掉 tab-focus 模式
