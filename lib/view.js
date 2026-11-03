/**
 * dsh-session-mover —— 读取侧的「工作区视图」。
 *
 * ## 为什么需要这一层
 *
 * DSH 里「会话属于哪个目录」有两处权威：
 *
 *   1. 会话自己的持久化 header（`cwd`）：写一次就永不重写，因为 JSONL 日志
 *      按 cwd 分目录、已提交的 header 是只读事实；
 *   2. workspace 注册表里的归属账本（`sessionIds`）。
 *
 * 官方语义是「二者一致」——会话在被创建的那个目录里产生，所以归属可以由
 * header 的 cwd 推出来。本插件把账本当权威（见 `lib/core.js`），于是二者会
 * 分叉：账本说会话在项目 B，header 还停在项目 A。
 *
 * 分叉本身不伤人，直到**读取侧**按 header cwd 去算东西。宿主半里唯一这样的
 * 地方是文件系统接口：`workspaceFiles` 用一个 typert lookup
 * （`workspaceFileScope`）把会话解析成 `{ sessionId, workspaceRoot }`，
 * 之后所有列目录、读文件、盯变化的请求都要落在 `workspaceRoot` 之内，
 * 越界直接报 `workspace-file/outside-workspace`。所以在移动之后，侧边文件树
 * 仍然只能看到旧目录。
 *
 * ## 接法：官方支持的覆盖点
 *
 * `typert.lookups` 明确区分「业务包注册的声明与默认策略」和「Host 组合用
 * effect-scoped `configure()` 覆盖的解析行为」（见 `@deepseek-ai/dsh-api-gateway`
 * 与 `@deepseek-ai/dsh-typert-registry` 的说明）。业务包 `register()` 时给出的
 * `resolve` 就是默认策略，Host 侧可以接管解析而不必改它：
 *
 *   - 覆盖是 `ctx.effect(...)` 作用域内的，插件卸载即撤除；
 *   - 声明（wire 字段、类型符号）保持不变，Gateway 的严格校验照常通过；
 *   - 同一个 key 只能有一个覆盖者，重复配置会直接抛错——所以这里必须
 *     try/catch，把「已被别人接管」当成降级，绝不能连累移动本身。
 *
 * 解析时仍然**先问账本**：账本里没有这个会话（或结构不支持）就原样交回给
 * 默认策略，未移动过的会话行为完全不变。
 *
 * @module dsh-session-mover/lib/view
 */

import { ownershipPaths } from './core.js'

/** 要覆盖的查找参数名：文件系统接口用它把会话解析成工作区根。 */
export const WORKSPACE_SCOPE_LOOKUP = 'workspaceFileScope'

/**
 * 按账本决定一个会话的工作区根。
 *
 * 抽成纯函数，方便测试，也让「账本优先、否则回退」这条唯一规则只写一遍。
 *
 * @param {Map<string, string>} paths - 归属账本投影（`ownershipPaths()` 的结果）。
 * @param {string} sessionId - 会话标识。
 * @param {unknown} fallback - 账本里没有该会话时应当返回的值。
 * @returns {unknown} 账本目录，或 `fallback`。
 */
export function workspaceRootFor(paths, sessionId, fallback) {
  if (!(paths instanceof Map)) return fallback
  const path = paths.get(sessionId)
  return typeof path === 'string' && path.length > 0 ? path : fallback
}

/**
 * 安装读取侧的工作区视图：让文件系统接口按归属账本解析工作区根。
 *
 * 失败一律降级（返回 `installed: false` 与原因）：文件树继续指向 header 里
 * 的原始目录，等于回到本插件没覆盖读取侧时的行为，不会更糟。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（需要能取到 `typert`）。
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {{ warn?: (message: string, error?: unknown) => void } | undefined} logger - 日志。
 * @returns {{ installed: boolean, reason: string }} 安装结果与说明。
 */
export function installWorkspaceScopeView(ctx, registry, logger) {
  let typert
  try {
    typert = ctx.get('typert')
  } catch (error) {
    logger?.warn?.('[dsh-session-mover] 取不到 typert 服务，文件树仍按会话 header 解析目录', error)
    return { installed: false, reason: 'typert/unavailable' }
  }

  const lookups = typert?.lookups
  if (typert === undefined || typert === null) return { installed: false, reason: 'typert/unavailable' }
  if (lookups === null || typeof lookups !== 'object'
    || typeof lookups.get !== 'function' || typeof lookups.configure !== 'function') {
    return { installed: false, reason: 'typert/lookups-unavailable' }
  }

  // 先拿默认策略：覆盖之后 `get()` 返回的是拼好的 provider，原始 resolve 就拿不到了。
  const provider = lookups.get(WORKSPACE_SCOPE_LOOKUP)
  if (provider === null || typeof provider !== 'object' || typeof provider.resolve !== 'function') {
    return { installed: false, reason: 'workspaceFileScope/unregistered' }
  }
  const resolveDefault = provider.resolve.bind(provider)

  try {
    lookups.configure(WORKSPACE_SCOPE_LOOKUP, async (sessionId) => {
      const root = workspaceRootFor(ownershipPaths(registry), sessionId, undefined)
      if (root !== undefined) return { sessionId, workspaceRoot: root }
      return await resolveDefault(sessionId)
    })
  } catch (error) {
    logger?.warn?.('[dsh-session-mover] 覆盖 workspaceFileScope 失败（文件树仍按会话 header 解析目录）', error)
    return { installed: false, reason: 'workspaceFileScope/configure-failed' }
  }

  return { installed: true, reason: 'configured' }
}
