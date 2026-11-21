import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { BOOK, seedLargeBook } from './perf702-scenarios.mjs'

const CLOUD_BOOK = 'my-book'
const GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORIGIN = '11111111-1111-4111-8111-111111111111'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const { name, bytes } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const checksum = crc32(bytes)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(bytes.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, bytes)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE((3 << 8) | 20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(bytes.length, 20)
    record.writeUInt32LE(bytes.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE((0o100600 << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, nameBytes)
    offset += header.length + nameBytes.length + bytes.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function newerArchive() {
  const chapter = Buffer.from('第一章')
  const manifest = {
    formatVersion: 1,
    sourceSchemaVersion: 99,
    originProjectId: 'origin-project',
    snapshotGeneration: 'generation-1',
    createdAt: '2026-11-20T00:00:00.000Z',
    declaredUncompressedBytes: chapter.length,
    declaredCompressedBytes: chapter.length,
    entries: [{ path: 'chapter.txt', byteSize: chapter.length, sha256: sha256(chapter), disposition: 'author-content' }],
    semanticCounts: { chapters: 1 },
    omittedItems: [],
    transferReceiptIds: [],
    historyProjectionIds: [],
  }
  return storedZip([{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) }, { name: 'chapter.txt', bytes: chapter }])
}

function serveDav(fake) {
  const archive = newerArchive()
  const descriptor = { file: 'archive.ainovel', sha256: sha256(archive), byteSize: archive.length }
  const manifest = Buffer.from(JSON.stringify({
    version: 1, cloudBookId: CLOUD_BOOK, generationId: GENERATION, parentGenerationIds: [],
    createdAt: '2026-11-20T00:00:00.000Z', originProjectId: ORIGIN, portableSnapshotGeneration: 'snapshot-newer', archive: descriptor,
  }))
  const completion = Buffer.from(JSON.stringify({
    version: 1, cloudBookId: CLOUD_BOOK, generationId: GENERATION,
    manifest: { file: 'manifest.json', sha256: sha256(manifest), byteSize: manifest.length },
    archive: descriptor, completedAt: '2026-11-20T00:00:01.000Z',
  }))
  const generations = `/dav/books/${CLOUD_BOOK}/generations/`
  const files = new Map([
    [`${generations}${GENERATION}/archive.ainovel`, archive],
    [`${generations}${GENERATION}/manifest.json`, manifest],
    [`${generations}${GENERATION}/completion.json`, completion],
  ])
  const multistatus = hrefs => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs
    .map(href => `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>`).join('')}</d:multistatus>`
  fake.setScenarioRequestHandler((request, response) => {
    const url = request.url ?? ''
    if (!url.startsWith('/dav/')) return false
    if (request.method === 'PROPFIND') {
      const body = url === generations ? multistatus([generations, `${generations}${GENERATION}/`]) : multistatus([url])
      response.writeHead(207, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) }).end(body)
      return true
    }
    const body = files.get(url)
    if ((request.method === 'GET' || request.method === 'HEAD') && body) {
      response.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' })
      response.end(request.method === 'HEAD' ? undefined : body)
      return true
    }
    response.writeHead(404).end()
    return true
  })
  return `http://127.0.0.1:${fake.port}/dav/`
}

const LABELS = {
  'zh-CN': {
    settings: '设置分组', page: '项目备份', endpoint: 'WebDAV 地址', username: '用户名', secret: '密码或应用密钥', book: '云书标识',
    connect: '连接并绑定', refresh: '刷新云端世代', restore: '恢复所选云端世代为副本',
    expected: '没有新建副本。这个云端世代来自更新版本的书童。请先升级书童，再点「恢复所选云端世代为副本」。',
  },
  'en-US': {
    settings: 'Settings sections', page: 'Project backup', endpoint: 'WebDAV endpoint', username: 'Username', secret: 'Password or app secret', book: 'Cloud book ID',
    connect: 'Connect and bind', refresh: 'Refresh cloud generations', restore: 'Restore selected cloud generation as a copy',
    expected: 'No copy was created. This cloud generation was made by a newer version of Pagekin. Update Pagekin, then click Restore selected cloud generation as a copy again.',
  },
}

async function restoreNewerGeneration(context, locale) {
  const { app, page, roots, shoot, fake } = context
  const labels = LABELS[locale]
  const parent = path.join(roots.projects, 'restore-here')
  fs.mkdirSync(parent)
  const endpoint = serveDav(fake)
  await stage.openAfterRestart(page, BOOK)
  await stage.openSettings(page)
  if (locale === 'en-US') {
    await stage.root(page).getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '外观', exact: true }).click()
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.waitForFunction(() => document.documentElement.lang === 'en-US')
  }
  await stage.root(page).getByRole('navigation', { name: labels.settings }).getByRole('button', { name: labels.page, exact: true }).click()
  const panel = stage.root(page).locator('[data-testid="project-backup-panel"]')
  await panel.getByLabel(labels.endpoint).fill(endpoint)
  await panel.getByLabel(labels.username).fill('writer')
  await panel.getByLabel(labels.secret).fill('loopback-secret')
  await panel.getByLabel(labels.book).fill(CLOUD_BOOK)
  await panel.getByRole('button', { name: labels.connect, exact: true }).click()
  await panel.getByRole('button', { name: labels.refresh, exact: true }).click()
  await panel.locator(`input[value="${GENERATION}"]`).check()
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, parent)
  await panel.getByRole('button', { name: labels.restore, exact: true }).click()
  const shown = panel.locator('p[role="alert"]').filter({ hasText: labels.expected })
  await shown.waitFor({ state: 'visible', timeout: 60_000 })
  assert.deepEqual(fs.readdirSync(parent), [], '没有留下副本或暂存')
  await shoot(`errl3-cloud-newer-${locale}`)
  return { shown: (await shown.innerText()).trim(), leftInParent: fs.readdirSync(parent) }
}

export const ERRL3_SCENARIOS = {
  'errl3-cloud-newer-zh': { model: true, shell: 'stage', setup: async context => {
    await seedLargeBook(context, 1)
  }, run: context => restoreNewerGeneration(context, 'zh-CN') },
  'errl3-cloud-newer-en': { model: true, shell: 'stage', setup: async context => {
    await seedLargeBook(context, 1)
  }, run: context => restoreNewerGeneration(context, 'en-US') },
}
