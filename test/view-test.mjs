/**
 * dsh-session-mover —— 读取侧「工作区视图」的单元测试。
 *
 * 覆盖三件事：
 *   1. `workspaceRootFor()` 的「账本优先、否则回退」规则；
 *   2. `installWorkspaceScopeView()` 是否真的按账本解析 `workspaceRoot`，
 *      以及未移动的会话是否原样交回默认策略；
 *   3. 各种「接口形态不符」时是否安静降级（不抛错、不接管）。
 *
 * 运行：node test/view-test.mjs
 */

import assert from 'node:assert/strict'
import { workspaceRootFor, installWorkspaceScopeView } from '../lib/view.js'

/**
 * 造一个最小化的注册表替身（只提供 `resolveRegistryParts` 需要的两个字段）。
 *
 * @param {Array<{ id: string, path: string, sessionIds: string[] }>} workspaces - 账本内容。
 * @returns {object} 供 `ownershipPaths()` 使用的替身。
 */
function createRegistry(workspaces) {
  const table = new Map()
  const entities = []
  for (const workspace of workspaces) {
    table.set(workspace.id, { path: workspace.path, sessionIds: [...workspace.sessionIds] })
    entities.push({ id: workspace.id, path: workspace.path, sessionIds: workspace.sessionIds })
  }
  return {
    table: { get: (id) => table.get(id) },
    sessionPaths: new Map(),
    list: () => entities,
  }
}

/**
 * 造一个 typert 替身：只有 `lookups.get/configure` 两个入口。
 *
 * @param {{ provider?: object, onConfigure?: (key: string, resolver: (id: string) => unknown) => void, failConfigure?: boolean }} input - 行为开关。
 * @returns {{ ctx: object, configured: Array<{ key: string, resolver: (id: string) => unknown }> }} 替身。
 */
function createTypert(input = {}) {
  const configured = []
  const lookups = {
    get: () => input.provider,
    configure: (key, resolver) => {
      if (input.failConfigure === true) throw new Error('lookup "workspaceFileScope" resolver is already configured')
      configured.push({ key, resolver })
      input.onConfigure?.(key, resolver)
    },
  }
  const ctx = { get: (name) => (name === 'typert' ? { lookups } : undefined) }
  return { ctx, configured }
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

test('账本里有这个会话就用账本目录，否则回退', () => {
  const paths = new Map([['s1', 'C:\\work\\b']])

  assert.equal(workspaceRootFor(paths, 's1', undefined), 'C:\\work\\b')
  assert.equal(workspaceRootFor(paths, 's2', 'C:\\work\\a'), 'C:\\work\\a')
  assert.equal(workspaceRootFor(paths, 's2', undefined), undefined)
  assert.equal(workspaceRootFor(new Map([['s1', '']]), 's1', 'fallback'), 'fallback')
  assert.equal(workspaceRootFor(undefined, 's1', 'fallback'), 'fallback')
})

test('接管 workspaceFileScope：移动过的会话按账本解析，其余交回默认策略', async () => {
  const registry = createRegistry([
    { id: 'ws-a', path: 'C:\\work\\a', sessionIds: [] },
    { id: 'ws-b', path: 'C:\\work\\b', sessionIds: ['moved'] },
  ])
  const provider = {
    parameter: 'workspaceFileScope',
    wire: 'workspaceFileScopeId',
    resolve: async (sessionId) => ({ sessionId, workspaceRoot: 'C:\\work\\original' }),
  }
  const { ctx, configured } = createTypert({ provider })

  const result = installWorkspaceScopeView(ctx, registry, undefined)

  assert.equal(result.installed, true)
  assert.equal(configured.length, 1)
  assert.equal(configured[0].key, 'workspaceFileScope')
  assert.deepEqual(
    await configured[0].resolver('moved'),
    { sessionId: 'moved', workspaceRoot: 'C:\\work\\b' },
  )
  assert.deepEqual(
    await configured[0].resolver('untouched'),
    { sessionId: 'untouched', workspaceRoot: 'C:\\work\\original' },
  )
})

test('账本随移动变化后，解析结果立刻跟上（不缓存旧目录）', async () => {
  const registry = createRegistry([
    { id: 'ws-a', path: 'C:\\work\\a', sessionIds: ['s1'] },
    { id: 'ws-b', path: 'C:\\work\\b', sessionIds: [] },
  ])
  const provider = { resolve: async (sessionId) => ({ sessionId, workspaceRoot: 'C:\\work\\a' }) }
  const { ctx, configured } = createTypert({ provider })
  installWorkspaceScopeView(ctx, registry, undefined)

  assert.equal((await configured[0].resolver('s1')).workspaceRoot, 'C:\\work\\a')

  // 模拟一次移动：只改账本，不动任何缓存。
  registry.table.get('ws-a').sessionIds = []
  registry.table.get('ws-b').sessionIds = ['s1']
  registry.list()[1].sessionIds = ['s1']

  assert.equal((await configured[0].resolver('s1')).workspaceRoot, 'C:\\work\\b')
})

test('typert 缺失时安静降级，不抛错', () => {
  const ctx = { get: () => undefined }
  const result = installWorkspaceScopeView(ctx, createRegistry([]), undefined)

  assert.equal(result.installed, false)
  assert.equal(result.reason, 'typert/unavailable')
})

test('lookups 形态不符时降级', () => {
  const ctx = { get: () => ({ lookups: {} }) }
  const result = installWorkspaceScopeView(ctx, createRegistry([]), undefined)

  assert.equal(result.installed, false)
  assert.equal(result.reason, 'typert/lookups-unavailable')
})

test('业务包没有注册 provider 时降级', () => {
  const { ctx } = createTypert({ provider: undefined })
  const result = installWorkspaceScopeView(ctx, createRegistry([]), undefined)

  assert.equal(result.installed, false)
  assert.equal(result.reason, 'workspaceFileScope/unregistered')
})

test('已被其他组合接管时降级（不重复配置、不抛错）', () => {
  const provider = { resolve: async () => undefined }
  const { ctx } = createTypert({ provider, failConfigure: true })
  const warnings = []
  const result = installWorkspaceScopeView(ctx, createRegistry([]), { warn: (message) => warnings.push(message) })

  assert.equal(result.installed, false)
  assert.equal(result.reason, 'workspaceFileScope/configure-failed')
  assert.equal(warnings.length, 1)
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
