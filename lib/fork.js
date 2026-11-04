/**
 * dsh-session-mover —— 分叉出来的子会话也要跟着父会话的项目走。
 *
 * ## 为什么需要它
 *
 * DSH 的「分叉会话」是**复制一段事件前缀 + 新建一个会话**：新会话的 header 里
 * 写的 cwd 是父会话 header 里的**原始 cwd**（`source.header.cwd`），而不是父会话
 * 当前的工作目录（`workingDirectory` 投影）。
 *
 * 对于没被移动过的会话这没问题（原始 cwd 就是项目目录）。但被移动过的会话是
 * 「账本在项目 B、header 还停在项目 A」：它分叉出来的子会话于是带着 A 的 cwd，
 * 出现两个后果：
 *
 *   1. **分组掉队**：宿主给客户端的 `workspace.sessionIds` 会按内存索引
 *      `sessionPaths` 过滤成员（`candidateMatches`）；子会话没走 `rememberSessionPath`
 *      登记，索引里没有它（或还是父会话的旧目录），于是侧栏把它从新项目里过滤掉，
 *      看起来「分叉的新对话还在老工作区」；
 *   2. **工作目录错**：子会话的 Agent 在父会话的旧目录里跑工具、开文件树。
 *
 * ## 怎么做
 *
 * 在 `session/created`（延迟一拍，等官方 `attachSession` 走完）后对齐三件事：
 *   账本归属 → 内存索引 → 工作目录，全部指向父会话所属项目的目录。
 *
 * 全部按「能对齐就对齐、不能就跳过」处理：父会话未分组、目标项目被删、
 * Agent 还没起来，都只是少做一步，绝不抛错影响分叉本身。
 *
 * @module dsh-session-mover/lib/fork
 */

import { moveSessionInRegistry, ownershipPaths, resolveRegistryParts } from './core.js'
import { withMoveInFlight } from './guards.js'
import { syncWorkingDirectory } from './workdir.js'

/**
 * 会话被打开（Agent 创建）时，把工作目录对齐到它所属项目的目录。
 *
 * 这是「分叉跟随父项目」的补洞：`session/created` 那一拍只能对齐当时在场的
 * 会话；更早分叉出来、当时没对齐成功的子会话（或者被移动过、但移动那一刻
 * 没有存活 Agent 的会话）会在下次打开时才拥有 Agent。这里在 Agent 刚创建、
 * 还没有任何工具调用之前把目录切过去，避免它继续在旧目录里干活。
 *
 * 已经是目标目录时什么都不做（`workingDirectory.set()` 内部也会短路）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {{ session?: { id?: unknown } } | undefined} agent - 新建的 Agent。
 * @param {{ info?: (message: string) => void, warn?: (message: string, error?: unknown) => void } | undefined} logger - 日志。
 * @returns {Promise<{ changed: string[], path?: string, reason?: string }>} 是否切过目录。
 */
export async function alignAgentWorkingDirectory(ctx, registry, agent, logger) {
  const session = agent?.session
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { changed: [], reason: 'agent/unreadable' }

  const path = ownershipPaths(registry).get(sessionId)
  if (typeof path !== 'string' || path.length === 0) return { changed: [], reason: 'session/ungrouped' }

  const workingDirectory = ctx.get('workingDirectory')
  const current = typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : undefined
  if (current === path) return { changed: [], path }

  const directory = await syncWorkingDirectory(ctx, sessionId, path)
  if (directory !== 'skipped') {
    logger?.info?.(`[dsh-session-mover] 会话 ${sessionId} 打开时工作目录已对齐 ${JSON.stringify(path)}（${directory}）`)
    return { changed: ['workdir'], path }
  }
  return { changed: [], path, reason: 'workdir/skipped' }
}


/**
 * 判断一个刚创建的会话是不是「需要跟随父项目的分叉」。
 *
 * 只看三个稳定的 header 事实，不做任何猜测：
 *   - `isSeeded`：分叉产生的会话一定带种子（普通新会话没有）；
 *   - `parentSession`：分叉的父会话；
 *   - `origin !== 'subagent'`：子代理会话有自己的生命周期，不归项目分组管。
 *
 * @param {{ id?: unknown, header?: unknown }} session - 新会话（宿主 Session 对象）。
 * @returns {{ sessionId: string, parentId: string, cwd: string | undefined } | null} 可处理时的关键字段。
 */
export function forkFactsOf(session) {
  const header = session?.header
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (header === null || typeof header !== 'object') return null
  if (header.isSeeded !== true) return null
  if (header.origin === 'subagent') return null
  const parentId = header.parentSession
  if (typeof parentId !== 'string' || parentId.length === 0) return null
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
  return { sessionId, parentId, cwd }
}

/**
 * 把分叉出来的子会话对齐到父会话所属项目。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（取 `agents` / `sessions` / `workingDirectory`）。
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {{ id?: unknown, header?: unknown }} session - 刚创建的新会话。
 * @param {{ info?: (message: string) => void, warn?: (message: string, error?: unknown) => void } | undefined} logger - 日志。
 * @param {ReturnType<import('./journal.js').createJournalStore>} [journal] - 移动日志（用于后续写前修复与还原）。
 * @returns {Promise<{
 *   changed: string[],
 *   reason?: string,
 *   path?: string,
 *   workingDirectory?: 'agent' | 'session' | 'skipped',
 * }>} 做了哪些对齐（`changed` 可能是空数组）。
 */
export async function reconcileForkedSession(ctx, registry, session, logger, journal) {
  const facts = forkFactsOf(session)
  if (facts === null) return { changed: [], reason: 'not-a-fork' }

  const { sessionId, parentId, cwd } = facts
  const ledger = ownershipPaths(registry)
  const parentPath = ledger.get(parentId)
  if (typeof parentPath !== 'string' || parentPath.length === 0) return { changed: [], reason: 'parent/ungrouped' }

  const changed = []

  // ① 账本归属：子会话已经被记在父会话的项目里就只修索引，否则整条 adopt 过来。
  const currentPath = ledger.get(sessionId)
  if (currentPath === parentPath) {
    const parts = resolveRegistryParts(registry)
    if (parts !== null && parts.paths.get(sessionId) !== parentPath) {
      parts.paths.set(sessionId, parentPath)
      changed.push('index')
    }
  } else {
    const target = registry.list().find((workspace) => workspace.path === parentPath)
    if (target === undefined) return { changed: [], reason: 'workspace/missing' }
    // 移动期间跳过写前修复（否则目标账本的剪枝会把刚挂进来的会话剔掉）。
    await withMoveInFlight(sessionId, () => moveSessionInRegistry(registry, sessionId, target.id))
    changed.push('ledger')
  }

  // ② 工作目录：子会话 header 里的 cwd 是父会话的原始目录，切到项目目录去。
  if (cwd !== parentPath) {
    const directory = await syncWorkingDirectory(ctx, sessionId, parentPath)
    if (directory !== 'skipped') changed.push('workdir')
    // 子会话进入「账本在新项目、header 还在旧目录」的分叉状态，必须登记：
    // 后续的写前修复与一键还原都靠这条记录。注意只要 cwd 与项目目录不同就要记，
    // 哪怕账本本来就已经在父项目（此时只补了索引，同样是分叉状态）。
    if (journal !== undefined && journal !== null) {
      const existing = journal.entry(sessionId)
      journal.record(sessionId, {
        path: parentPath,
        ...(existing?.home === undefined && cwd !== undefined ? { home: cwd } : {}),
        ...(cwd !== undefined ? { from: cwd } : {}),
        kind: 'fork',
      })
      journal.save()
    }
    logger?.info?.(`[dsh-session-mover] 分叉会话 ${sessionId} 跟随到 ${JSON.stringify(parentPath)}（${changed.join('+')}；工作目录=${directory}）`)
    return { changed, path: parentPath, workingDirectory: directory }
  }

  if (changed.length > 0) {
    logger?.info?.(`[dsh-session-mover] 分叉会话 ${sessionId} 归属已对齐 ${JSON.stringify(parentPath)}（${changed.join('+')}）`)
  }
  return { changed, path: parentPath }
}
