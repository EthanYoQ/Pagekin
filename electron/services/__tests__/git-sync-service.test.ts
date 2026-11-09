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

  it('远端被另一台更新过时，上传自动接上而不是覆盖，也不把自己卡死在分叉', async () => {
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
    const pushed = await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    // 本机这一版为准，但对方的提交没被抹掉，远端历史里两笔都在。
    expect(pushed.committed).toBe(true)
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a2')
    const remoteLog = await run(library, ['log', '--format=%s', 'origin/main'])
    expect(remoteLog).toContain('from B')
    // 关键：远端和本机是同一个提交，不再分叉，下一次拉取能正常快进。
    // 这里查远端真实状态，而不是本地的 origin/main 引用——测试里推完不会自动前移它。
    const remoteHead = (await run(library, ['ls-remote', 'origin', 'refs/heads/main'])).split('\t')[0]
    const localHead = (await run(library, ['rev-parse', 'HEAD'])).trim()
    expect(remoteHead).toBe(localHead)
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

describe('分叉自愈：上传时按书合并', () => {
  /** 造一个「本机 + 另一台 + 远端」的三方局面 */
  async function setup(label: string) {
    const workspace = temporaryRoot(label)
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
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })
    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    return { workspace, remote, library, other, service }
  }

  it('对方改了别的书：本机上传自动接上，不丢对方那本', async () => {
    const { remote, library, other, service } = await setup('reconcile-disjoint')
    // 另一台改书乙
    fs.writeFileSync(path.join(other, '书乙', '.ai-novel', 'project.db'), 'db-b-from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B 改书乙'])
    await run(other, ['push', 'origin', 'HEAD:main'])
    // 本机改书甲
    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'db-a-from-A')

    let reconciled: { kept: readonly string[]; took: readonly string[] } | null = null
    const pushed = await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
      afterReconcile: async (_changed, keptLocal, tookRemote) => {
        reconciled = { kept: keptLocal, took: tookRemote }
      },
    })
    expect(pushed.committed).toBe(true)
    // 书甲只有本机改过 → 保留；书乙只有对方改过 → 取对方。
    expect(reconciled).toEqual({ kept: ['书甲'], took: ['书乙'] })
    // 本机书甲保住、书乙拿到对方的版本
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a-from-A')
    expect(fs.readFileSync(path.join(library, '书乙', '.ai-novel', 'project.db'), 'utf8')).toBe('db-b-from-B')
    // 远端历史里两笔都在，没有丢
    const log = await run(library, ['log', '--format=%s', 'origin/main'])
    expect(log).toContain('B 改书乙')
    expect(log).toContain('书甲')
  })

  it('两边改同一本书：以本机为准，对方那版仍在历史里可找回', async () => {
    const { remote, library, other, service } = await setup('reconcile-same-book')
    fs.writeFileSync(path.join(other, '书甲', '.ai-novel', 'project.db'), 'db-a-from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B 改书甲'])
    await run(other, ['push', 'origin', 'HEAD:main'])
    const remoteShaBefore = (await run(other, ['rev-parse', 'HEAD'])).trim()
    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'db-a-from-A')

    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲')], snapshot: async () => {},
    })
    // 以本机为准
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a-from-A')
    // 对方的提交对象还活着，能查回来
    const found = await run(library, ['cat-file', '-t', remoteShaBefore])
    expect(found.trim()).toBe('commit')
    const log = await run(library, ['log', '--format=%s', 'origin/main'])
    expect(log).toContain('B 改书甲')
  })

  it('以远端为准：本机退回远端版本，本机提交留成备份分支', async () => {
    const { library, other, service } = await setup('follow-remote')
    fs.writeFileSync(path.join(other, '书甲', '.ai-novel', 'project.db'), 'db-a-from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B 改书甲'])
    await run(other, ['push', 'origin', 'HEAD:main'])
    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'db-a-local-mistake')
    await run(library, ['add', '-A'])
    await run(library, ['commit', '-q', '-m', 'A 本地误操作'])

    const localMistakeSha = (await run(library, ['rev-parse', 'HEAD'])).trim()
    const followed = await service.followRemote({
      workTree: library, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      afterCheckout: async () => {},
    })
    expect(followed.updated).toBe(true)
    expect(followed.backupRef).toMatch(/^pagekin-backup\//u)
    // 内容回到远端那版
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a-from-B')
    // 本地误操作那一笔没丢：备份分支指向它
    const backupSha = (await run(library, ['rev-parse', followed.backupRef as string])).trim()
    expect(backupSha).toBe(localMistakeSha)
  })
})

describe('卡在分叉时的两条出路（pull + resolve）', () => {
  /**
   * 复现用户遇到的真实现场：本机提交已经落下（旧版 push 顺序的后果），
   * 远端也有另一台的提交，于是本地「拉不动、推不上」。
   */
  async function stuck(label: string) {
    const workspace = temporaryRoot(label)
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
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })
    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    // 另一台改书乙并推上去
    fs.writeFileSync(path.join(other, '书乙', '.ai-novel', 'project.db'), 'db-b-from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B 改书乙'])
    await run(other, ['push', 'origin', 'HEAD:main'])
    // 本机改书甲并本地提交（模拟旧版 push 已经提交、却没推上去）
    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'db-a-from-A')
    await run(library, ['add', '-A'])
    await run(library, ['commit', '-q', '-m', 'A 本地提交'])
    // 确认现在确实卡住了：普通拉取被拒
    await expect(service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')],
      afterCheckout: async () => {},
    })).rejects.toMatchObject({ code: 'GIT_SYNC_DIVERGED' })
    return { remote, library, other, service }
  }

  it('以本机为准：即使本机有未上传改动也必须成功（不能报「请先上传」）', async () => {
    const { remote, library, service } = await stuck('stuck-local')
    let touched: readonly string[] = []
    // 关键回归点：本机有未上传改动时，pull 会以 GIT_SYNC_LOCAL_CHANGES 拒绝；
    // 「以本机为准」必须绕开那道检查，否则用户点了按钮只会看到「请先上传再拉取」。
    const resolved = await service.forceUpload({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')],
      snapshot: async () => {},
      afterReconcile: async (_changed, _kept, took) => { touched = took },
    })
    expect(resolved.committed).toBe(true)
    // 书甲是本机改的，保住；书乙取回对方的版本
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a-from-A')
    expect(fs.readFileSync(path.join(library, '书乙', '.ai-novel', 'project.db'), 'utf8')).toBe('db-b-from-B')
    expect(touched).toContain('书乙')
    // 推上去了，远端和本机一致，从此可以正常快进
    const remoteHead = (await run(library, ['ls-remote', 'origin', 'refs/heads/main'])).split('\t')[0]
    expect(remoteHead).toBe((await run(library, ['rev-parse', 'HEAD'])).trim())
    const again = await service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], afterCheckout: async () => {},
    })
    expect(again.updated).toBe(false)
  })

  it('以远端为准：本机退回远端，自己的提交留成备份分支', async () => {
    const { library, service } = await stuck('stuck-remote')
    const localSha = (await run(library, ['rev-parse', 'HEAD'])).trim()
    const resolved = await service.followRemote({
      workTree: library, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      afterCheckout: async () => {},
    })
    expect(resolved.updated).toBe(true)
    expect(resolved.backupRef).toMatch(/^pagekin-backup\//u)
    // 本机的书甲改动被远端版覆盖
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a1')
    expect(fs.readFileSync(path.join(library, '书乙', '.ai-novel', 'project.db'), 'utf8')).toBe('db-b-from-B')
    // 本地那笔没丢
    expect((await run(library, ['rev-parse', resolved.backupRef as string])).trim()).toBe(localSha)
  })
})

describe('分叉时工作区不干净也不能失败', () => {
  it('工作区有未提交的 .gitignore 时，以本机为准仍能合并并推上去', async () => {
    const workspace = temporaryRoot('dirty-reconcile')
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
    await service.push({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })
    const other = path.join(workspace, 'other')
    await run(workspace, ['clone', remote, other])
    await run(other, ['config', 'user.name', 'B'])
    await run(other, ['config', 'user.email', 'b@example.test'])
    fs.writeFileSync(path.join(other, '书乙', '.ai-novel', 'project.db'), 'db-b-from-B')
    await run(other, ['add', '-A'])
    await run(other, ['commit', '-q', '-m', 'B 改书乙'])
    await run(other, ['push', 'origin', 'HEAD:main'])

    fs.writeFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'db-a-from-A')
    await run(library, ['add', '-A'])
    await run(library, ['commit', '-q', '-m', 'A 改书甲'])
    // 关键：工作区里留一个未提交的脏文件。旧实现用 `git merge`，
    // 会被它挡住并报「分叉」，用户点了按钮却什么都做不了。
    fs.writeFileSync(path.join(library, '.gitignore'), '# dirty\n*.db-wal\n')

    const forced = await service.forceUpload({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })
    expect(forced.committed).toBe(true)
    expect(forced.keptLocal).toContain('书甲')
    expect(forced.tookRemote).toContain('书乙')
    // 书甲保住本机版，书乙取回远端版
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a-from-A')
    expect(fs.readFileSync(path.join(library, '书乙', '.ai-novel', 'project.db'), 'utf8')).toBe('db-b-from-B')
    // 脏文件没被这次合并破坏
    expect(fs.readFileSync(path.join(library, '.gitignore'), 'utf8')).toContain('# dirty')
    // 远端已同步，不再分叉
    const remoteHead = (await run(library, ['ls-remote', 'origin', 'refs/heads/main'])).split('\t')[0]
    expect(remoteHead).toBe((await run(library, ['rev-parse', 'HEAD'])).trim())
  })
})

describe('没有共同祖先时也要能对齐', () => {
  it('本机与远端各自 init（无共同祖先）：本机有的书保留本机，本机没有的书从远端取回', async () => {
    const workspace = temporaryRoot('unrelated')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])

    // 远端那边：另一台机器独立 init 后推上去的，除书甲书乙外还有一本本机没有的书
    const otherLib = path.join(workspace, 'other-lib')
    writeBook(otherLib, '书甲', 'db-a-from-B')
    writeBook(otherLib, '书丙', 'db-c-remote-only')
    await run(otherLib, ['init', '-b', 'main'])
    await run(otherLib, ['config', 'user.name', 'B'])
    await run(otherLib, ['config', 'user.email', 'b@example.test'])
    await run(otherLib, ['add', '-A'])
    await run(otherLib, ['commit', '-q', '-m', 'B 的初始提交'])
    await run(otherLib, ['remote', 'add', 'origin', remote])
    await run(otherLib, ['push', '-q', 'origin', 'HEAD:main'])

    // 本机：也独立 init，历史与远端毫无关系；有书甲书乙，没有书丙
    const library = path.join(workspace, 'library')
    writeBook(library, '书甲', 'db-a-from-A')
    writeBook(library, '书乙', 'db-b-local-only')
    await run(library, ['init', '-b', 'main'])
    await run(library, ['config', 'user.name', 'A'])
    await run(library, ['config', 'user.email', 'a@example.test'])
    await run(library, ['add', '-A'])
    await run(library, ['commit', '-q', '-m', 'A 的初始提交'])
    await run(library, ['remote', 'add', 'origin', remote])

    const service = new GitSyncService()
    const forced = await service.forceUpload({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'A', authorEmail: 'a@example.test',
      books: [bookAt(library, '书甲'), bookAt(library, '书乙')], snapshot: async () => {},
    })
    expect(forced.committed).toBe(true)
    // 「以本机为准」：本机有的书保留本机版本（无共同祖先时无从判断谁更新）
    expect(fs.readFileSync(path.join(library, '书甲', '.ai-novel', 'project.db'), 'utf8')).toBe('db-a-from-A')
    expect(fs.readFileSync(path.join(library, '书乙', '.ai-novel', 'project.db'), 'utf8')).toBe('db-b-local-only')
    // 关键：本机根本没有的书不能因为合并而消失，必须从远端取回来
    expect(fs.readFileSync(path.join(library, '书丙', '.ai-novel', 'project.db'), 'utf8')).toBe('db-c-remote-only')
    expect(forced.tookRemote).toContain('书丙')
    // 已经推上去，不再分叉
    const remoteHead = (await run(library, ['ls-remote', 'origin', 'refs/heads/main'])).split('\t')[0]
    expect(remoteHead).toBe((await run(library, ['rev-parse', 'HEAD'])).trim())
  })
})

describe('拉取不能因为忽略规则凭空造出提交', () => {
  it('远端已有 .gitignore 时，本机拉取仍能快进（不再自己提交一个 .gitignore）', async () => {
    const workspace = temporaryRoot('exclude-not-committed')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])

    // 远端（另一台电脑）已经提交过 .gitignore
    const seed = path.join(workspace, 'seed')
    writeBook(seed, '保留的书', 'db-1')
    fs.writeFileSync(path.join(seed, '.gitignore'), '# from other machine\n*.db-wal\n')
    await run(seed, ['init', '-b', 'main'])
    await run(seed, ['config', 'user.name', 'S'])
    await run(seed, ['config', 'user.email', 's@example.test'])
    await run(seed, ['add', '-A'])
    await run(seed, ['commit', '-q', '-m', 'seed'])
    await run(seed, ['remote', 'add', 'origin', remote])
    await run(seed, ['push', '-q', 'origin', 'HEAD:main'])

    // 本机克隆下来后再拉取：初始化会把忽略规则写进 .git/info/exclude，
    // 绝不能提交一个新的 .gitignore，否则立刻与远端分叉。
    const library = path.join(workspace, 'library')
    await run(workspace, ['clone', '-q', remote, library])
    await run(library, ['config', 'user.name', 'L'])
    await run(library, ['config', 'user.email', 'l@example.test'])

    // 远端再前进一笔
    fs.writeFileSync(path.join(seed, '保留的书', '.ai-novel', 'project.db'), 'db-2')
    await run(seed, ['add', '-A'])
    await run(seed, ['commit', '-q', '-m', 'advance'])
    await run(seed, ['push', '-q', 'origin', 'HEAD:main'])

    const service = new GitSyncService()
    const pulled = await service.pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'L', authorEmail: 'l@example.test',
      books: [bookAt(library, '保留的书')],
      afterCheckout: async () => {},
    })
    expect(pulled.updated).toBe(true)
    expect(fs.readFileSync(path.join(library, '保留的书', '.ai-novel', 'project.db'), 'utf8')).toBe('db-2')
    // 本机不该多出任何提交
    const ahead = await run(library, ['rev-list', '--count', `origin/main..HEAD`])
    expect(ahead.trim()).toBe('0')
    // 忽略规则确实生效了（写在 .git/info/exclude，而不是仓库里）
    expect(fs.readFileSync(path.join(library, '.git', 'info', 'exclude'), 'utf8')).toContain('*.db-wal')
  })

  it('远端把本机打开的书删掉时，拉取仍然成功', async () => {
    const workspace = temporaryRoot('pull-deletes-book')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const seed = path.join(workspace, 'seed')
    writeBook(seed, '保留的书', 'db-1')
    await run(seed, ['init', '-b', 'main'])
    await run(seed, ['config', 'user.name', 'S'])
    await run(seed, ['config', 'user.email', 's@example.test'])
    await run(seed, ['add', '-A'])
    await run(seed, ['commit', '-q', '-m', 'seed'])
    await run(seed, ['remote', 'add', 'origin', remote])
    await run(seed, ['push', '-q', 'origin', 'HEAD:main'])

    const library = path.join(workspace, 'library')
    await run(workspace, ['clone', '-q', remote, library])
    await run(library, ['config', 'user.name', 'L'])
    await run(library, ['config', 'user.email', 'l@example.test'])
    writeBook(library, '会被删掉的书', 'temp')
    await run(library, ['add', '-A'])
    await run(library, ['commit', '-q', '-m', 'add temp'])
    await run(library, ['push', '-q', 'origin', 'HEAD:main'])

    // 远端删除这本书
    await run(seed, ['pull', '-q', 'origin', 'main'])
    fs.rmSync(path.join(seed, '会被删掉的书'), { recursive: true, force: true })
    await run(seed, ['add', '-A'])
    await run(seed, ['commit', '-q', '-m', 'remove temp'])
    await run(seed, ['push', '-q', 'origin', 'HEAD:main'])

    const books = listLibraryBooks(library)
    const pulled = await new GitSyncService().pull({
      workTree: library, remoteUrl: remote, branch: 'main', credentials: CREDENTIALS,
      authorName: 'L', authorEmail: 'l@example.test',
      books,
      afterCheckout: async () => {},
    })
    expect(pulled.updated).toBe(true)
    expect(pulled.changedBooks).toContain('会被删掉的书')
    expect(fs.existsSync(path.join(library, '会被删掉的书'))).toBe(false)
    expect(fs.existsSync(path.join(library, '保留的书', '.ai-novel', 'project.db'))).toBe(true)
  })
})

describe('已跟踪的 .gitignore 不能被同步流程改写', () => {
  it('多次 initialize 后，仓库里已跟踪的 .gitignore 内容不变、工作区保持干净', async () => {
    const workspace = temporaryRoot('ignore-untouched')
    const remote = path.join(workspace, 'remote.git')
    await run(workspace, ['init', '--bare', remote])
    const seed = path.join(workspace, 'seed')
    writeBook(seed, '书甲', 'db-1')
    // 仓库里的 .gitignore 故意「缺项」：旧实现会去补全它，于是每天都多出一条待上传改动。
    fs.writeFileSync(path.join(seed, '.gitignore'), '*.db-wal\n.DS_Store\n')
    await run(seed, ['init', '-b', 'main'])
    await run(seed, ['config', 'user.name', 'S'])
    await run(seed, ['config', 'user.email', 's@example.test'])
    await run(seed, ['add', '-A'])
    await run(seed, ['commit', '-q', '-m', 'seed'])
    await run(seed, ['remote', 'add', 'origin', remote])
    await run(seed, ['push', '-q', 'origin', 'HEAD:main'])

    const library = path.join(workspace, 'library')
    await run(workspace, ['clone', '-q', remote, library])
    await run(library, ['config', 'user.name', 'L'])
    await run(library, ['config', 'user.email', 'l@example.test'])

    const before = fs.readFileSync(path.join(library, '.gitignore'), 'utf8')
    const service = new GitSyncService()
    await service.initialize({ workTree: library, branch: 'main', authorName: 'L', authorEmail: 'l@example.test' })
    await service.initialize({ workTree: library, branch: 'main', authorName: 'L', authorEmail: 'l@example.test' })

    expect(fs.readFileSync(path.join(library, '.gitignore'), 'utf8')).toBe(before)
    // 关键：不能凭空多出「待上传」的文件
    const status = await run(library, ['status', '--porcelain'])
    expect(status.trim()).toBe('')
    // 忽略规则确实生效在 .git/info/exclude
    expect(fs.readFileSync(path.join(library, '.git', 'info', 'exclude'), 'utf8')).toContain('*.db-wal')
  })
})
