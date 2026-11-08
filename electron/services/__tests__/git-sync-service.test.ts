import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  GitSyncError,
  GitSyncService,
  SystemGitRunner,
  findLibraryRoot,
  listLibraryBooks,
  normalizeGitRemoteUrl,
  relativeBookPath,
  resolveGitSyncPaths,
  type LibraryBook,
} from '../git-sync-service'

/**
 * 用本机真实 git 跑通「书库 + 多本书」的上传 / 拉取，不是 mock：
 * 只提交有改动的书、拒绝分叉、拒绝脏工作区，这些行为只有真 git 才说得清。
 */

const roots: string[] = []
const git = new SystemGitRunner(60_000)

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pagekin-git-sync-${label}-`))
  roots.push(root)
  return root
}

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(['-c', 'core.quotePath=false', ...args], { cwd })
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** 造一本书：书库根下的一个子目录，带 .ai-novel/project.json 和 project.db。 */
function writeBook(libraryRoot: string, name: string, databaseBody: string): string {
  const bookRoot = path.join(libraryRoot, name)
  const storage = path.join(bookRoot, '.ai-novel')
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'ai-novel-project',
    projectId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-01-01T00:00:00.000Z',
    storageFormat: 'ai-novel',
    storageVersion: 1,
  }))
  fs.writeFileSync(path.join(storage, 'project.db'), databaseBody)
  return bookRoot
}

function bookAt(libraryRoot: string, name: string): LibraryBook {
  return { relativePath: name, rootPath: path.join(libraryRoot, name), name }
}

const CREDENTIALS = { username: 'writer', token: 'unused-token' }

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('git 作品同步（书库 + 多本书）', () => {
  it('只提交真正改过的那本书，没动的书不产生提交', async () => {
    const workspace = temporaryRoot('per-book')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    writeBook(library, '书乙', 'db-b1')

    const service = new GitSyncService()
    await service.initialize({
      workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main',
      authorName: 'A', authorEmail: 'a@example.test',
    })
    await run(library, ['remote', 'set-url', 'origin', remote])

    // 第一轮：两本都是新的，应该都进提交。
    const first = await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')],
      snapshot: async () => {},
    })
    expect(first.committed).toBe(true)
    expect(first.uploaded.map(entry => entry.relativePath).sort()).toEqual(['书乙', '书甲'])

    // 第二轮：只改书甲。
    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'db-a2')
    const second = await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')],
      snapshot: async () => {},
    })
    expect(second.committed).toBe(true)
    // 只有书甲被提交，书乙连暂存都没进。
    expect(second.uploaded).toEqual([
      { relativePath: '书甲', committed: true },
      { relativePath: '书乙', committed: false },
    ])
    const log = await run(library, ['log', '--format=%s', '-2'])
    expect(log).toContain('书甲')
    expect(log.split('\n')[0]).not.toContain('书乙')
  })

  it('新电脑首次上传：本地已有提交但远端为空时，也要把历史推上去', async () => {
    const workspace = temporaryRoot('fresh-remote')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    // 模拟「新电脑」：本地早就提交过（书库原本就在这台机器上），远端仓库是刚建的空仓库。
    await run(library, ['add', '-A'])
    await run(library, ['commit', '-q', '-m', '新电脑本地书库'])

    const result = await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    // 这次没有新提交，但本地历史必须已经推到远端。
    expect(result.committed).toBe(false)
    const remoteLog = await run(library, ['log', '--oneline', `origin/main`])
    expect(remoteLog).toContain('新电脑本地书库')
    const remoteFiles = await run(library, ['ls-tree', '-r', '--name-only', 'origin/main'])
    expect(remoteFiles).toContain('书甲/.ai-novel/project.db')
  })

  it('全都没改动时不产生新提交', async () => {
    const workspace = temporaryRoot('noop')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    const push = () => service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    await push()
    const before = await run(library, ['rev-parse', 'HEAD'])
    const again = await push()
    expect(again.committed).toBe(false)
    expect(again.commit).toBeNull()
    expect(await run(library, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('远端被另一台更新时拒绝上传，而不是覆盖', async () => {
    const workspace = temporaryRoot('diverged')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })

    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    fs.writeFileSync(path.join(other, '书甲', '.ai-novel', 'project.db'), 'db-from-b')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'from B'])
    await run(other, ['push', 'origin', 'HEAD:main'])

    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'db-a2')
    await expect(service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })).rejects.toMatchObject({ code: 'GIT_SYNC_DIVERGED' })
  })

  it('拉取只做快进，并报告哪些书变了', async () => {
    const workspace = temporaryRoot('pull')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    writeBook(library, '书乙', 'db-b1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })

    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    fs.writeFileSync(path.join(other, '书乙', '.ai-novel', 'project.db'), 'db-b2')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'from B on 书乙'])
    await run(other, ['push', 'origin', 'HEAD:main'])

    let reported: readonly string[] = []
    const pulled = await service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      afterCheckout: async changedBooks => { reported = changedBooks },
    })
    expect(pulled.updated).toBe(true)
    expect(pulled.changedBooks).toEqual(['书乙'])
    expect(reported).toEqual(['书乙'])
    expect(fs.readFileSync(path.join(library, '书乙', '.ai-novel', 'project.db'), 'utf8')).toBe('db-b2')
  })

  it('远端没有新内容时，本地改动不会被当成冲突', async () => {
    const workspace = temporaryRoot('dirty-noop')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'local-edit')
    const pulled = await service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], afterCheckout: async () => {},
    })
    expect(pulled.updated).toBe(false)
    // 本机改动原样保留，没被覆盖
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('local-edit')
  })

  it('拉取只覆盖远端改过的那本，另一本逐字节不变（含修改时间）', async () => {
    const workspace = temporaryRoot('isolate')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    writeBook(library, '书乙', 'db-b1')
    // 书乙里再放一份「作者原稿」，确保它有多字节内容
    fs.writeFileSync(path.join(library, '书乙', '.ai-novel', '原稿.txt'), '这是书乙的内容\n第二行\n')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })

    const untouched = path.join(library, '书乙', '.ai-novel', '原稿.txt')
    const before = {
      hash: createHash('sha256').update(fs.readFileSync(untouched)).digest('hex'),
      mtime: fs.statSync(untouched).mtimeMs,
      ino: fs.statSync(untouched).ino,
    }

    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    fs.writeFileSync(path.join(other, '书甲', '.ai-novel', 'project.db'), 'db-a2-from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B 只改了书甲'])
    await run(other, ['push', 'origin', 'HEAD:main'])

    const pulled = await service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')],
      afterCheckout: async () => {},
    })
    expect(pulled.changedBooks).toEqual(['书甲'])
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a2-from-B')
    // 书乙：内容、修改时间、inode 都不该被动过。
    expect(createHash('sha256').update(fs.readFileSync(untouched)).digest('hex')).toBe(before.hash)
    expect(fs.statSync(untouched).mtimeMs).toBe(before.mtime)
    expect(fs.statSync(untouched).ino).toBe(before.ino)
  })

  it('本机有未上传改动的书，若远端不动它，拉取照常进行', async () => {
    const workspace = temporaryRoot('partial-dirty')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    writeBook(library, '书乙', 'db-b1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })

    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    fs.writeFileSync(path.join(other, '书甲', '.ai-novel', 'project.db'), 'db-a2-from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B 改了书甲'])
    await run(other, ['push', 'origin', 'HEAD:main'])

    // 本机书乙还没上传：git 里是脏的（模拟写到一半）
    fs.writeFileSync(path.join(library, '书乙', '.ai-novel', '原稿.txt'), '本机未上传的草稿')
    const pulled = await service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')],
      afterCheckout: async () => {},
    })
    expect(pulled.changedBooks).toEqual(['书甲'])
    // 书乙的本地草稿还在
    expect(fs.readFileSync(path.join(library, '书乙', '.ai-novel', '原稿.txt'), 'utf8')).toBe('本机未上传的草稿')
  })

  it('同一本既没上传又被远端改动时，拒绝拉取并点名这本书', async () => {
    const workspace = temporaryRoot('conflict')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    fs.writeFileSync(path.join(other, '书甲', '.ai-novel', 'project.db'), 'from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B'])
    await run(other, ['push', 'origin', 'HEAD:main'])

    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'local-edit')
    await expect(service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], afterCheckout: async () => {},
    })).rejects.toMatchObject({ code: 'GIT_SYNC_LOCAL_CHANGES', detail: '书甲' })
  })

  it('没合并进库的 -wal 也算「还没上传」，不会被拉取悄悄覆盖', async () => {
    const workspace = temporaryRoot('wal-dirty')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    const bookRoot = writeBook(library, '书甲', 'db-a1')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    // 只有 WAL 有内容，git status 是干净的
    fs.writeFileSync(path.join(bookRoot, '.ai-novel', 'project.db-wal'), 'new-writes-in-wal')
    const dirty = await service.dirtyBookPaths(library, [bookAt(library, '书甲')])
    expect(dirty).toEqual(['书甲'])
  })

  it('运行时文件被忽略，不会跟着上传', async () => {
    const workspace = temporaryRoot('ignore')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const library = path.join(workspace, 'library')
    const bookRoot = writeBook(library, '书甲', 'db-a1')
    fs.writeFileSync(path.join(bookRoot, '.ai-novel', 'project.db-wal'), 'wal-bytes')
    fs.writeFileSync(path.join(bookRoot, '.ai-novel', 'project.db-shm'), 'shm-bytes')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, remoteUrl: 'https://example.test/library.git', branch: 'main', authorName: 'A', authorEmail: 'a@example.test' })
    await run(library, ['remote', 'set-url', 'origin', remote])
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    const tracked = await run(library, ['ls-files'])
    expect(tracked).toContain('书甲/.ai-novel/project.db')
    expect(tracked.split('\n').some(line => line.endsWith('-wal') || line.endsWith('-shm'))).toBe(false)
  })
})

describe('书库发现', () => {
  it('找到作品上层的 git 仓库作为书库根', () => {
    const workspace = temporaryRoot('discover')
    const library = path.join(workspace, 'library')
    const bookRoot = writeBook(library, '书甲', 'db')
    fs.mkdirSync(path.join(library, '.git'), { recursive: true })
    expect(findLibraryRoot(bookRoot)).toBe(library)
    expect(findLibraryRoot(path.join(workspace, '无书库'))).toBeNull()
  })

  it('只把第一层、且带 .ai-novel/project.json 的目录当作书', () => {
    const workspace = temporaryRoot('list')
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db')
    writeBook(library, '书乙', 'db')
    fs.mkdirSync(path.join(library, '空文件夹'), { recursive: true })
    fs.mkdirSync(path.join(library, '.hidden'), { recursive: true })
    const books = listLibraryBooks(library)
    expect(books.map(book => book.relativePath).sort()).toEqual(['书乙', '书甲'])
  })

  it('相对路径拒绝越界', () => {
    expect(relativeBookPath('/library', '/library/书甲')).toBe('书甲')
    expect(() => relativeBookPath('/library', '/elsewhere/书甲')).toThrow(GitSyncError)
    expect(() => relativeBookPath('/library', '/library')).toThrow(GitSyncError)
  })
})

describe('地址与路径', () => {
  it('只接受干净的 https 地址', () => {
    expect(normalizeGitRemoteUrl('https://github.com/me/library')).toBe('https://github.com/me/library.git')
    expect(normalizeGitRemoteUrl('https://github.com/me/library.git')).toBe('https://github.com/me/library.git')
    for (const bad of ['git@github.com:me/library.git', 'http://github.com/me/library', 'https://user:pass@github.com/me/library']) {
      expect(() => normalizeGitRemoteUrl(bad)).toThrow(GitSyncError)
    }
  })

  it('作品根解析出 .ai-novel 与 project.db', () => {
    const paths = resolveGitSyncPaths('/library/书甲')
    expect(paths.workTree).toBe('/library/书甲')
    expect(paths.storageRoot).toBe('/library/书甲/.ai-novel')
    expect(paths.databasePath).toBe('/library/书甲/.ai-novel/project.db')
  })

  it('配了代理就把代理传给 git 子进程（git 只认环境变量）', async () => {
    const calls: Array<Record<string, string>> = []
    const service = new GitSyncService({
      proxyUrl: () => 'http://127.0.0.1:7897',
      runner: {
        run: async (args, options) => {
          if (args.includes('rev-parse')) calls.push({ ...(options.env as unknown as Record<string, string>) })
          return { stdout: 'true', stderr: '', code: 0 }
        },
      },
    })
    await service.isInitialized('/tmp/whatever')
    expect(calls[0]?.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(calls[0]?.https_proxy).toBe('http://127.0.0.1:7897')
  })
})
