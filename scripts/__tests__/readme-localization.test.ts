import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function screenshots(file: string): string[] {
  return readFileSync(file, 'utf8').match(/docs\/assets\/readme\/[^\s)"']+/gu) ?? []
}

function screenshotLanguage(image: string): string | undefined {
  const match = /\/screens\/(zh|en)\/|-(zh|en)[-.]/u.exec(image)
  return match?.[1] ?? match?.[2]
}

const variants = [
  {
    name: 'keeps Chinese README as the repository default with Chinese screenshots',
    file: 'README.md',
    language: 'zh',
    switcher: /\[English\]\(README_en\.md\)\s*\|\s*\*\*中文\*\*/,
  },
  {
    name: 'uses English interface screenshots for the English README',
    file: 'README_en.md',
    language: 'en',
    switcher: /\*\*English\*\*\s*\|\s*\[中文\]\(README\.md\)/,
  },
  {
    name: 'reuses English screenshots for the Japanese README because the phase-1 Japanese interface keeps most labels in English',
    file: 'README_ja.md',
    language: 'en',
    switcher: /\[English\]\(README_en\.md\)\s*\|\s*\[中文\]\(README\.md\)\s*\|\s*\*\*日本語\*\*/,
  },
] as const

describe('README language variants', () => {
  it.each(variants)('$name', (variant) => {
    const images = screenshots(variant.file)
    expect(images.length).toBeGreaterThan(0)
    expect(images.filter((image) => screenshotLanguage(image) !== variant.language)).toEqual([])
    expect(readFileSync(variant.file, 'utf8')).toMatch(variant.switcher)
  })
})
