// 编辑器续写带不带本章材料的真实模型对照（#702）。两组只差材料：续写规则、模板、选区都相同。
// 输出盲评文件（组别打乱，只有编号）与揭盲表，冲突由人按四类判定后填回 judged.json。
// 运行：node node_modules/esbuild/bin/esbuild scripts/redesign/editor-context-eval.ts --bundle --platform=node --format=esm --packages=external --alias:electron=<空桩> --outfile=.runtime/edctx/eval.mjs（输出要在工作树内才找得到依赖；electron 换成导出 app、nativeImage 的空桩）
//      再 node .runtime/edctx/eval.mjs --book .audit/shutong-sweep/batch11/editor-context/book.json --out <目录> [--runs 5]
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildEditorInlineContext, editorInlineTask } from '../../electron/services/editor-inline-generation'
import { getBuiltinPromptTemplate } from '../../src/services/builtin-prompt-templates'
import type { EditorInlineChapterContext } from '../../src/shared/editor-inline-generation'
import { REAL_GENERATION_MODEL, REAL_KEY_ENV, REAL_ORIGIN } from './real-model.mjs'

type Book = { chapters: { n: number; title: string; text: string }[]; chapter13: string[]; blocks: Record<'style' | 'blueprint' | 'characters' | 'threads', string> }
const arg = (name: string, fallback?: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1]! : fallback }
const book = JSON.parse(fs.readFileSync(arg('book')!, 'utf8')) as Book
const out = arg('out')!
const runs = Number(arg('runs', '5'))
const apiKey = process.env[REAL_KEY_ENV]
if (!apiKey) throw new Error(`缺 ${REAL_KEY_ENV}`)
fs.mkdirSync(out, { recursive: true })

const template = getBuiltinPromptTemplate('edit_selected_text', 'zh-CN')!
const lastChapter = book.chapters.at(-1)!.text.trim()
const previousEnding = lastChapter.slice(-1000)
const tasks = book.chapter13.flatMap((_, index) => {
  const paragraphs = book.chapter13.slice(0, index + 1)
  const documentText = paragraphs.join('\n\n')
  const selectedText = paragraphs.at(-1)!
  const from = documentText.length - selectedText.length
  const chapterContext: EditorInlineChapterContext = { version: 1, chapterNumber: 13, unreadable: [], blocks: [
    { kind: 'style', text: book.blocks.style, required: true },
    { kind: 'blueprint', text: book.blocks.blueprint, required: true },
    { kind: 'characters', text: book.blocks.characters, required: false },
    { kind: 'threads', text: book.blocks.threads, required: false },
    ...(from < 800 ? [{ kind: 'previous-ending' as const, text: previousEnding, required: false }] : []),
  ] }
  const input = { action: 'continue' as const, documentText, from, to: documentText.length, selectedText, chapterContext }
  const withContext = editorInlineTask(buildEditorInlineContext(input, 'zh-CN', template))
  const control = editorInlineTask(buildEditorInlineContext(input, 'zh-CN', template, Infinity, { included: [], omitted: [] }))
  return [{ point: index + 1, arm: 'context', task: withContext }, { point: index + 1, arm: 'control', task: control }]
})
const jobs = tasks.flatMap(item => Array.from({ length: runs }, (_, run) => ({ ...item, run: run + 1, id: randomUUID().slice(0, 8) })))

async function complete(messages: { role: string; content: string }[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${REAL_ORIGIN}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: REAL_GENERATION_MODEL, messages, temperature: 0.7, max_tokens: 1200 }) })
    if (response.ok) return ((await response.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content
    if (attempt === 3) throw new Error(`HTTP ${response.status}`)
    await new Promise(resolve => setTimeout(resolve, 5000 * attempt))
  }
}
const results: (typeof jobs[number] & { output: string })[] = []
for (let start = 0; start < jobs.length; start += 5) {
  results.push(...await Promise.all(jobs.slice(start, start + 5).map(async job => ({ ...job, output: await complete(job.task.messages) }))))
  process.stdout.write(`${results.length}/${jobs.length}\n`)
}
const shuffled = [...results].sort(() => Math.random() - 0.5)
fs.writeFileSync(path.join(out, 'raw.json'), JSON.stringify(results.map(({ task, ...rest }) => ({ ...rest, userPrompt: task.messages.at(-1)!.content })), null, 1))
fs.writeFileSync(path.join(out, 'key.json'), JSON.stringify(Object.fromEntries(results.map(item => [item.id, { point: item.point, arm: item.arm, run: item.run }])), null, 1))
fs.writeFileSync(path.join(out, 'blind.md'), shuffled.map(item => `## ${item.id} · 续写点 ${item.point}\n\n${item.output}\n`).join('\n'))
