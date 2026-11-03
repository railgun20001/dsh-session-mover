/**
 * dsh-session-mover —— 「分叉会话跟随父项目」的单元测试。
 *
 * 覆盖三条对齐（账本 / 内存索引 / 工作目录）以及所有降级分支。
 * 替身刻意贴近真实实现：
 *   - `sessionIds` getter 按 `sessionPaths` 过滤成员（等价于 `candidateMatches`）；
 *   - `mutate()` 写回时同样按 `sessionPaths` 剪枝；
 *   - `agents` / `workingDirectory` / `sessions` 三个服务只暴露用到的两个方法。
 *
 * 运行：node test/fork-test.mjs
 */

import assert from 'node:assert/strict'
import { alignAgentWorkingDirectory, forkFactsOf, reconcileForkedSession } from '../lib/fork.js'
import { readRawSessionIds } from '../lib/core.js'

/**
 * 造一个最小化的 workspace 注册表替身。
 *
 * @param {{ workspaces: Array<{ id: string, title?: string, path: string, sessionIds: string[] }>, sessionPaths?: Record<string, string> }} input - 初始状态。
 * @returns {object} 供核心逻辑使用的替身。
 */
function createRegistry(input) {
  const paths = new Map(Object.entries(input.sessionPaths ?? {}))
  const table = new Map()
  const entities = new Map()

  for (const workspace of input.workspaces) {
    table.set(workspace.id, {
      title: workspace.title ?? workspace.id,
      path: workspace.path,
      sessionIds: [...workspace.sessionIds],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  }

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
        return record.sessionIds.filter((id) => paths.get(id) === record.path)
      },
      async mutate(change) {
        const current = table.get(workspace.id)
        const changed = change(current)
        const next = { ...changed, sessionIds: changed.sessionIds.filter((id) => paths.get(id) === changed.path) }
        const unchanged = changed === current
          && next.sessionIds.length === current.sessionIds.length
          && next.sessionIds.every((id, index) => id === current.sessionIds[index])
        if (unchanged) return
        table.set(workspace.id, { ...next, updatedAt: '2026-02-01T00:00:00.000Z' })
      },
    })
  }

  return {
    table: { get: (id) => table.get(id) },
    sessionPaths: paths,
    get: (id) => entities.get(id),
    list: () => [...entities.values()],
  }
}

/**
 * 造一个只提供 `get(服务名)` 的插件上下文替身。
 *
 * @param {{ agent?: object, session?: object, calls?: string[] }} input - 各服务的行为。
 * @returns {{ ctx: object, calls: string[] }} 上下文与调用记录。
 */
function createContext(input = {}) {
  const calls = input.calls ?? []
  const services = {
    agents: { get: () => input.agent },
    workingDirectory: {
      get: () => input.currentWorkingDirectory,
      set: async (_agent, path) => {
        calls.push(`set:${path}`)
      },
    },
    sessions: { get: () => input.session },
  }
  return { ctx: { get: (name) => services[name] }, calls }
}

/**
 * 造一个分叉子会话对象（只带 reconcile 会读的字段）。
 *
 * @param {{ id: string, parentId: string, cwd?: string, overrides?: object }} input - 会话事实。
 * @returns {{ id: string, header: object }} 会话对象。
 */
function forkSession(input) {
  return {
    id: input.id,
    header: {
      id: input.id,
      cwd: input.cwd,
      parentSession: input.parentId,
      isSeeded: true,
      origin: undefined,
      ...input.overrides,
    },
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

test('分叉事实识别：只认带种子的普通分叉', () => {
  assert.deepEqual(forkFactsOf(forkSession({ id: 'c1', parentId: 'p1', cwd: 'C:\\a' })), {
    sessionId: 'c1',
    parentId: 'p1',
    cwd: 'C:\\a',
  })
  assert.equal(forkFactsOf(forkSession({ id: 'c1', parentId: 'p1', overrides: { isSeeded: false } })), null)
  assert.equal(forkFactsOf(forkSession({ id: 'c1', parentId: 'p1', overrides: { origin: 'subagent' } })), null)
  assert.equal(forkFactsOf({ id: 'c1', header: { isSeeded: true } }), null)
  assert.equal(forkFactsOf(undefined), null)
})

test('账本里还没有子会话：整条 adopt 到父会话的项目，并切工作目录', async () => {
  const registry = createRegistry({
    workspaces: [
      { id: 'ws-old', path: 'C:\\work\\old', sessionIds: [] },
      { id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['parent'] },
    ],
    sessionPaths: { parent: 'C:\\work\\new' },
  })
  const { ctx, calls } = createContext({ agent: { id: 'agent-1' } })

  const result = await reconcileForkedSession(ctx, registry, forkSession({ id: 'child', parentId: 'parent', cwd: 'C:\\work\\old' }))

  assert.deepEqual(result.changed.sort(), ['ledger', 'workdir'])
  assert.deepEqual(readRawSessionIds(registry, 'ws-new'), ['child', 'parent'])
  assert.equal(registry.sessionPaths.get('child'), 'C:\\work\\new')
  assert.deepEqual(calls, ['set:C:\\work\\new'])
})

test('账本已在父会话项目里、只是索引没登记：只补索引（侧栏不再把它过滤成未分组）', async () => {
  const registry = createRegistry({
    workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['child', 'parent'] }],
    // 索引里还是父会话的旧目录：`candidateMatches` 会把子会话过滤掉。
    sessionPaths: { parent: 'C:\\work\\new', child: 'C:\\work\\old' },
  })
  const { ctx } = createContext({ agent: { id: 'agent-1' } })

  const result = await reconcileForkedSession(ctx, registry, forkSession({ id: 'child', parentId: 'parent', cwd: 'C:\\work\\old' }))

  assert.deepEqual(result.changed.sort(), ['index', 'workdir'])
  assert.equal(registry.sessionPaths.get('child'), 'C:\\work\\new')
  assert.deepEqual(readRawSessionIds(registry, 'ws-new'), ['child', 'parent'])
})

test('普通分叉（官方 attach 已完成、子会话 cwd 就是项目目录）什么都不做', async () => {
  const registry = createRegistry({
    // 官方 attachSession 已经把子会话记进账本并登记了索引——这正是普通分叉的结果。
    workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['child', 'parent'] }],
    sessionPaths: { parent: 'C:\\work\\new', child: 'C:\\work\\new' },
  })
  const { ctx, calls } = createContext({ agent: { id: 'agent-1' } })

  const result = await reconcileForkedSession(ctx, registry, forkSession({ id: 'child', parentId: 'parent', cwd: 'C:\\work\\new' }))

  assert.deepEqual(result.changed, [])
  assert.deepEqual(calls, [])
  assert.deepEqual(readRawSessionIds(registry, 'ws-new'), ['child', 'parent'])
})

test('父会话未分组时跳过', async () => {
  const registry = createRegistry({ workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: [] }] })
  const { ctx, calls } = createContext({ agent: { id: 'agent-1' } })

  const result = await reconcileForkedSession(ctx, registry, forkSession({ id: 'child', parentId: 'parent', cwd: 'C:\\work\\old' }))

  assert.deepEqual(result.changed, [])
  assert.equal(result.reason, 'parent/ungrouped')
  assert.deepEqual(calls, [])
})

test('没有 Agent 但会话已加载：靠补一条 working-directory/change 事件切目录', async () => {
  const registry = createRegistry({
    workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['parent'] }],
    sessionPaths: { parent: 'C:\\work\\new' },
  })
  const appended = []
  const { ctx } = createContext({ session: { append: (type, data) => appended.push([type, data]) } })

  const result = await reconcileForkedSession(ctx, registry, forkSession({ id: 'child', parentId: 'parent', cwd: 'C:\\work\\old' }))

  assert.equal(result.workingDirectory, 'session')
  assert.deepEqual(appended, [['working-directory/change', { cwd: 'C:\\work\\new' }]])
})

test('Agent 与会话都取不到时，归属照样对齐，工作目录如实报告 skipped', async () => {
  const registry = createRegistry({
    workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['parent'] }],
    sessionPaths: { parent: 'C:\\work\\new' },
  })
  const { ctx } = createContext({})

  const result = await reconcileForkedSession(ctx, registry, forkSession({ id: 'child', parentId: 'parent', cwd: 'C:\\work\\old' }))

  assert.deepEqual(result.changed, ['ledger'])
  assert.equal(result.workingDirectory, 'skipped')
  assert.deepEqual(readRawSessionIds(registry, 'ws-new'), ['child', 'parent'])
})

test('父会话所在项目记录不可读时安静跳过', async () => {
  const registry = createRegistry({
    workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['parent'] }],
    sessionPaths: { parent: 'C:\\work\\new' },
  })
  // 让 list() 暴露一个不存在的项目，模拟记录被删掉的瞬间。
  const originalList = registry.list
  registry.list = () => [...originalList(), { id: 'ws-ghost', path: 'C:\\work\\ghost', sessionIds: [] }]
  const { ctx } = createContext({ agent: { id: 'agent-1' } })
  registry.table.get = ((get) => (id) => (id === 'ws-ghost' ? undefined : get(id)))(registry.table.get)

  const result = await reconcileForkedSession(ctx, registry, forkSession({ id: 'child', parentId: 'ghost-parent', cwd: 'C:\\work\\old' }))

  assert.deepEqual(result.changed, [])
  assert.equal(result.reason, 'parent/ungrouped')
})

test('打开会话时对齐：工作目录还停在旧目录就切到项目目录', async () => {
  const registry = createRegistry({
    workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['child'] }],
    sessionPaths: { child: 'C:\\work\\new' },
  })
  const { ctx, calls } = createContext({ agent: { id: 'agent-1' }, currentWorkingDirectory: 'C:\\work\\old' })

  const result = await alignAgentWorkingDirectory(ctx, registry, { session: { id: 'child' } }, undefined)

  assert.deepEqual(result.changed, ['workdir'])
  assert.deepEqual(calls, ['set:C:\\work\\new'])
})

test('打开会话时对齐：已经是项目目录则什么都不做', async () => {
  const registry = createRegistry({
    workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: ['child'] }],
    sessionPaths: { child: 'C:\\work\\new' },
  })
  const { ctx, calls } = createContext({ agent: { id: 'agent-1' }, currentWorkingDirectory: 'C:\\work\\new' })

  const result = await alignAgentWorkingDirectory(ctx, registry, { session: { id: 'child' } }, undefined)

  assert.deepEqual(result.changed, [])
  assert.deepEqual(calls, [])
})

test('打开会话时对齐：会话不在任何项目里则跳过', async () => {
  const registry = createRegistry({ workspaces: [{ id: 'ws-new', path: 'C:\\work\\new', sessionIds: [] }] })
  const { ctx, calls } = createContext({ agent: { id: 'agent-1' }, currentWorkingDirectory: 'C:\\work\\old' })

  const result = await alignAgentWorkingDirectory(ctx, registry, { session: { id: 'loose' } }, undefined)

  assert.deepEqual(result.changed, [])
  assert.equal(result.reason, 'session/ungrouped')
  assert.deepEqual(calls, [])
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
