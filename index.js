/**
 * dsh-session-mover —— 宿主半。
 *
 * 职责有五件事：
 *
 * 1. **启动时重放归属账本**：把每个 workspace 记录里记着的会话，按记录所在
 *    目录灌回注册表的内存索引，让上一次会话里完成的移动跨重启保持。
 *    （会话的持久化 header 是只读的，所以归属的权威落在账本上；细节见
 *    `lib/core.js` 的模块注释。）
 *
 * 2. **移动日志与护栏**：每次移动/分叉登记到 `lib/journal.js`；`lib/guards.js`
 *    在官方 `mutate()` 写之前把账本灌回索引（否则官方剪枝会把移动过的会话
 *    永久从账本里删掉），并在 `attachSession()` 因 cwd 不匹配失败时按账本接管
 *    （否则「从移动过的会话分叉」会直接报 attach 失败）。
 *
 * 3. **把账本投影到读取侧**：`workingDirectory` 换掉的是 agent 的执行目录，
 *    而侧边文件树、「打开文件夹」用的是会话摘要里的 `cwd`（来自永不重写的
 *    header）。所以这里再补两块：用 typert 的 effect-scoped 覆盖点接管
 *    `workspaceFileScope`（宿主半认哪个目录算工作区根，见 `lib/view.js`），
 *    并对外提供一个只读的归属投影接口给客户端半改写摘要（见下）。
 *
 * 4. **提供内部 HTTP 路由**：客户端半拖拽落下时调用 `/api/move`，完成
 *    「改账本 → 同步工作目录 → 返回结果」；页面加载与每次移动后再取一次
 *    `/api/ownership`。桌面版的页面以 `dsh-app://` 协议装载，页面里的
 *    `fetch('/…')` 由壳层转发到宿主，因此客户端不需要任何端口或鉴权配置。
 *    另外提供 `/api/managed`（受管会话清单）与 `/api/restore`（一键还原）。
 *
 * 5. **启动自检**：数一数受管会话、目标目录是否还在、原目录是否已经消失，
 *    把「插件缺席就会掉组」这件事尽量提前变成可见的日志。
 *
 * 为什么不注册 Tool：这是**用户手势**触发的数据操作，不是模型任务的一部分；
 * 放进工具表只会增加模型的选择面，还会让权限体系去管一个纯 UI 动作。
 *
 * 路由只接受本机回环来源，与页面同源的请求（见 `trustedRequest`）。
 *
 * @module dsh-session-mover
 */

import { moveSessionInRegistry, ownershipPaths, replayOwnership, resolveRegistryParts } from './lib/core.js'
import { alignAgentWorkingDirectory, reconcileForkedSession } from './lib/fork.js'
import { installEntityGuards, withMoveInFlight } from './lib/guards.js'
import { createJournalStore, resolveJournalPath } from './lib/journal.js'
import {
  adoptExistingMoves,
  inspectManagedSessions,
  isDirectory,
  pruneJournal,
  restoreAllManaged,
  restoreManagedSession,
  summarizeManaged,
} from './lib/managed.js'
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

/**
 * 受管会话清单：`{ sessions: [...], summary: {...} }`。
 *
 * 「受管」= 被本插件移动过、header 还停在原目录的会话。排障与「一键还原」
 * 都用它；没有受管会话时返回空数组。
 */
const MANAGED_PATH = `${ROUTE_PREFIX}/api/managed`

/**
 * 还原接口：把受管会话搬回 header 里的原目录（原项目不在时回到未分组）。
 *
 * 请求体：`{ sessionId }` 还原一条；`{ all: true }` 一键还原全部。
 */
const RESTORE_PATH = `${ROUTE_PREFIX}/api/restore`

/** 每个路由允许的方法。 */
const ROUTE_METHODS = {
  [MOVE_PATH]: 'POST',
  [OWNERSHIP_PATH]: 'GET',
  [MANAGED_PATH]: 'GET',
  [RESTORE_PATH]: 'POST',
}

/** 请求体上限：只接受一个小 JSON，避免被当成任意上传通道。 */
const MAX_BODY_BYTES = 8 * 1024

/** 清单接口最多返回多少条（够排障，又不至于把响应撑大）。 */
const MANAGED_LIST_LIMIT = 500

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
 * 启动自检：把受管会话的现状写进日志。
 *
 * 这是「插件缺席就会掉组」的可见化手段：目标目录缺失、原目录被删这两类
 * 情况都会在这里明确告警，而不是等用户发现会话打不开。
 *
 * @param {{
 *   registry: unknown,
 *   journal: ReturnType<typeof createJournalStore>,
 *   logger: { info?: (message: string) => void, warn?: (message: string, error?: unknown) => void } | undefined,
 * }} input - 参数。
 * @returns {{ total: number, targetMissing: number, sourceMissing: number }} 汇总。
 */
function runSelfCheck({ registry, journal, logger }) {
  const rows = inspectManagedSessions({ registry, journal })
  const summary = summarizeManaged(rows)
  if (summary.total === 0) {
    logger?.info?.(`[${PKG}] 自检：暂无受管会话（移动日志 ${journal.path}）`)
    return summary
  }
  logger?.info?.(`[${PKG}] 自检：受管会话 ${summary.total} 个（目标目录缺失 ${summary.targetMissing}，原目录已不存在 ${summary.sourceMissing}）`)
  for (const row of rows) {
    if (row.targetExists === false) {
      logger?.warn?.(`[${PKG}] 受管会话 ${row.sessionId} 的目标目录不存在：${row.path}`)
    }
    if (row.sourceExists === false) {
      logger?.warn?.(`[${PKG}] 受管会话 ${row.sessionId} 的原目录已被删除：${row.headerCwd}（会话文件可能已随旧目录消失）`)
    }
  }
  return summary
}

/**
 * 插件入口：重放归属账本 + 装护栏 + 挂载路由 + 对齐分叉会话。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
function apply(ctx) {
  ctx.inject(['webServer', 'workspaceRegistry'], (scoped) => {
    const registry = scoped.workspaceRegistry
    const logger = scoped.logger

    // 移动日志：写前修复、启动自检与一键还原的事实来源。
    // 构造不读盘、不会抛错；文件损坏时按空日志继续。
    const journal = createJournalStore(resolveJournalPath(), logger)

    // 先记下注册表从 header 索引出来的目录：它是「会话原本属于哪里」的证据。
    // 随后的重放会把它按账本改指目标项目，所以必须在这之前快照。
    const partsBefore = resolveRegistryParts(registry)
    const before = partsBefore === null ? new Map() : new Map(partsBefore.paths)

    let replayed = { supported: false, applied: 0 }
    try {
      replayed = replayOwnership(registry)
    } catch (error) {
      logger?.warn?.(`[${PKG}] 重放归属账本失败（移动能力仍可尝试）`, error)
    }

    // 历史遗留的移动（升级前没有日志）补登记：之后才有依据做写前修复与还原。
    let adopted = 0
    try {
      adopted = adoptExistingMoves({ registry, journal, before })
    } catch (error) {
      logger?.warn?.(`[${PKG}] 登记历史移动失败（自检与还原可能少几条）`, error)
    }

    // 顺手清掉陈旧条目（会话已还原/被删/归属换到别的目录），避免日志无限增长。
    let pruned = 0
    try {
      pruned = pruneJournal({ registry, journal })
    } catch (error) {
      logger?.warn?.(`[${PKG}] 清理陈旧移动日志失败`, error)
    }

    // 两个护栏：写前修复（防剪枝）+ attach 接管（分叉兼容）。
    // 注册表还没有任何 workspace 时拿不到实体原型，退化为「稍后重试」。
    let guards = { installed: false, reason: 'registry/no-entity', dispose: () => {} }
    const installGuards = () => {
      if (guards.installed) return
      try {
        guards = installEntityGuards({ registry, journal, logger })
      } catch (error) {
        logger?.warn?.(`[${PKG}] 安装写前护栏失败（写前修复与 attach 接管不可用）`, error)
      }
    }
    installGuards()

    // 启动自检：把受管会话的现状（目标目录/原目录是否还在）写进日志。
    try {
      runSelfCheck({ registry, journal, logger })
    } catch (error) {
      logger?.warn?.(`[${PKG}] 启动自检失败`, error)
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
        installGuards()
        setImmediate(() => {
          void reconcileForkedSession(scoped, registry, session, logger, journal).catch((error) => {
            logger?.warn?.(`[${PKG}] 对齐分叉会话失败（分叉本身已成功）`, error)
          })
        })
      })
    } catch (error) {
      logger?.warn?.(`[${PKG}] 无法监听 session/created（分叉跟随项目不可用）`, error)
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
          void alignAgentWorkingDirectory(scoped, registry, agent, logger).catch((error) => {
            logger?.warn?.(`[${PKG}] 打开会话时对齐工作目录失败`, error)
          })
        })
      })
    } catch (error) {
      logger?.warn?.(`[${PKG}] 无法监听 agent/created（打开时对齐工作目录不可用）`, error)
    }

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const expected = ROUTE_METHODS[url.pathname]
        if (expected === undefined) {
          respond(response, 404, { ok: false, error: { code: 'route/not-found', message: '未知接口' } })
          return
        }
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

        if (url.pathname === MANAGED_PATH) {
          // 受管会话清单：排障与前端「还原」入口共用同一份数据。
          try {
            const rows = inspectManagedSessions({ registry, journal })
            respond(response, 200, {
              ok: true,
              sessions: rows.slice(0, MANAGED_LIST_LIMIT),
              summary: summarizeManaged(rows),
            })
          } catch (error) {
            respond(response, 500, {
              ok: false,
              error: { code: 'managed/failed', message: String(error?.message ?? error) },
            })
          }
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

        if (url.pathname === RESTORE_PATH) {
          // 还原：把受管会话搬回 header 里的原目录；原项目没了就回到未分组。
          try {
            if (body.all === true) {
              const results = await restoreAllManaged({ ctx: scoped, registry, journal, logger })
              respond(response, 200, {
                ok: true,
                restored: results.filter((item) => item.restored).length,
                results,
              })
              return
            }
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            if (sessionId.length === 0) {
              respond(response, 400, {
                ok: false,
                error: { code: 'request/invalid', message: 'sessionId 必须是非空字符串，或传 { all: true }' },
              })
              return
            }
            const result = await restoreManagedSession({ ctx: scoped, registry, journal, sessionId, logger })
            respond(response, 200, { ok: true, restored: result.restored ? 1 : 0, results: [{ sessionId, ...result }] })
          } catch (error) {
            logger?.warn?.(`[${PKG}] 还原受管会话失败`, error)
            respond(response, 500, {
              ok: false,
              error: { code: error?.code ?? 'restore/failed', message: String(error?.message ?? error) },
            })
          }
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
          // 目标目录不存在时直接拒绝：挪进去之后文件树、工作目录都会指向空目录，
          // 用户会以为「移动成功但会话坏了」。宁可在这里明确报错。
          const target = registry.get(workspaceId)
          if (target === undefined || target === null) {
            respond(response, 404, {
              ok: false,
              error: { code: 'workspace/not-found', message: '目标项目不存在（可能已被删除）' },
            })
            return
          }
          if (!isDirectory(target.path)) {
            respond(response, 409, {
              ok: false,
              error: { code: 'workspace/missing-dir', message: `目标项目目录不存在：${String(target.path)}` },
            })
            return
          }
          // 移动期间写前修复必须跳过这个 id，否则目标账本的剪枝会把刚挂进来的会话剔掉。
          const result = await withMoveInFlight(
            sessionId,
            () => moveSessionInRegistry(registry, sessionId, workspaceId, beforeSessionId),
          )
          let directory = 'skipped'
          if (switchDirectory) {
            try {
              directory = await syncWorkingDirectory(scoped, sessionId, result.workspace.path)
            } catch (error) {
              logger?.warn?.(`[${PKG}] 切换工作目录失败（归属已更新）`, error)
              directory = 'skipped'
            }
          }
          const fromPath = result.from === null ? undefined : registry.get(result.from.id)?.path
          if (result.changed) {
            // 登记受管会话：之后官方任何一次写都会先按这条记录修复索引，
            // 避免会话在无关操作（改名/排序/删除）里被静默剪掉。
            // `home` 记 header 里的原始目录（还原目标），`from` 记本次的来源项目。
            const existing = journal.entry(sessionId)
            const parts = resolveRegistryParts(registry)
            const headerCwd = parts?.headers?.get(sessionId)?.cwd
            const home = existing?.home
              ?? (typeof before.get(sessionId) === 'string' ? before.get(sessionId) : undefined)
              ?? (typeof headerCwd === 'string' && headerCwd.length > 0 ? headerCwd : undefined)
            journal.record(sessionId, {
              path: result.workspace.path,
              ...(typeof home === 'string' && home.length > 0 ? { home } : {}),
              ...(typeof fromPath === 'string' && fromPath.length > 0 ? { from: fromPath } : {}),
              kind: 'move',
            })
            journal.save()
          }
          respond(response, 200, {
            ok: true,
            sessionId,
            changed: result.changed,
            alreadyThere: result.alreadyThere,
            workspace: result.workspace,
            from: result.from,
            ...(typeof fromPath === 'string' && fromPath.length > 0 ? { fromPath } : {}),
            workingDirectory: directory,
          })
        } catch (error) {
          logger?.warn?.(`[${PKG}] 移动会话失败`, error)
          respond(response, 500, {
            ok: false,
            error: { code: error.code ?? 'move/failed', message: String(error.message ?? error) },
          })
        }
      },
    }), `${PKG}: 移动路由`)

    scoped.logger?.info?.(`[${PKG}] 已挂载：${MOVE_PATH}（归属账本修正 ${replayed.applied} 条，支持=${replayed.supported}；新登记 ${adopted} 条历史移动，清理 ${pruned} 条陈旧日志；写前护栏=${guards.installed ? guards.reason : '未安装'}）`)

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

    // 卸载时撤掉护栏并落盘日志：护栏是挂在官方原型上的，必须还原，
    // 否则插件重载会叠加多层补丁。
    scoped.effect(() => () => {
      try {
        guards.dispose()
      } catch (error) {
        scoped.logger?.warn?.(`[${PKG}] 撤销写前护栏失败`, error)
      }
      journal.save()
    })
  })
}

export const inject = ['webServer']
export { apply }
