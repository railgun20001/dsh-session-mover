/**
 * dsh-session-mover —— 独立分叉来源判定的单元测试。
 *
 * 覆盖 0.2.1-rc.3+ 省略 parentSession 后的三类事实：
 *   - seed 继承投递记录能精确认出直接来源（含嵌套分叉）；
 *   - attach 目标内按「受管会话原始目录」证明归属；
 *   - 跨项目推断只在唯一候选成立时归位，歧义与陈旧日志一律跳过。
 *
 * 运行：node test/fork-origin-test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  hasManagedHome,
  independentForkSourceId,
  isIndependentFork,
  resolveIndependentForkPath,
  sourceIdFromEvents,
} from '../lib/fork-origin.js'
import { createJournalStore } from '../lib/journal.js'

/**
 * 造一个最小注册表替身：只提供 ownershipPaths 需要的 table/list。
 *
 * @param {Array<{ id: string, path: string, sessionIds: string[] }>} workspaces - 账本记录。
 * @returns {object} 注册表替身。
 */
function createRegistry(workspaces) {
  const table = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const entities = workspaces.map((workspace) => ({ id: workspace.id, path: workspace.path, title: workspace.id }))
  return {
    table: { get: (id) => table.get(id) },
    sessionPaths: new Map(),
    get: (id) => entities.find((item) => item.id === id),
    list: () => entities,
  }
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
  const dir = mkdtempSync(join(tmpdir(), 'dsm-origin-'))
  try {
    await run(createJournalStore(join(dir, 'journal.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('独立分叉识别：isSeeded、无 parentSession、非子代理', () => {
  assert.equal(isIndependentFork({ isSeeded: true, origin: undefined }), true)
  assert.equal(isIndependentFork({ isSeeded: true, parentSession: 'p1' }), false)
  assert.equal(isIndependentFork({ isSeeded: true, origin: 'subagent' }), false)
  assert.equal(isIndependentFork({ isSeeded: false }), false)
  assert.equal(isIndependentFork(undefined), false)
})

test('来源链：继承边界之前最后一枚外来投递标记是已知来源', () => {
  const events = [
    { type: 'session-log-deepseek/delivery-accepted', data: { sessionId: 'ancestor' } },
    { type: 'user/message', data: {} },
    { type: 'session-log-deepseek/delivery-accepted', data: { sessionId: 'parent' } },
    { type: 'session/end-seed', data: { inherited: true } },
    { type: 'session-log-deepseek/delivery-accepted', data: { sessionId: 'child' } },
  ]
  assert.equal(sourceIdFromEvents(events, 'child', 4), 'parent')
  assert.equal(sourceIdFromEvents(events, 'child'), 'parent')
  assert.equal(sourceIdFromEvents(events, 'parent', 3), 'ancestor')
})

test('live Session：snapshotEvents + inheritedEventCount 读出已知来源', () => {
  const events = [
    { type: 'session-log-deepseek/delivery-accepted', data: { sessionId: 'parent' } },
    { type: 'session/end-seed', data: { inherited: true } },
  ]
  const session = {
    id: 'child',
    header: { id: 'child', isSeeded: true, cwd: 'C:/A' },
    inheritedEventCount: 1,
    snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
  }
  assert.equal(independentForkSourceId(session), 'parent')
})

test('没有投递标记或 Session 读取抛错时安静返回 undefined', () => {
  assert.equal(independentForkSourceId({ id: 'c', header: { isSeeded: true }, events: [] }), undefined)
  assert.equal(independentForkSourceId({
    id: 'c',
    header: { isSeeded: true },
    snapshotEvents: () => { throw new Error('internal reader changed') },
  }), undefined)
})

test('attach 目标内：受管会话原始目录等于子会话 cwd 才能接管', async () => {
  await withJournal((journal) => {
    journal.record('p', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const registry = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['p'] }])
    assert.equal(hasManagedHome(registry, journal, 'C:/B', 'C:/A'), true)
    assert.equal(hasManagedHome(registry, journal, 'C:/B', 'C:/X'), false)
    assert.equal(hasManagedHome(registry, journal, 'C:/C', 'C:/A'), false)
  })
})

test('陈旧日志（账本归属已变）不能用来证明分叉来源', async () => {
  await withJournal((journal) => {
    journal.record('p', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const registry = createRegistry([{ id: 'A', path: 'C:/A', sessionIds: ['p'] }])
    assert.equal(hasManagedHome(registry, journal, 'C:/B', 'C:/A'), false)
    assert.equal(resolveIndependentForkPath(registry, journal, 'C:/A'), undefined)
  })
})

test('唯一目录候选：只有一个目标项目时归位，多个项目歧义时跳过', async () => {
  await withJournal((journal) => {
    journal.record('p1', { path: 'C:/B', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const unique = createRegistry([{ id: 'B', path: 'C:/B', sessionIds: ['p1'] }])
    assert.equal(resolveIndependentForkPath(unique, journal, 'C:/A'), 'C:/B')

    journal.record('p2', { path: 'C:/C', home: 'C:/A', from: 'C:/A', kind: 'move' })
    const ambiguous = createRegistry([
      { id: 'B', path: 'C:/B', sessionIds: ['p1'] },
      { id: 'C', path: 'C:/C', sessionIds: ['p2'] },
    ])
    assert.equal(resolveIndependentForkPath(ambiguous, journal, 'C:/A'), undefined)
  })
})

test('Windows 路径大小写与尾部分隔符按同一目录处理', async () => {
  await withJournal((journal) => {
    journal.record('p', { path: 'c:/b/', home: 'C:\\A\\', from: 'C:\\A\\', kind: 'move' })
    const registry = createRegistry([{ id: 'B', path: 'C:\\B', sessionIds: ['p'] }])
    assert.equal(hasManagedHome(registry, journal, 'C:\\B\\', 'C:/A'), true)
    assert.equal(resolveIndependentForkPath(registry, journal, 'c:/a'), 'c:/b/')
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
