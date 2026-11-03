/**
 * dsh-session-mover —— 宿主半。
 *
 * 职责只有三件事：
 *
 * 1. **启动时重放归属账本**：把每个 workspace 记录里记着的会话，按记录所在
 *    目录灌回注册表的内存索引，让上一次会话里完成的移动跨重启保持。
 *    （会话的持久化 header 是只读的，所以归属的权威落在账本上；细节见
 *    `lib/core.js` 的模块注释。）
 *
 * 2. **把账本投影到读取侧**：`workingDirectory` 换掉的是 agent 的执行目录，
 *    而侧边文件树、「打开文件夹」用的是会话摘要里的 `cwd`（来自永不重写的
 *    header）。所以这里再补两块：用 typert 的 effect-scoped 覆盖点接管
 *    `workspaceFileScope`（宿主半认哪个目录算工作区根，见 `lib/view.js`），
 *    并对外提供一个只读的归属投影接口给客户端半改写摘要（见下）。
 *
 * 3. **提供内部 HTTP 路由**：客户端半拖拽落下时调用 `/api/move`，完成
 *    「改账本 → 同步工作目录 → 返回结果」；页面加载与每次移动后再取一次
 *    `/api/ownership`。桌面版的页面以 `dsh-app://` 协议装载，页面里的
 *    `fetch('/…')` 由壳层转发到宿主，因此客户端不需要任何端口或鉴权配置。
 *
 * 为什么不注册 Tool：这是**用户手势**触发的数据操作，不是模型任务的一部分；
 * 放进工具表只会增加模型的选择面，还会让权限体系去管一个纯 UI 动作。
 *
 * 路由只接受本机回环来源，与页面同源的请求（见 `trustedRequest`）。
 *
 * @module dsh-session-mover
 */

import { moveSessionInRegistry, ownershipPaths, replayOwnership } from './lib/core.js'
import { alignAgentWorkingDirectory, reconcileForkedSession } from './lib/fork.js'
import { installWorkspaceScopeView } from './lib/view.js'
import { syncWorkingDirectory } from './lib/workdir.js'

/** 包名：日志前缀与路由前缀都用它。 */
const PKG = 'dsh-session-mover'

/** 内部路由前缀（`kind: 'prefix'` 交给 webServer 的挂载点）。 */
const ROUTE_PREFIX = `/${PKG}`

/** 移动接口的完整路径。 */
const MOVE_PATH = `${ROUTE_PREFIX}/api/move`

/**
 * 归属投影接口：把账本摊成 `{ sessionId: 目录 }` 交给客户端半。
 *
 * 客户端不能自己推出这张表（`session.list` 的 `cwd` 来自会话 header），
 * 所以由宿主如实提供；只读、无副作用。
 */
const OWNERSHIP_PATH = `${ROUTE_PREFIX}/api/ownership`

/** 请求体上限：只接受一个小 JSON，避免被当成任意上传通道。 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * 判断请求是否来自本机同源页面。
 *
 * 桌面壳会把页面请求转发到宿主，因此 `Origin` 可能缺失；缺失时退化为
 * 「回环地址 + 有 Host 头」，浏览器发起的跨站请求一定带 Origin，可被拦下。
 *
 * @param {import('node:http').IncomingMessage} request - 入站请求。
 * @returns {boolean} 是否可信。
 */
export function trustedRequest(request) {
  const peer = request.socket?.remoteAddress ?? ''
  const loopback = peer === '::1' || peer === '127.0.0.1' || peer === '::ffff:127.0.0.1'
  if (!loopback) return false
  const host = request.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return false
    return parsed.host === host || parsed.host === ''
  } catch {
    return false
  }
}

/**
 * 读一个受大小限制的 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} request - 入站请求。
 * @returns {Promise<Record<string, unknown>>} 解析结果；空体返回空对象。
 * @throws {Error} 超限或 JSON 非法时抛出。
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大')
      error.code = 'body/too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('请求体必须是 JSON 对象')
    error.code = 'body/invalid'
    throw error
  }
  return parsed
}

/**
 * 写一个 JSON 响应（连接已断开时静默忽略）。
 *
 * @param {import('node:http').ServerResponse} response - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 响应体。
 */
function respond(response, status, body) {
  try {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(body))
  } catch {
    /* 连接已经断开：忽略 */
  }
}

/**
 * 插件入口：重放归属账本 + 挂载移动路由 + 对齐分叉会话。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
function apply(ctx) {
  ctx.inject(['webServer', 'workspaceRegistry'], (scoped) => {
    const registry = scoped.workspaceRegistry
    let replayed = { supported: false, applied: 0 }
    try {
      replayed = replayOwnership(registry)
    } catch (error) {
      scoped.logger?.warn?.(`[${PKG}] 重放归属账本失败（移动能力仍可尝试）`, error)
    }

    // 分叉会话跟随父会话的项目。
    //
    // DSH 的分叉把父会话 header 里的**原始 cwd** 写给子会话，所以从「移动过的
    // 会话」分叉出来的新对话会带着旧目录：既进不了宿主的内存成员索引（侧栏据此
    // 过滤，于是看起来还挂在老工作区），Agent 也在旧目录里跑。这里等官方
    // `attachSession` 走完（下一拍）再对齐账本、索引与工作目录，细节见
    // `lib/fork.js`。失败只记日志，绝不影响分叉本身。
    try {
      scoped.on('session/created', (session) => {
        setImmediate(() => {
          void reconcileForkedSession(scoped, registry, session, scoped.logger).catch((error) => {
            scoped.logger?.warn?.(`[${PKG}] 对齐分叉会话失败（分叉本身已成功）`, error)
          })
        })
      })
    } catch (error) {
      scoped.logger?.warn?.(`[${PKG}] 无法监听 session/created（分叉跟随项目不可用）`, error)
    }

    // 会话被打开时再对齐一次工作目录。
    //
    // 上面那一拍只能对齐「刚创建」的会话；更早分叉出来、当时没对齐成功的子会话，
    // 以及「移动那一刻还没有存活 Agent」的会话，都要等下一次打开才有 Agent。这里
    // 在 Agent 刚创建、还没有任何工具调用之前把目录切到项目目录。
    try {
      scoped.on('agent/created', (payload) => {
        const agent = payload?.agent
        setImmediate(() => {
          void alignAgentWorkingDirectory(scoped, registry, agent, scoped.logger).catch((error) => {
            scoped.logger?.warn?.(`[${PKG}] 打开会话时对齐工作目录失败`, error)
          })
        })
      })
    } catch (error) {
      scoped.logger?.warn?.(`[${PKG}] 无法监听 agent/created（打开时对齐工作目录不可用）`, error)
    }

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const known = url.pathname === MOVE_PATH || url.pathname === OWNERSHIP_PATH
        if (!known) {
          respond(response, 404, { ok: false, error: { code: 'route/not-found', message: '未知接口' } })
          return
        }
        const expected = url.pathname === MOVE_PATH ? 'POST' : 'GET'
        if (request.method !== expected) {
          respond(response, 405, { ok: false, error: { code: 'method/not-allowed', message: `只接受 ${expected}` } })
          return
        }
        if (!trustedRequest(request)) {
          respond(response, 403, { ok: false, error: { code: 'request/untrusted', message: '只接受本机页面发起的请求' } })
          return
        }

        if (url.pathname === OWNERSHIP_PATH) {
          // 归属投影：客户端半据此改写会话摘要里的 cwd（文件树根、打开文件夹目标）。
          const paths = ownershipPaths(registry)
          respond(response, 200, { ok: true, paths: Object.fromEntries(paths) })
          return
        }

        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          respond(response, 400, {
            ok: false,
            error: { code: error.code ?? 'body/invalid', message: String(error.message ?? error) },
          })
          return
        }

        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
        const beforeSessionId = typeof body.beforeSessionId === 'string' && body.beforeSessionId.length > 0
          ? body.beforeSessionId.trim()
          : undefined
        const switchDirectory = body.switchDirectory !== false
        if (sessionId.length === 0 || workspaceId.length === 0) {
          respond(response, 400, {
            ok: false,
            error: { code: 'request/invalid', message: 'sessionId 与 workspaceId 都必须是非空字符串' },
          })
          return
        }

        try {
          const result = await moveSessionInRegistry(registry, sessionId, workspaceId, beforeSessionId)
          let directory = 'skipped'
          if (switchDirectory) {
            try {
              directory = await syncWorkingDirectory(scoped, sessionId, result.workspace.path)
            } catch (error) {
              scoped.logger?.warn?.(`[${PKG}] 切换工作目录失败（归属已更新）`, error)
              directory = 'skipped'
            }
          }
          respond(response, 200, {
            ok: true,
            changed: result.changed,
            alreadyThere: result.alreadyThere,
            workspace: result.workspace,
            from: result.from,
            workingDirectory: directory,
          })
        } catch (error) {
          scoped.logger?.warn?.(`[${PKG}] 移动会话失败`, error)
          respond(response, 500, {
            ok: false,
            error: { code: error.code ?? 'move/failed', message: String(error.message ?? error) },
          })
        }
      },
    }), `${PKG}: 移动路由`)

    scoped.logger?.info?.(`[${PKG}] 已挂载：${MOVE_PATH}（归属账本修正 ${replayed.applied} 条，支持=${replayed.supported}）`)

    // 读取侧工作区视图：等 typert 就绪后接管 `workspaceFileScope`。
    //
    // 用嵌套 inject 而不是把它并进外层依赖：移动与路由完全不依赖 typert，
    // 不该被它阻塞；接管失败也只是降级（文件树回到按会话 header 解析），
    // 绝不能连累移动本身。
    try {
      scoped.inject(['typert'], (typed) => {
        let result
        try {
          result = installWorkspaceScopeView(typed, registry, scoped.logger)
        } catch (error) {
          scoped.logger?.warn?.(`[${PKG}] 安装工作区视图失败（文件树仍按会话 header 解析目录）`, error)
          return
        }
        scoped.logger?.info?.(result.installed
          ? `[${PKG}] 读取侧已接管 workspaceFileScope：文件树与「打开文件夹」按归属账本解析目录`
          : `[${PKG}] 读取侧未接管（${result.reason}）：文件树仍按会话 header 解析目录`)
      })
    } catch (error) {
      scoped.logger?.warn?.(`[${PKG}] 无法声明 typert 依赖（读取侧视图不可用）`, error)
    }
  })
}

export const inject = ['webServer']
export { apply }
