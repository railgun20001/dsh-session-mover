/**
 * dsh-session-mover —— 工作目录同步的单元测试。
 *
 * 重点覆盖「旧宿主不写未知事件」这条边界：0.2.0-rc.2 没有
 * `workingDirectory` 服务，若插件仍直接 append `working-directory/change`，
 * 该事件会在日志里成为宿主不认识的类型，后续 fork / 读取都会拒绝解析。
 *
 * 运行：node test/workdir-test.mjs
 */

import assert from 'node:assert/strict'

import { syncWorkingDirectory } from '../lib/workdir.js'

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
 * 造一个最小上下文。
 *
 * @param {{
 *   agent?: object,
 *   workingDirectory?: object,
 *   session?: object,
 * }} input - 可用服务。
 * @returns {object} 上下文替身。
 */
function createContext(input) {
  const services = {
    agents: input.agent === undefined ? undefined : { get: () => input.agent },
    workingDirectory: input.workingDirectory,
    sessions: input.session === undefined ? undefined : { get: () => input.session },
  }
  return {
    get(name) {
      return services[name]
    },
  }
}

test('有 Agent 且宿主有 workingDirectory 服务：走官方 set', async () => {
  const calls = []
  const ctx = createContext({
    agent: { id: 'a' },
    workingDirectory: {
      async set(agent, path) {
        calls.push({ agent, path })
      },
    },
  })
  const result = await syncWorkingDirectory(ctx, 's1', 'C:/B')
  assert.equal(result, 'agent')
  assert.deepEqual(calls, [{ agent: { id: 'a' }, path: 'C:/B' }])
})

test('会话已加载但没有 Agent：有 workingDirectory 服务时补官方事件', async () => {
  const appended = []
  const ctx = createContext({
    workingDirectory: { set: async () => {} },
    session: { append: (type, data) => appended.push({ type, data }) },
  })
  const result = await syncWorkingDirectory(ctx, 's1', 'C:/B')
  assert.equal(result, 'session')
  assert.deepEqual(appended, [{ type: 'working-directory/change', data: { cwd: 'C:/B' } }])
})

test('旧宿主没有 workingDirectory 服务：不写未知事件，如实跳过', async () => {
  const appended = []
  const ctx = createContext({
    session: { append: (type, data) => appended.push({ type, data }) },
  })
  const result = await syncWorkingDirectory(ctx, 's1', 'C:/B')
  assert.equal(result, 'skipped')
  assert.deepEqual(appended, [])
})

test('会话不存在：跳过', async () => {
  const ctx = createContext({ workingDirectory: {} })
  const result = await syncWorkingDirectory(ctx, 'missing', 'C:/B')
  assert.equal(result, 'skipped')
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
