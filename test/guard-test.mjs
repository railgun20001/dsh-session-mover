/**
 * dsh-session-mover —— 写路径护栏与移动日志的单元测试。
 *
 * 覆盖三类风险：
 *   1. **写前修复**：官方 `mutate()` 会按内存索引剪枝。索引过期时（头文件 cwd
 *      重建、崩溃回滚等），一次无关的改名就会把移动过的会话从账本里永久删掉；
 *      护栏必须在写之前把索引修回来。
 *   2. **attach 接管**：`attachSession()` 要求 header.cwd 等于目标项目目录，
 *      移动过的会话（header 仍指向旧目录）和它的分叉子会话都会被拒绝；
 *      只有在账本能证明归属时才允许绕过，其它情况必须继续抛错。
 *   3. **日志存取**：记录/读取/损坏容错。
 *
 * 运行：node test/guard-test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adoptManagedAttach, installEntityGuards, repairManagedPaths } from '../lib/guards.js'
import { createJournalStore, normalizeJournal, resolveJournalPath } from '../lib/journal.js'

/**
 * 造一个最小的 workspace 实体替身。
 *
 * 语义刻意贴近官方实现：
 *   - `sessionIds` getter 按内存索引过滤（等价于 `candidateMatches`）；
 *   - `mutate()` 写回时同样按索引剪枝；
 *   - `attachSession()` 要求 header.cwd 等于本 workspace 的 record.path。
 */
class MockEntity {
  /**
   * @param {object} registry - 注册表替身。
   * @param {string} id - workspace 标识。
   */
  constructor(registry, id) {
    this.registry = registry
    this.id = id
  }

  get record() {
    return this.registry.record(this.id)
  }

  get path() {
    return this.record.path
  }

  get title() {
    return this.record.title
  }

  get sessionIds() {
    const record = this.record
    return record.sessionIds.filter((id) => this.registry.paths.get(id) === record.path)
  }

  get host() {
    return this.registry.host
  }

  async mutate(change) {
    const current = this.record
    const changed = change(current)
    const next = {
      ...changed,
      sessionIds: changed.sessionIds.filter((id) => this.registry.paths.get(id) === changed.path),
    }
    const sameIds = next.sessionIds.length === current.sessionIds.length
      && next.sessionIds.every((id, index) => id === current.sessionIds[index])
    if (sameIds && next.title === current.title) return
    this.registry.setRecord(this.id, next)
  }

  async attachSession(sessionId) {
    const record = this.record
    if (!record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) throw new Error(`cannot attach '${sessionId}': header has no cwd`)
      if (header.cwd !== record.path) throw new Error(`cannot attach '${sessionId}': its cwd resolves to '${header.cwd}'`)
      this.host.rememberSessionPath(sessionId, header.cwd)
    }
    await this.mutate((current) => (
      current.sessionIds.includes(sessionId) ? current : { ...current, sessionIds: [sessionId, ...current.sessionIds] }
    ))
  }
}

/**
 * 造一个注册表替身。
 *
 * @param {{
 *   workspaces: Array<{ id: string, title: string, path: string, sessionIds: string[] }>,
 *   sessionPaths?: Record<string, string>,
 *   headers?: Record<string, object>,
 * }} input - 初始状态。
 * @returns {object} 注册表替身。
 */
function createMockRegistry(input) {
  const table = new Map()
  const entities = new Map()
  const paths = new Map(Object.entries(input.sessionPaths ?? {}))
  const headers = new Map(Object.entries(input.headers ?? {}))
  const host = {
    candidateMatches: (id, path) => paths.get(id) === path,
    async readSessionHeader(id) {
      const header = headers.get(id)
      if (header === undefined) throw new Error(`no header for '${id}'`)
      return header
    },
    rememberSessionPath(id, path) {
      paths.set(id, path)
    },
  }
  const registry = {
    table: { get: (id) => table.get(id) },
    sessionPaths: paths,
    paths,
    headers,
    entities,
    host,
    record: (id) => table.get(id),
    setRecord: (id, record) => table.set(id, record),
    get: (id) => entities.get(id),
    list: () => [...entities.values()],
  }
  for (const workspace of input.workspaces) {
    table.set(workspace.id, {
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    entities.set(workspace.id, new MockEntity(registry, workspace.id))
  }
  return registry
}

/** 收集一组断言并打印结果。 */
const cases = []

/**
 * 注册一个测试用例。
 *
 * @param {string} name - 用例名。
 * @param {() => Promise<void> | void} run - 用例体。
 */
function test(name, run) {
  cases.push({ name, run })
}

/**
 * 造一个临时目录并在结束时删除。
 *
 * @param {(dir: string) => void | Promise<void>} run - 用例体。
 * @returns {Promise<void>} 完成。
 */
async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-guard-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('未装护栏时，一次无关改名会把索引过期的会话从账本里剪掉（对照组）', async () => {
  const registry = createMockRegistry({
    workspaces: [{ id: 'B', title: 'B', path: 'C:/B', sessionIds: ['s1', 's2'] }],
    sessionPaths: { s1: 'C:/A', s2: 'C:/B' },
  })
  await registry.get('B').mutate((record) => ({ ...record, title: 'B2' }))
  assert.deepEqual(registry.record('B').sessionIds, ['s2'])
})

test('写前修复把账本归属灌回索引，改名后会话仍在', async () => {
  await withTempDir((dir) => {
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: 'C:/B', from: 'C:/A', kind: 'move' })
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: 'C:/B', sessionIds: ['s1', 's2'] }],
      sessionPaths: { s1: 'C:/A', s2: 'C:/B' },
    })
    const guards = installEntityGuards({ registry, journal })
    assert.equal(guards.installed, true)
    assert.equal(repairManagedPaths(registry, journal), 1)
    return registry.get('B').mutate((record) => ({ ...record, title: 'B2' })).then(() => {
      assert.deepEqual(registry.record('B').sessionIds, ['s1', 's2'])
      guards.dispose()
    })
  })
})

test('写前修复只处理日志里的会话，普通死会话仍会被官方剪枝', async () => {
  await withTempDir((dir) => {
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: 'C:/B', from: 'C:/A' })
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: 'C:/B', sessionIds: ['s1', 'ghost'] }],
      sessionPaths: { s1: 'C:/A' },
    })
    const guards = installEntityGuards({ registry, journal })
    return registry.get('B').mutate((record) => ({ ...record, title: 'B2' })).then(() => {
      // s1 被修复保留，ghost 没有日志记录且索引缺失 → 按官方语义剪掉。
      assert.deepEqual(registry.record('B').sessionIds, ['s1'])
      guards.dispose()
    })
  })
})

test('分叉子会话（header 仍指向旧目录）能按账本接管 attach', async () => {
  await withTempDir((dir) => {
    const journal = createJournalStore(join(dir, 'journal.json'))
    // 父会话 p 已在 B；子会话 c 的 header cwd 仍是 A。
    journal.record('p', { path: 'C:/B', from: 'C:/A' })
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: 'C:/B', sessionIds: ['p'] }],
      sessionPaths: { p: 'C:/B', c: 'C:/A' },
      headers: { c: { cwd: 'C:/A', isSeeded: true, parentSession: 'p' } },
    })
    const guards = installEntityGuards({ registry, journal })
    return registry.get('B').attachSession('c').then(() => {
      assert.deepEqual(registry.record('B').sessionIds, ['c', 'p'])
      assert.equal(registry.paths.get('c'), 'C:/B')
      assert.equal(journal.entry('c').kind, 'fork')
      guards.dispose()
    })
  })
})

test('与账本无关的会话仍按官方规则拒绝 attach', async () => {
  await withTempDir((dir) => {
    const journal = createJournalStore(join(dir, 'journal.json'))
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: 'C:/B', sessionIds: [] }],
      sessionPaths: { x: 'C:/A' },
      headers: { x: { cwd: 'C:/A' } },
    })
    const guards = installEntityGuards({ registry, journal })
    return assert.rejects(() => registry.get('B').attachSession('x'), /cannot attach/).then(() => {
      assert.deepEqual(registry.record('B').sessionIds, [])
      guards.dispose()
    })
  })
})

test('plugin 卸载后还原原型方法（补丁可重入）', async () => {
  await withTempDir((dir) => {
    const journal = createJournalStore(join(dir, 'journal.json'))
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: 'C:/B', sessionIds: [] }],
    })
    const proto = Object.getPrototypeOf(registry.get('B'))
    const before = proto.mutate
    const first = installEntityGuards({ registry, journal })
    const second = installEntityGuards({ registry, journal })
    assert.equal(first.installed, true)
    assert.equal(second.reason, 'already')
    first.dispose()
    assert.notEqual(proto.mutate, before, '第一次卸载不应还原（还有一份引用）')
    second.dispose()
    assert.equal(proto.mutate, before)
  })
})

test('日志：写入后重新加载能读回，损坏文件按空日志处理', async () => {
  await withTempDir((dir) => {
    const file = join(dir, 'nested', 'journal.json')
    const journal = createJournalStore(file)
    journal.record('s1', { path: 'C:/B', from: 'C:/A', kind: 'move' })
    assert.equal(journal.save(), true)
    const reloaded = createJournalStore(file)
    assert.deepEqual(reloaded.entry('s1').path, 'C:/B')
    assert.deepEqual(reloaded.entry('s1').from, 'C:/A')
    assert.equal(reloaded.entries().length, 1)

    writeFileSync(file, '{ not json', 'utf8')
    const broken = createJournalStore(file)
    assert.deepEqual(broken.entries(), [])
    // 损坏文件不能被覆盖成空日志之前就抛错：保存仍应成功。
    assert.equal(broken.save(), true)
    assert.match(readFileSync(file, 'utf8'), /"sessions"/)
  })
})

test('日志规整：丢弃缺 path 的条目与非对象', () => {
  const normalized = normalizeJournal({
    sessions: {
      a: { path: 'C:/A' },
      b: { from: 'C:/B' },
      c: null,
      d: { path: 'C:/D', from: 'C:/X', kind: 'fork' },
    },
  })
  assert.deepEqual(Object.keys(normalized.sessions).sort(), ['a', 'd'])
  assert.equal(normalized.sessions.d.kind, 'fork')
})

test('日志路径遵循 DSH_HOME', () => {
  const path = resolveJournalPath({ DSH_HOME: 'C:/custom-home' })
  assert.match(path.replace(/\\/g, '/'), /^C:\/custom-home\/dsh-session-mover\/journal-v1\.json$/)
})

test('adoptManagedAttach 在无法证明归属时返回 false，不抛错', async () => {
  await withTempDir(async (dir) => {
    const journal = createJournalStore(join(dir, 'journal.json'))
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: 'C:/B', sessionIds: [] }],
      sessionPaths: {},
      headers: {},
    })
    const adopted = await adoptManagedAttach({
      entity: registry.get('B'),
      sessionId: 'ghost',
      registry,
      journal,
    })
    assert.equal(adopted, false)
    assert.deepEqual(registry.record('B').sessionIds, [])
  })
})

/** 依次跑完全部用例。 */
let passed = 0
for (const item of cases) {
  try {
    await item.run()
    passed += 1
    console.log(`ok   ${item.name}`)
  } catch (error) {
    console.error(`FAIL ${item.name}`)
    console.error(error)
    process.exitCode = 1
  }
}
console.log(`\n${passed} / ${cases.length} 个用例通过`)
