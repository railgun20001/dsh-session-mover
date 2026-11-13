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
 * 独立分叉（0.2.1-rc.3+）省略了 `parentSession`。当前版本按「官方已安置归属 /
 * 护栏接管日志优先，seed 已知来源需目标项目同源印证，最后才是唯一原始目录候选」
 * 判定；普通分叉不会被误挂到别的项目。细节见 `lib/fork-origin.js`，历史会话
 * 的启动补登记见 `lib/backfill.js`。
 *
 * 全部按「能对齐就对齐、不能就跳过」处理：父会话未分组、目标项目被删、
 * Agent 还没起来，都只是少做一步，绝不抛错影响分叉本身。
 *
 * @module dsh-session-mover/lib/fork
 */

import { moveSessionInRegistry, ownershipPaths, resolveRegistryParts } from './core.js'
import {
  hasManagedHome,
  independentForkSourceId,
  resolveIndependentForkPath,
} from './fork-origin.js'
import { withMoveInFlight } from './guards.js'
import { samePath } from './managed.js'
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
 * 判断一个刚创建的会话是不是「需要跟随父项目的分叉」，并取它的关键字段。
 *
 * 旧版分叉按 `parentSession` 认亲；0.2.1-rc.3+ 的普通分叉省略了来源字段，
 * 但 seed 继承前缀里的 `delivery-accepted.data.sessionId` 仍保留已知来源
 * （`independentForkSourceId`）。两者都拿不到时不猜来源，由
 * {@link resolveIndependentForkPath} 在唯一目录候选成立时兜底。
 *
 * @param {{ id?: unknown, header?: unknown }} session - 新会话（宿主 Session 对象）。
 * @returns {{
 *   sessionId: string,
 *   parentId: string | undefined,
 *   parentFromHeader: boolean,
 *   cwd: string | undefined,
 * } | null} 可处理时的关键字段。
 */
export function forkFactsOf(session) {
  const header = session?.header
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (header === null || typeof header !== 'object') return null
  if (header.isSeeded !== true) return null
  if (header.origin === 'subagent') return null
  const explicitParent = typeof header.parentSession === 'string' && header.parentSession.length > 0
    ? header.parentSession
    : undefined
  const parentId = explicitParent ?? independentForkSourceId(session)
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
  return { sessionId, parentId, parentFromHeader: explicitParent !== undefined, cwd }
}

/**
 * 解析分叉子会话应该跟随的项目目录。
 *
 * 按证据强度排序，能证明才动账本：
 *   1. 官方已把子会话安置到某个项目，且没有精确父会话线索：保留官方选择；
 *   2. attach 护栏刚按宿主选中的项目接管（日志里已有本会话记录）；
 *   3. 旧版 `parentSession`，或独立分叉 seed 的已知来源，且该项目内确有
 *      「原始目录等于子会话 cwd」的受管会话；
 *   4. 子会话确实未分组，且「受管会话原始目录」只指向唯一项目。
 *
 * 关键边界：普通分叉（父会话没被移动过）由官方 `attachSession()` 直接挂进
 * header.cwd 对应的项目，此时 `currentPath` 已有值、日志里也没有本会话记录，
 * 返回 null，插件绝不把它改挂到「碰巧从同一原目录移入过会话」的项目。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {{ sessionId: string, parentId: string | undefined, parentFromHeader: boolean, cwd: string | undefined }} facts - 分叉事实。
 * @param {ReturnType<import('./journal.js').createJournalStore> | null | undefined} journal - 移动日志。
 * @param {string | undefined} [currentPath] - 子会话当前归属（省一次账本遍历）。
 * @returns {{ path: string, workspacePath: string, source: 'official' | 'journal' | 'parent' | 'unique-home' } | null} 目标目录、workspace 原值与判定来源。
 */
export function resolveForkTargetPath(registry, facts, journal, currentPath) {
  const ledger = ownershipPaths(registry)
  const workspaces = registry.list()
  /** 把「目录候选」换算成 workspace 的 path 原值：candidateMatches 用严格相等，不能写大小写/斜杠归一后的字符串。 */
  const targetOf = (path, source) => {
    const workspace = workspaces.find((item) => samePath(item?.path, path))
    return workspace === undefined ? null : { path, workspacePath: workspace.path, source }
  }
  const owner = currentPath ?? ledger.get(facts.sessionId)
  const parentId = facts.parentId
  const parentPath = typeof parentId === 'string' ? ledger.get(parentId) : undefined

  // 官方已按 header.cwd 正常安置（普通分叉）：没有可信父会话线索时不覆盖
  // 用户/宿主的选择。旧版分叉的 parentSession 是可信线索，独立分叉 seed 里的
  // 标记可能只是祖先，所以要先验证它与目标项目的同源关系。
  const parentTrustworthy = typeof parentId === 'string' && facts.parentFromHeader === true
  if (typeof owner === 'string' && owner.length > 0 && !parentTrustworthy) {
    const entry = typeof journal?.entry === 'function' ? journal.entry(facts.sessionId) : null
    if (entry !== null && entry !== undefined && samePath(owner, entry.path)) {
      return targetOf(entry.path, 'journal')
    }
    if (typeof parentPath === 'string' && hasManagedHome(registry, journal, parentPath, facts.cwd, { ledger })) {
      return targetOf(parentPath, 'parent')
    }
    return targetOf(owner, 'official')
  }

  if (parentTrustworthy && typeof parentPath === 'string' && parentPath.length > 0) {
    return targetOf(parentPath, 'parent')
  }
  // 独立分叉 seed 里的已知来源必须先在目标项目里得到同源受管会话佐证，
  // 否则它可能只是嵌套链上的祖先，不能据此把普通分叉挂到别的项目。
  if (typeof parentPath === 'string' && hasManagedHome(registry, journal, parentPath, facts.cwd, { ledger })) {
    return targetOf(parentPath, 'parent')
  }
  const entry = typeof journal?.entry === 'function' ? journal.entry(facts.sessionId) : null
  if (entry !== null && entry !== undefined && samePath(ledger.get(facts.sessionId), entry.path)) {
    return targetOf(entry.path, 'journal')
  }
  if (typeof owner === 'string' && owner.length > 0) return null
  const path = resolveIndependentForkPath(registry, journal, facts.cwd, { ledger })
  return typeof path === 'string' && path.length > 0 ? targetOf(path, 'unique-home') : null
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

  const { sessionId, cwd } = facts
  const currentPath = ownershipPaths(registry).get(sessionId)
  const target = resolveForkTargetPath(registry, facts, journal, currentPath)
  if (target === null) return { changed: [], reason: 'parent/ungrouped' }
  const parentPath = target.path
  const workspacePath = target.workspacePath

  const changed = []

  // ① 账本归属：子会话已经被记在目标项目里就只修索引，否则整条 adopt 过来。
  if (samePath(currentPath, parentPath)) {
    const parts = resolveRegistryParts(registry)
    if (parts !== null && parts.paths.get(sessionId) !== workspacePath) {
      parts.paths.set(sessionId, workspacePath)
      changed.push('index')
    }
  } else {
    const workspace = registry.list().find((item) => item?.path === workspacePath)
    if (workspace === undefined) return { changed: [], reason: 'workspace/missing' }
    // 移动期间跳过写前修复（否则目标账本的剪枝会把刚挂进来的会话剔掉）。
    await withMoveInFlight(sessionId, () => moveSessionInRegistry(registry, sessionId, workspace.id))
    changed.push('ledger')
  }

  // ② 工作目录：子会话 header 里的 cwd 是父会话的原始目录，切到项目目录去。
  if (!samePath(cwd, parentPath)) {
    const directory = await syncWorkingDirectory(ctx, sessionId, parentPath)
    if (directory !== 'skipped') changed.push('workdir')
    // 子会话进入「账本在新项目、header 还在旧目录」的分叉状态，必须登记：
    // 后续的写前修复与启动自检都靠这条记录。注意只要 cwd 与项目目录不同就要记，
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
