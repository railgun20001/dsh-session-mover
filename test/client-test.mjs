/**
 * dsh-session-mover —— 客户端半「会话摘要 cwd 投影」的单元测试。
 *
 * 客户端半是一个浏览器 bundle factory（`window.__ModuleLoader__.load`），
 * 这里用一个最小的假宿主把它加载起来：
 *   - 假的 `window` / `document` / `fetch`：只提供 apply 真正用到的那几项；
 *   - 假的 `sessions` 服务：`list` 是一个只有 `set` 的快照存储；
 *   - 假的 `ctx`：`effect` / `locale` / `slots` / `inject` 都退化成直通。
 *
 * 断言的是「改写后的快照」本身——也就是侧边文件树与「打开文件夹」真正读到的
 * `cwd`。
 *
 * 运行：node test/client-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const CLIENT_SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

/**
 * 把客户端 bundle 加载成一个可用的模块（每次调用都是全新实例）。
 *
 * @param {{ paths?: Record<string, string> | null, fail?: boolean }} input - 归属接口的响应内容。
 * @returns {{ store: object, calls: string[] }} 假快照存储与请求记录。
 */
function loadClient(input = {}) {
  let factory
  const windowStub = {
    __ModuleLoader__: { load: (spec) => { factory = spec.factory } },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
  }
  const documentStub = {
    createElement: () => ({ dataset: {}, textContent: '', style: {}, remove() {} }),
    head: { appendChild() {} },
    body: { classList: { add() {}, remove() {} } },
  }
  const calls = []
  const fetchStub = async (url) => {
    calls.push(url)
    if (input.fail === true) return { ok: false, async json() { return null } }
    return { ok: true, async json() { return { ok: true, paths: input.paths ?? {} } } }
  }

  // client.js 只依赖 window/document/fetch/console 四个全局，用 Function 包一层即可。
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'fetch', 'console', CLIENT_SOURCE)
  run(windowStub, documentStub, fetchStub, console)

  const reactStub = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  const moduleExports = factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`未预期的依赖：${name}`)
  })

  const store = {
    snapshot: null,
    set(snapshot) {
      this.snapshot = snapshot
    },
  }
  const sessions = { list: store, refresh() {} }
  const ctx = {
    effect: (run) => {
      const disposer = run()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: () => {}, register: () => () => {} },
    inject: (_deps, callback) => callback({
      get: (name) => (name === 'sessions' ? sessions : undefined),
    }),
  }

  moduleExports.apply(ctx)
  return { store, calls }
}

/**
 * 造一份最小化的会话列表快照。
 *
 * @param {Record<string, { cwd?: string }>} rows - 每个会话的原始摘要字段。
 * @returns {object} 快照。
 */
function snapshotOf(rows) {
  const byId = {}
  for (const [sessionId, row] of Object.entries(rows)) {
    byId[sessionId] = { sessionId, title: sessionId, updatedAt: 1, blank: false, running: false, agentAvailable: false, ...row }
  }
  return { ids: Object.keys(rows), byId, phase: 'ready', projectionsBySession: {} }
}

/** 让 refreshOwnership 的 async 流程跑完（含一次 setTimeout 排程）。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 0))
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

test('账本里有账的会话按账本改写 cwd，其余保持不变', async () => {
  const { store, calls } = loadClient({ paths: { moved: 'C:\\work\\project-b' } })
  await settle()

  assert.deepEqual(calls, ['/dsh-session-mover/api/ownership'])

  const raw = snapshotOf({
    moved: { cwd: 'C:\\work\\project-a' },
    untouched: { cwd: 'C:\\work\\project-a' },
  })
  store.set(raw)

  assert.equal(store.snapshot.byId.moved.cwd, 'C:\\work\\project-b')
  assert.equal(store.snapshot.byId.untouched.cwd, 'C:\\work\\project-a')
  // 原快照不被就地修改。
  assert.equal(raw.byId.moved.cwd, 'C:\\work\\project-a')
})

test('同一份原快照重复写入，改写结果保持同一身份（不制造多余重渲染）', async () => {
  const { store } = loadClient({ paths: { moved: 'C:\\work\\project-b' } })
  await settle()

  const raw = snapshotOf({ moved: { cwd: 'C:\\work\\project-a' } })
  store.set(raw)
  const first = store.snapshot
  store.set(raw)

  assert.equal(store.snapshot, first)
})

test('账本目录与会话原 cwd 相同时，快照原样返回', async () => {
  const { store } = loadClient({ paths: { same: 'C:\\work\\project-a' } })
  await settle()

  const raw = snapshotOf({ same: { cwd: 'C:\\work\\project-a' } })
  store.set(raw)

  assert.equal(store.snapshot, raw)
})

test('归属接口失败时完全不改写', async () => {
  const { store } = loadClient({ fail: true })
  await settle()

  const raw = snapshotOf({ moved: { cwd: 'C:\\work\\project-a' } })
  store.set(raw)

  assert.equal(store.snapshot, raw)
  assert.equal(store.snapshot.byId.moved.cwd, 'C:\\work\\project-a')
})

test('没有 cwd 的会话也能被账本补上目录', async () => {
  const { store } = loadClient({ paths: { fresh: 'C:\\work\\project-b' } })
  await settle()

  store.set(snapshotOf({ fresh: {} }))

  assert.equal(store.snapshot.byId.fresh.cwd, 'C:\\work\\project-b')
})

test('行对象换了（例如 running 从 false 变 true）时，改写结果必须跟着换', async () => {
  const { store } = loadClient({ paths: { moved: 'C:\\work\\project-b' } })
  await settle()

  // 第一帧：会话还没开始跑。
  store.set(snapshotOf({ moved: { cwd: 'C:\\work\\project-a', running: false } }))
  assert.equal(store.snapshot.byId.moved.running, false)

  // 第二帧：宿主推来新的行对象（running 变 true），cwd 仍是 header 里的旧目录。
  // 改写必须基于新行，不能命中午夜之前那份「running=false」的缓存。
  store.set(snapshotOf({ moved: { cwd: 'C:\\work\\project-a', running: true } }))

  assert.equal(store.snapshot.byId.moved.running, true)
  assert.equal(store.snapshot.byId.moved.cwd, 'C:\\work\\project-b')
})

test('未变化的行对象重复写入时复用同一份改写结果', async () => {
  const { store } = loadClient({ paths: { moved: 'C:\\work\\project-b' } })
  await settle()

  const raw = snapshotOf({ moved: { cwd: 'C:\\work\\project-a', running: true } })
  store.set(raw)
  const firstRow = store.snapshot.byId.moved

  // 宿主只换了 id 顺序（同一批行对象），改写结果应复用同一行。
  store.set({ ...raw, ids: [...raw.ids] })
  assert.equal(store.snapshot.byId.moved, firstRow)
})

test('列表里出现新会话（例如刚分叉）时重新取一次归属投影', async () => {
  const { store, calls } = loadClient({ paths: { moved: 'C:\\work\\project-b' } })
  await settle()
  assert.equal(calls.length, 1)

  // 老会话的刷新不该触发额外请求。
  store.set(snapshotOf({ moved: { cwd: 'C:\\work\\project-a' } }))
  await settle()
  assert.equal(calls.length, 1)

  // 新出现的会话（分叉子会话）需要一次新的归属投影，否则它只能带着父会话的
  // header cwd，文件树/打开文件夹仍落在旧目录。
  store.set(snapshotOf({ moved: { cwd: 'C:\\work\\project-a' }, child: { cwd: 'C:\\work\\project-a' } }))
  await settle()
  assert.equal(calls.length, 2)
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
