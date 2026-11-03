/**
 * dsh-session-mover —— 归属账本核心逻辑的单元测试。
 *
 * 用一个最小化的 workspace 注册表替身覆盖四条路径：正常移动、幂等、
 * 目标缺失、启动重放。替身的语义刻意贴近真实实现：
 *   - 记录里的 `sessionIds` 是持久化的原始账本；
 *   - `sessionPaths` 参与成员过滤（等价于 `candidateMatches`）；
 *   - `mutate()` 写回时同样按 `sessionPaths` 剪枝。
 *
 * 运行：node test/core-test.mjs
 */

import assert from 'node:assert/strict'
import { moveSessionInRegistry, ownershipPaths, readRawSessionIds, replayOwnership, resolveRegistryParts } from '../lib/core.js'

/**
 * 造一个最小化的注册表替身。
 *
 * @param {{ workspaces: Array<{ id: string, title: string, path: string, sessionIds: string[] }>, sessionPaths: Record<string, string> }} input - 初始状态。
 * @returns {object} 供 core.js 使用的替身。
 */
function createMockRegistry(input) {
  const table = new Map()
  const entities = new Map()
  for (const workspace of input.workspaces) {
    table.set(workspace.id, {
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  }
  const sessionPaths = new Map(Object.entries(input.sessionPaths))

  for (const workspace of input.workspaces) {
    entities.set(workspace.id, {
      id: workspace.id,
      get title() {
        return table.get(workspace.id).title
      },
      get path() {
        return table.get(workspace.id).path
      },
      get sessionIds() {
        const record = table.get(workspace.id)
        return record.sessionIds.filter((id) => sessionPaths.get(id) === record.path)
      },
      async mutate(change) {
        const current = table.get(workspace.id)
        const changed = change(current)
        const next = { ...changed, sessionIds: changed.sessionIds.filter((id) => sessionPaths.get(id) === changed.path) }
        const unchanged = next.sessionIds.length === current.sessionIds.length
          && next.sessionIds.every((id, index) => id === current.sessionIds[index])
        if (unchanged) return
        table.set(workspace.id, { ...next, updatedAt: '2026-01-02T00:00:00.000Z' })
      },
    })
  }

  return {
    table: { get: (id) => table.get(id) },
    sessionPaths,
    get: (id) => entities.get(id),
    list: () => [...entities.values()],
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

test('把会话从 A 移动到 B：账本与内存索引同时更新', async () => {
  const registry = createMockRegistry({
    workspaces: [
      { id: 'ws-a', title: '项目 A', path: 'C:\\work\\a', sessionIds: ['s1', 's2'] },
      { id: 'ws-b', title: '项目 B', path: 'C:\\work\\b', sessionIds: [] },
    ],
    sessionPaths: { s1: 'C:\\work\\a', s2: 'C:\\work\\a' },
  })

  const result = await moveSessionInRegistry(registry, 's1', 'ws-b')

  assert.equal(result.changed, true)
  assert.equal(result.alreadyThere, false)
  assert.equal(result.workspace.id, 'ws-b')
  assert.equal(result.from?.id, 'ws-a')
  assert.deepEqual(readRawSessionIds(registry, 'ws-a'), ['s2'])
  assert.deepEqual(readRawSessionIds(registry, 'ws-b'), ['s1'])
  assert.equal(registry.sessionPaths.get('s1'), 'C:\\work\\b')
  assert.deepEqual(registry.get('ws-a').sessionIds, ['s2'])
  assert.deepEqual(registry.get('ws-b').sessionIds, ['s1'])
})

test('重复移动到同一个项目是幂等的', async () => {
  const registry = createMockRegistry({
    workspaces: [
      { id: 'ws-a', title: '项目 A', path: 'C:\\work\\a', sessionIds: [] },
      { id: 'ws-b', title: '项目 B', path: 'C:\\work\\b', sessionIds: ['s1'] },
    ],
    sessionPaths: { s1: 'C:\\work\\b' },
  })

  const result = await moveSessionInRegistry(registry, 's1', 'ws-b')

  assert.equal(result.changed, false)
  assert.equal(result.alreadyThere, true)
  assert.deepEqual(readRawSessionIds(registry, 'ws-b'), ['s1'])
})

test('目标项目不存在时抛 workspace/not-found', async () => {
  const registry = createMockRegistry({
    workspaces: [{ id: 'ws-a', title: '项目 A', path: 'C:\\work\\a', sessionIds: ['s1'] }],
    sessionPaths: { s1: 'C:\\work\\a' },
  })

  await assert.rejects(
    () => moveSessionInRegistry(registry, 's1', 'ws-missing'),
    (error) => error.code === 'workspace/not-found',
  )
  assert.deepEqual(readRawSessionIds(registry, 'ws-a'), ['s1'])
})

test('从「未分组」移入项目：原记录为空时也能成功', async () => {
  const registry = createMockRegistry({
    workspaces: [{ id: 'ws-b', title: '项目 B', path: 'C:\\work\\b', sessionIds: [] }],
    sessionPaths: { s1: 'C:\\work\\loose' },
  })

  const result = await moveSessionInRegistry(registry, 's1', 'ws-b')

  assert.equal(result.changed, true)
  assert.equal(result.from, null)
  assert.deepEqual(readRawSessionIds(registry, 'ws-b'), ['s1'])
})

test('给了锚点时插到锚点之前（拖到某个会话上）', async () => {
  const registry = createMockRegistry({
    workspaces: [
      { id: 'ws-a', title: '项目 A', path: 'C:\\work\\a', sessionIds: ['s9'] },
      { id: 'ws-b', title: '项目 B', path: 'C:\\work\\b', sessionIds: ['s1', 's2', 's3'] },
    ],
    sessionPaths: { s1: 'C:\\work\\b', s2: 'C:\\work\\b', s3: 'C:\\work\\b', s9: 'C:\\work\\a' },
  })

  await moveSessionInRegistry(registry, 's9', 'ws-b', 's3')

  assert.deepEqual(readRawSessionIds(registry, 'ws-b'), ['s1', 's2', 's9', 's3'])
  assert.deepEqual(readRawSessionIds(registry, 'ws-a'), [])
})

test('锚点不在目标项目时退化到最前', async () => {
  const registry = createMockRegistry({
    workspaces: [
      { id: 'ws-a', title: '项目 A', path: 'C:\\work\\a', sessionIds: ['s9'] },
      { id: 'ws-b', title: '项目 B', path: 'C:\\work\\b', sessionIds: ['s1', 's2'] },
    ],
    sessionPaths: { s1: 'C:\\work\\b', s2: 'C:\\work\\b', s9: 'C:\\work\\a' },
  })

  await moveSessionInRegistry(registry, 's9', 'ws-b', 's-unknown')

  assert.deepEqual(readRawSessionIds(registry, 'ws-b'), ['s9', 's1', 's2'])
})

test('启动重放：账本记着的归属覆盖过期的内存索引', () => {
  const registry = createMockRegistry({
    workspaces: [
      { id: 'ws-a', title: '项目 A', path: 'C:\\work\\a', sessionIds: ['s2'] },
      { id: 'ws-b', title: '项目 B', path: 'C:\\work\\b', sessionIds: ['s1'] },
    ],
    // s1 的 header 仍指向 A：重启后索引会重建为旧目录，重放应把它拉回账本。
    sessionPaths: { s1: 'C:\\work\\a', s2: 'C:\\work\\a' },
  })

  const result = replayOwnership(registry)

  assert.equal(result.supported, true)
  assert.equal(result.applied, 1)
  assert.equal(registry.sessionPaths.get('s1'), 'C:\\work\\b')
  assert.deepEqual(registry.get('ws-b').sessionIds, ['s1'])
  assert.deepEqual(registry.get('ws-a').sessionIds, ['s2'])
})

test('结构不符时降级为「不支持」，不做任何写入', () => {
  assert.equal(resolveRegistryParts({}), null)
  assert.equal(resolveRegistryParts(null), null)
  assert.deepEqual(replayOwnership({}), { supported: false, applied: 0 })
  assert.deepEqual(readRawSessionIds({}, 'ws-a'), [])
  assert.equal(ownershipPaths({}).size, 0)
})

test('归属投影：把账本摊成「会话 → 目录」，与 header 里的旧 cwd 无关', async () => {
  const registry = createMockRegistry({
    workspaces: [
      { id: 'ws-a', title: '项目 A', path: 'C:\\work\\a', sessionIds: ['s2'] },
      { id: 'ws-b', title: '项目 B', path: 'C:\\work\\b', sessionIds: ['s1'] },
    ],
    // s1 的 header cwd 还停在 A，账本已经把它记在 B 下。
    sessionPaths: { s1: 'C:\\work\\a', s2: 'C:\\work\\a' },
  })
  // 启动重放先把索引对齐账本，模拟「上次移动过、这次重启」的现场。
  replayOwnership(registry)
  await moveSessionInRegistry(registry, 's2', 'ws-b')

  const paths = ownershipPaths(registry)

  assert.equal(paths.get('s1'), 'C:\\work\\b')
  assert.equal(paths.get('s2'), 'C:\\work\\b')
  assert.equal(paths.size, 2)
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
