import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function screenshots(file: string): string[] {
  return readFileSync(file, 'utf8').match(/docs\/assets\/readme\/[^\s)"']+/gu) ?? []
}

describe('README language variants', () => {
  it('keeps Chinese README as the repository default with localized product screenshots', () => {
    const images = screenshots('README.md')
    expect(images.some((image) => /-zh[-.]/u.test(image))).toBe(true)
    expect(images.filter((image) => /-en[-.]/u.test(image))).toEqual([])
    expect(readFileSync('README.md', 'utf8')).toMatch(/\[English\]\(README_en\.md\)\s*\|\s*\*\*中文\*\*/)
  })

  it('uses English interface screenshots for the English README', () => {
    const images = screenshots('README_en.md')
    expect(images.some((image) => /-en[-.]/u.test(image))).toBe(true)
    expect(images.filter((image) => /-zh[-.]/u.test(image))).toEqual([])
    expect(readFileSync('README_en.md', 'utf8')).toMatch(/\*\*English\*\*\s*\|\s*\[中文\]\(README\.md\)/)
  })
})
