/**
 * dsh-session-mover —— 启动补登记「历史独立分叉」的单元测试。
 *
 * 替身刻意贴近官方实现：
 *   - `sessionQuery.listSessions()` 只给轻量 header；
 *   - `sessionQuery.readSession()` 返回继承边界与完整事件；
 *   - workspace entity 的 `mutate()` 会按内存索引剪枝（等价 candidateMatches）。
 *
 * 运行：node test/backfill-test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backfillIndependentForks } from '../lib/backfill.js'
import { createJournalStore } from '../lib/journal.js'

/**
 * 造一个最小 workspace 注册表替身。
 *
 * @param {Array<{ id: string, path: string, sessionIds: string[] }>} workspaces - 初始账本。
 * @returns {object} 注册表替身。
 */
function createRegistry(workspaces, pathIndex = {}) {
  const paths = new Map(Object.entries(pathIndex))
  const table = new Map()
  const entities = new Map()
  for (const workspace of workspaces) {
    table.set(workspace.id, { ...workspace, title: workspace.id, createdAt: '', updatedAt: '' })
    entities.set(workspace.id, {
      id: workspace.id,
      path: workspace.path,
      title: workspace.id,
      get record() { return table.get(workspace.id) },
      get sessionIds() { return table.get(workspace.id).sessionIds.filter((id) => paths.get(id) === workspace.path) },
      async mutate(change) {
        const current = table.get(workspace.id)
        const changed = change(current)
        table.set(workspace.id, {
          ...changed,
          sessionIds: changed.sessionIds.filter((id) => paths.get(id) === changed.path),
        })
      },
    })
  }
  return {
    table: { get: (id) => table.get(id) },
    sessionPaths: paths,
    entities,
    get: (id) => entities.get(id),
    list: () => [...entities.values()],
    ids: (id) => table.get(id)?.sessionIds ?? [],
    paths,
  }
}

/**
 * 造一份会话清单 + 冷读日志替身。
 *
 * @param {Array<{ header: object }>} records - 轻量会话记录。
 * @param {Record<string, { events: object[], inheritedEventCount: number }>} logs - 冷读结果。
 * @returns {{ listSessions: () => Promise<object[]>, readSession: (id: string) => Promise<object> }} 查询服务替身。
 */
function createQuery(records, logs = {}) {
  return {
    async listSessions() { return records },
    async readSession(id) {
      const log = logs[id]
      if (log === undefined) throw new Error(`no log for ${id}`)
      return { session: headerOfRecord(records, id), ...log }
    },
  }
}

/**
 * 从 `listSessions()` 记录里取 header（真实宿主为 `{ header }` 包装）。
 *
 * @param {Array<object>} records - 会话记录。
 * @param {string} id - 会话 id。
 * @returns {object} header。
 */
function headerOfRecord(records, id) {
  const record = records.find((item) => item.header.id === id)
  return record.header
}

/** 造一个独立分叉 header（无 parentSession）。 */
function forkHeader(id, cwd) {
  return { id, cwd, isSeeded: true, origin: undefined }
}

/** 造一个普通会话 header。 */
function plainHeader(id, cwd) {
  return { id, cwd, isSeeded: false, origin: undefined }
}

/** 造一条外来投递标记事件。 */
function delivery(id) {
  return { type: 'session-log-deepseek/delivery-accepted', data: { sessionId: id } }
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
 * 在临时目录里造一份日志。
 *
 * @param {(journal: ReturnType<typeof createJournalStore>) => void | Promise<void>} run - 用例体。
 * @returns {Promise<void>} 完成。
 */
async function withJournal(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-backfill-'))
  try {
    await run(createJournalStore(join(dir, 'journal.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('来源链精确归位：分叉 seed 指向被移动过的已知来源', async () => {
  await withJournal(async (journal) => {
    journal.record('parent', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    journal.save()
    const registry = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['parent'] }], { parent: 'C:/B' })
    const query = createQuery(
      [{ header: plainHeader('parent', 'C:/A') }, { header: forkHeader('child', 'C:/A') }],
      { child: { events: [delivery('parent')], inheritedEventCount: 1 } },
    )

    const result = await backfillIndependentForks({ query, registry, journal })

    assert.deepEqual(result, { scanned: 2, candidates: 1, adopted: 1, skipped: 0 })
    assert.deepEqual(registry.ids('B'), ['child', 'parent'])
    assert.equal(registry.paths.get('child'), 'C:/B')
    assert.equal(journal.entry('child').kind, 'fork')
    assert.equal(journal.entry('child').home, 'C:/A')
  })
})

test('嵌套分叉：沿两层 seed 追到已分组祖先', async () => {
  await withJournal(async (journal) => {
    journal.record('root', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const registry = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['root'] }], { root: 'C:/B' })
    const query = createQuery(
      [{ header: plainHeader('root', 'C:/A') }, { header: forkHeader('child', 'C:/A') }, { header: forkHeader('grandchild', 'C:/A') }],
      {
        child: { events: [delivery('root')], inheritedEventCount: 1 },
        grandchild: { events: [delivery('child')], inheritedEventCount: 1 },
      },
    )

    const result = await backfillIndependentForks({ query, registry, journal })

    assert.equal(result.adopted, 2)
    assert.deepEqual(registry.ids('B').sort(), ['child', 'grandchild', 'root'])
    assert.equal(journal.entry('grandchild').kind, 'fork')
  })
})

test('读不到来源链时按唯一原始目录候选归位', async () => {
  await withJournal(async (journal) => {
    journal.record('p', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const registry = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['p'] }], { p: 'C:/B' })
    const query = createQuery([{ header: forkHeader('orphan', 'C:/A') }], {
      orphan: { events: [], inheritedEventCount: 0 },
    })

    const result = await backfillIndependentForks({ query, registry, journal })

    assert.equal(result.adopted, 1)
    assert.deepEqual(registry.ids('B'), ['orphan', 'p'])
  })
})

test('多个项目共享原始目录时保持未分组，不猜', async () => {
  await withJournal(async (journal) => {
    journal.record('p1', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    journal.record('p2', { path: 'C:/C', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const registry = createRegistry([
      { id: 'B', path: 'C:/B', sessionIds: ['p1'] },
      { id: 'C', path: 'C:/C', sessionIds: ['p2'] },
    ], { p1: 'C:/B', p2: 'C:/C' })
    const query = createQuery([{ header: forkHeader('orphan', 'C:/A') }], {
      orphan: { events: [], inheritedEventCount: 0 },
    })

    const result = await backfillIndependentForks({ query, registry, journal })

    assert.equal(result.adopted, 0)
    assert.equal(result.skipped, 1)
    assert.deepEqual(registry.ids('B'), ['p1'])
    assert.deepEqual(registry.ids('C'), ['p2'])
    assert.equal(journal.entry('orphan'), null)
  })
})

test('已分组会话、普通新会话与子代理派生都不补登记', async () => {
  await withJournal(async (journal) => {
    journal.record('p', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const registry = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['p', 'grouped'] }], {
      p: 'C:/B',
      grouped: 'C:/B',
    })
    const query = createQuery([
      { header: plainHeader('plain', 'C:/A') },
      { header: { ...forkHeader('sub', 'C:/A'), origin: 'subagent' } },
      { header: forkHeader('grouped', 'C:/A') },
    ])

    const result = await backfillIndependentForks({ query, registry, journal })

    assert.equal(result.candidates, 0)
    assert.equal(result.adopted, 0)
    assert.deepEqual(registry.ids('B'), ['p', 'grouped'])
  })
})

test('sessionQuery 缺席、清单失败、插件被卸载时安静降级', async () => {
  await withJournal(async (journal) => {
    journal.record('p', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const registry = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['p'] }], { p: 'C:/B' })
    const records = [{ header: forkHeader('child', 'C:/A') }]

    assert.equal((await backfillIndependentForks({ registry, journal })).reason, 'sessionQuery/unavailable')
    assert.equal((await backfillIndependentForks({
      query: { listSessions: () => Promise.reject(new Error('disk busy')) }, registry, journal,
    })).reason, 'sessionQuery/list-failed')
    assert.equal((await backfillIndependentForks({
      query: createQuery(records), registry, journal, isActive: () => false,
    })).reason, 'disposed')
    assert.deepEqual(registry.ids('B'), ['p'])
  })
})

test('空日志直接跳过，不读取任何会话', async () => {
  await withJournal(async (journal) => {
    const registry = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['p'] }], { p: 'C:/B' })
    const query = { listSessions: () => { throw new Error('should not be called') } }
    assert.deepEqual(await backfillIndependentForks({ query, registry, journal }), {
      scanned: 0, candidates: 0, adopted: 0, skipped: 0, reason: 'journal/empty',
    })
  })
})

let failed = 0
for (const item of cases) {
  try {
    await item.run()
    console.log(`ok   ${item.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${item.name}`)
    console.error(error)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${cases.length} 个用例失败`)
  process.exitCode = 1
} else {
  console.log(`\n${cases.length} 个用例全部通过`)
}
