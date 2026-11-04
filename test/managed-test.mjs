/**
 * dsh-session-mover —— 受管会话自检与还原的单元测试。
 *
 * 覆盖：
 *   1. 清单里的「目标目录/原目录是否存在」判定；
 *   2. 原项目还在时，还原 = 把会话记回原项目账本并清掉日志；
 *   3. 原项目已消失时，还原 = 从账本摘下、回到未分组；
 *   4. 一键还原的计数与逐条结果。
 *
 * 运行：node test/managed-test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJournalStore } from '../lib/journal.js'
import {
  inspectManagedSessions,
  pruneJournal,
  restoreAllManaged,
  restoreManagedSession,
  samePath,
  summarizeManaged,
} from '../lib/managed.js'

/**
 * 最小 workspace 实体替身：只实现还原路径用到的方法。
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
    if (record.sessionIds.includes(sessionId)) return
    const header = await this.host.readSessionHeader(sessionId)
    if (header.cwd !== record.path) throw new Error(`cannot attach '${sessionId}': cwd mismatch`)
    this.host.rememberSessionPath(sessionId, header.cwd)
    await this.mutate((current) => ({ ...current, sessionIds: [sessionId, ...current.sessionIds] }))
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
  const dir = mkdtempSync(join(tmpdir(), 'dsm-managed-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('清单：目标目录/原目录是否存在会被如实标出', async () => {
  await withTempDir(async (dir) => {
    const alive = join(dir, 'alive')
    mkdirSync(alive, { recursive: true })
    const gone = join(dir, 'gone')
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: alive, from: gone, kind: 'move' })
    journal.record('s2', { path: gone, from: alive, kind: 'fork' })
    const registry = createMockRegistry({
      workspaces: [
        { id: 'B', title: 'B', path: alive, sessionIds: ['s1'] },
        { id: 'C', title: 'C', path: gone, sessionIds: ['s2'] },
      ],
      sessionPaths: { s1: alive, s2: gone },
    })
    const rows = inspectManagedSessions({ registry, journal })
    assert.equal(rows.length, 2)
    const byId = Object.fromEntries(rows.map((row) => [row.sessionId, row]))
    assert.equal(byId.s1.targetExists, true)
    assert.equal(byId.s1.sourceExists, false)
    assert.equal(byId.s2.targetExists, false)
    assert.equal(byId.s2.sourceExists, true)
    assert.deepEqual(summarizeManaged(rows), { total: 2, targetMissing: 1, sourceMissing: 1 })
  })
})

test('清单跳过账本里已不存在的会话（陈旧日志）', async () => {
  await withTempDir(async (dir) => {
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('stale', { path: join(dir, 'x') })
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: join(dir, 'b'), sessionIds: [] }],
    })
    assert.deepEqual(inspectManagedSessions({ registry, journal }), [])
  })
})

test('清单跳过日志指向与账本不一致的陈旧条目', async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, 'A')
    const b = join(dir, 'B')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: b, from: a, kind: 'move' })
    // 会话已经被拖回 A：日志还停在 B，应当视为陈旧，不再算受管。
    const registry = createMockRegistry({
      workspaces: [{ id: 'A', title: 'A', path: a, sessionIds: ['s1'] }],
      sessionPaths: { s1: a },
    })
    assert.deepEqual(inspectManagedSessions({ registry, journal }), [])
    const result = await restoreManagedSession({ registry, journal, sessionId: 's1' })
    assert.equal(result.restored, false)
    assert.equal(result.reason, 'journal/stale')
    assert.deepEqual(registry.record('A').sessionIds, ['s1'])
    assert.equal(journal.entry('s1'), null)
  })
})

test('还原：原项目还在 → 记回原项目并清掉日志', async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, 'A')
    const b = join(dir, 'B')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: b, from: a, kind: 'move' })
    const registry = createMockRegistry({
      workspaces: [
        { id: 'A', title: 'A', path: a, sessionIds: [] },
        { id: 'B', title: 'B', path: b, sessionIds: ['s1'] },
      ],
      sessionPaths: { s1: b },
      headers: { s1: { cwd: a } },
    })
    const result = await restoreManagedSession({ registry, journal, sessionId: 's1' })
    assert.equal(result.restored, true)
    assert.equal(result.to?.id, 'A')
    assert.deepEqual(registry.record('A').sessionIds, ['s1'])
    assert.deepEqual(registry.record('B').sessionIds, [])
    assert.equal(journal.entry('s1'), null)
  })
})

test('还原：原项目已消失 → 从账本摘下、回到未分组', async () => {
  await withTempDir(async (dir) => {
    const b = join(dir, 'B')
    mkdirSync(b, { recursive: true })
    const gone = join(dir, 'gone')
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: b, from: gone, kind: 'move' })
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: b, sessionIds: ['s1', 's2'] }],
      sessionPaths: { s1: b, s2: b },
      headers: { s1: { cwd: gone } },
    })
    const result = await restoreManagedSession({ registry, journal, sessionId: 's1' })
    assert.equal(result.restored, true)
    assert.equal(result.to, null)
    assert.deepEqual(registry.record('B').sessionIds, ['s2'])
    assert.equal(registry.paths.has('s1'), false)
    assert.equal(journal.entry('s1'), null)
  })
})

test('还原：原目录未知时只清日志、不动账本', async () => {
  await withTempDir(async (dir) => {
    const b = join(dir, 'B')
    mkdirSync(b, { recursive: true })
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: b })
    const registry = createMockRegistry({
      workspaces: [{ id: 'B', title: 'B', path: b, sessionIds: ['s1'] }],
      sessionPaths: { s1: b },
      headers: { s1: {} },
    })
    const result = await restoreManagedSession({ registry, journal, sessionId: 's1' })
    assert.equal(result.restored, false)
    assert.equal(result.reason, 'home/unknown')
    assert.deepEqual(registry.record('B').sessionIds, ['s1'])
    assert.equal(journal.entry('s1'), null)
  })
})

test('一键还原：逐条返回结果并统计成功数', async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, 'A')
    const b = join(dir, 'B')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('s1', { path: b, from: a, kind: 'move' })
    journal.record('s2', { path: b, from: join(dir, 'missing'), kind: 'move' })
    const registry = createMockRegistry({
      workspaces: [
        { id: 'A', title: 'A', path: a, sessionIds: [] },
        { id: 'B', title: 'B', path: b, sessionIds: ['s1', 's2'] },
      ],
      sessionPaths: { s1: b, s2: b },
      headers: { s1: { cwd: a }, s2: { cwd: join(dir, 'missing') } },
    })
    const results = await restoreAllManaged({ registry, journal })
    assert.equal(results.length, 2)
    assert.equal(results.filter((item) => item.restored).length, 2)
    assert.deepEqual(registry.record('A').sessionIds, ['s1'])
    assert.deepEqual(registry.record('B').sessionIds, [])
    assert.deepEqual(journal.entries(), [])
  })
})

test('清理陈旧日志：账本里没有、或归属已换目录的条目被删掉', async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, 'A')
    const b = join(dir, 'B')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const journal = createJournalStore(join(dir, 'journal.json'))
    journal.record('live', { path: b, from: a, kind: 'move' })
    journal.record('movedBack', { path: b, from: a, kind: 'move' })
    journal.record('orphan', { path: b, from: a, kind: 'move' })
    const registry = createMockRegistry({
      workspaces: [
        { id: 'A', title: 'A', path: a, sessionIds: ['movedBack'] },
        { id: 'B', title: 'B', path: b, sessionIds: ['live'] },
      ],
      sessionPaths: { live: b, movedBack: a },
    })
    const removed = pruneJournal({ registry, journal })
    assert.equal(removed, 2)
    assert.deepEqual(journal.entries().map((entry) => entry.sessionId), ['live'])
  })
})

test('还原：多次移动后仍回到 header 原始目录（home 优先于 from）', async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, 'A')
    const b = join(dir, 'B')
    const c = join(dir, 'C')
    for (const p of [a, b, c]) mkdirSync(p, { recursive: true })
    const journal = createJournalStore(join(dir, 'journal.json'))
    // A → B → C：日志 path 是 C，home 仍是 A，from 只是上一次的 B。
    journal.record('s1', { path: c, home: a, from: b, kind: 'move' })
    const registry = createMockRegistry({
      workspaces: [
        { id: 'A', title: 'A', path: a, sessionIds: [] },
        { id: 'B', title: 'B', path: b, sessionIds: [] },
        { id: 'C', title: 'C', path: c, sessionIds: ['s1'] },
      ],
      sessionPaths: { s1: c },
      headers: { s1: { cwd: a } },
    })
    const result = await restoreManagedSession({ registry, journal, sessionId: 's1' })
    assert.equal(result.restored, true)
    assert.equal(result.to?.id, 'A')
    assert.deepEqual(registry.record('A').sessionIds, ['s1'])
    assert.deepEqual(registry.record('B').sessionIds, [])
    assert.deepEqual(registry.record('C').sessionIds, [])
  })
})

test('路径比较：尾部分隔符与 Windows 大小写', () => {
  assert.equal(samePath('C:/A/', 'C:/A'), true)
  assert.equal(samePath('C:/A', 'C:/B'), false)
  assert.equal(samePath('', 'C:/A'), false)
  if (process.platform === 'win32') assert.equal(samePath('C:/A', 'c:/a'), true)
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
