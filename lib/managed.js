/**
 * dsh-session-mover —— 受管会话的自检与还原。
 *
 * 「受管会话」= 移动日志里记着的、且账本仍把它算在某个项目里的会话。
 * 它和普通会话的区别只有一条：**header 里的 cwd 仍停在原项目目录**，
 * 所以文件树、「打开文件夹」、工作目录这些读 header 的地方需要插件投影。
 *
 * 这里提供三件事：
 *
 *   1. **启动自检**：数一数有多少受管会话，目标目录还在不在，原目录是不是
 *      已经没了（原目录没了就意味着会话文件已经跟着旧文件夹走了）。
 *   2. **清单**：给客户端/用户看的明细（含时间与来源），也是「一键还原」的输入。
 *   3. **还原**：把会话搬回 header 里的原目录——原项目还在时重新记账；原项目
 *      已被删掉时从账本里摘下，回到「未分组」。无论哪条路，都会清掉日志条目，
 *      让这个会话重新变成「普通会话」。
 *
 * 还原是最重要的一条逃生通道：本插件不搬文件，所以只要把账本改回原项目，
 * 会话就回到插件的「无感」状态，卸载插件也不再有副作用。
 *
 * @module dsh-session-mover/lib/managed
 */

import { statSync } from 'node:fs'
import { moveSessionInRegistry, ownershipPaths, readRawSessionIds, resolveRegistryParts } from './core.js'
import { withMoveInFlight } from './guards.js'
import { syncWorkingDirectory } from './workdir.js'

/**
 * 判断目录是否存在（同步、不抛错）。
 *
 * @param {string} path - 绝对路径。
 * @returns {boolean} 是否为目录。
 */
export function isDirectory(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 比较两个路径是否指向同一位置。
 *
 * 只做「去掉尾部分隔符 + Windows 下忽略大小写」的规范化：故意不做 realpath，
 * 因为自检和还原都不该对磁盘做额外 I/O，也不该因为盘符映射差异误判。
 *
 * @param {unknown} left - 路径 A。
 * @param {unknown} right - 路径 B。
 * @returns {boolean} 是否视为同一目录。
 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = left.replace(/[\\/]+$/, '')
  const b = right.replace(/[\\/]+$/, '')
  if (a.length === 0 || b.length === 0) return false
  if (a === b) return true
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()
}

/**
 * 启动时把「历史遗留的移动」登记进日志。
 *
 * 判断依据：注册表启动索引出来的 cwd（`before`，来自 header 的规范化路径）
 * 与账本里记录的 workspace 目录不一致 → 这个会话是被本插件移过的。
 * 只在没有日志的首次升级时起作用；之后每条移动都会自己写日志。
 *
 * @param {{
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 *   before: Map<string, string>,
 * }} input - 参数。
 * @returns {number} 本次登记了几条。
 */
export function adoptExistingMoves({ registry, journal, before }) {
  if (journal === undefined || journal === null || !(before instanceof Map)) return 0
  let adopted = 0
  for (const workspace of registry.list()) {
    if (workspace === null || typeof workspace !== 'object') continue
    const path = typeof workspace.path === 'string' ? workspace.path : ''
    if (path.length === 0) continue
    for (const sessionId of readRawSessionIds(registry, workspace.id)) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue
      const previous = before.get(sessionId)
      if (typeof previous !== 'string' || previous.length === 0) continue
      if (samePath(previous, path)) continue
      const existing = journal.entry(sessionId)
      // 已经有日志条目（正常移动）时保留原记录，只补缺失的原目录。
      journal.record(sessionId, {
        path,
        home: existing?.home ?? previous,
        from: existing?.from ?? previous,
        kind: existing?.kind ?? 'adopt',
      })
      adopted += 1
    }
  }
  if (adopted > 0) journal.save()
  return adopted
}

/**
 * 清理陈旧日志条目：账本里已经没有归属、或归属已换到别的目录的，直接忘掉。
 *
 * 不清理也能工作（读取时会跳过），但日志会随「移动→还原→再移动」无限增长，
 * 所以每次启动顺手收一次。
 *
 * @param {{
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 * }} input - 参数。
 * @returns {number} 清掉了几条。
 */
export function pruneJournal({ registry, journal }) {
  if (journal === undefined || journal === null) return 0
  const ledger = ownershipPaths(registry)
  let removed = 0
  for (const entry of journal.entries()) {
    const path = ledger.get(entry.sessionId)
    if (typeof path === 'string' && path.length > 0 && samePath(entry.path, path)) continue
    if (journal.forget(entry.sessionId)) removed += 1
  }
  if (removed > 0) journal.save()
  return removed
}

/**
 * 列出自检明细。
 *
 * @param {{
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 * }} input - 参数。
 * @returns {Array<{
 *   sessionId: string,
 *   path: string,
 *   headerCwd: string | null,
 *   kind: string,
 *   movedAt: string | null,
 *   targetExists: boolean,
 *   sourceExists: boolean | null,
 * }>} 明细（仅包含账本里仍有归属的会话）。
 */
export function inspectManagedSessions({ registry, journal }) {
  const ledger = ownershipPaths(registry)
  const rows = []
  for (const entry of journal.entries()) {
    const path = ledger.get(entry.sessionId)
    if (typeof path !== 'string' || path.length === 0) continue
    // 日志里的目标目录必须仍是账本当前指向的目录，否则说明会话已经被还原/拖走，
    // 这条日志已经陈旧——不再算受管会话（留着也不该被修复或还原）。
    if (!samePath(entry.path, path)) continue
    rows.push({
      sessionId: entry.sessionId,
      path,
      headerCwd: entry.home ?? entry.from ?? null,
      kind: typeof entry.kind === 'string' ? entry.kind : 'move',
      movedAt: typeof entry.at === 'string' ? entry.at : null,
      targetExists: isDirectory(path),
      sourceExists: typeof entry.home === 'string' && entry.home.length > 0
        ? isDirectory(entry.home)
        : (typeof entry.from === 'string' && entry.from.length > 0 ? isDirectory(entry.from) : null),
    })
  }
  return rows
}

/**
 * 汇总自检明细。
 *
 * @param {ReturnType<typeof inspectManagedSessions>} rows - 明细。
 * @returns {{ total: number, targetMissing: number, sourceMissing: number }} 汇总。
 */
export function summarizeManaged(rows) {
  return {
    total: rows.length,
    targetMissing: rows.filter((row) => row.targetExists === false).length,
    sourceMissing: rows.filter((row) => row.sourceExists === false).length,
  }
}

/**
 * 把一条账本记录删掉（会话回到「未分组」）。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {string} sessionId - 会话标识。
 * @returns {Promise<boolean>} 是否真的删掉了某条记录。
 */
export async function detachFromLedgers(registry, sessionId) {
  let removed = false
  for (const workspace of registry.list()) {
    if (workspace === null || typeof workspace !== 'object') continue
    const ids = readRawSessionIds(registry, workspace.id)
    if (!ids.includes(sessionId)) continue
    await withMoveInFlight(sessionId, () => workspace.mutate((record) => ({
      ...record,
      sessionIds: record.sessionIds.filter((id) => id !== sessionId),
    })))
    removed = true
  }
  return removed
}

/**
 * 还原一个受管会话。
 *
 * 顺序：
 *   1. 从日志/header 取原目录；
 *   2. 原项目还在 → 重新记到原项目账本，并把工作目录切回去；
 *   3. 原项目已消失 → 从当前账本摘下，回到「未分组」；
 *   4. 无论哪条路，都清掉日志条目（它不再是受管会话）。
 *
 * @param {{
 *   ctx?: unknown,
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 *   sessionId: string,
 *   logger?: { info?: (message: string) => void, warn?: (message: string, error?: unknown) => void },
 * }} input - 参数。
 * @returns {Promise<{ restored: boolean, to: { id: string, title: string, path: string } | null, reason?: string }>} 结果。
 */
export async function restoreManagedSession({ ctx, registry, journal, sessionId, logger }) {
  const parts = resolveRegistryParts(registry)
  if (parts === null) return { restored: false, to: null, reason: 'registry/unsupported' }
  const entry = journal.entry(sessionId)
  const ledger = ownershipPaths(registry)
  const currentPath = ledger.get(sessionId)
  if (typeof currentPath !== 'string' || currentPath.length === 0) {
    journal.forget(sessionId)
    journal.save()
    return { restored: false, to: null, reason: 'ledger/missing' }
  }
  // 日志指向的已经不是当前归属（会话被还原过、或被别的路径接管）：按陈旧条目处理。
  if (entry !== null && !samePath(entry.path, currentPath)) {
    journal.forget(sessionId)
    journal.save()
    return { restored: false, to: null, reason: 'journal/stale' }
  }
  const header = parts.headers?.get(sessionId)
  const headerCwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const home = entry?.home ?? entry?.from ?? (headerCwd.length > 0 ? headerCwd : undefined)
  if (typeof home !== 'string' || home.length === 0) {
    journal.forget(sessionId)
    journal.save()
    return { restored: false, to: null, reason: 'home/unknown' }
  }

  const target = registry.list().find((workspace) => workspace !== null
    && typeof workspace === 'object'
    && samePath(workspace.path, home))

  if (target !== undefined) {
    await withMoveInFlight(sessionId, () => moveSessionInRegistry(registry, sessionId, target.id))
    journal.forget(sessionId)
    journal.save()
    if (ctx !== undefined && ctx !== null) {
      try {
        await syncWorkingDirectory(ctx, sessionId, target.path)
      } catch (error) {
        logger?.warn?.('[dsh-session-mover] 还原后切换工作目录失败（归属已还原）', error)
      }
    }
    return { restored: true, to: { id: target.id, title: target.title, path: target.path } }
  }

  // 原项目不在了：把会话从账本里摘掉，避免继续挂在「目标项目」下却没有原目录可回。
  const removed = await detachFromLedgers(registry, sessionId)
  parts.paths.delete(sessionId)
  journal.forget(sessionId)
  journal.save()
  if (removed) logger?.info?.(`[dsh-session-mover] 会话 ${sessionId} 的原项目已不存在，已回到未分组`)
  return { restored: removed, to: null, reason: removed ? 'detached' : 'ledger/missing' }
}

/**
 * 还原全部受管会话（「一键还原」）。
 *
 * @param {{
 *   ctx?: unknown,
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 *   logger?: { info?: (message: string) => void, warn?: (message: string, error?: unknown) => void },
 * }} input - 参数。
 * @returns {Promise<Array<{ sessionId: string, restored: boolean, to: object | null, reason?: string }>>} 每条的结果。
 */
export async function restoreAllManaged({ ctx, registry, journal, logger }) {
  const ids = inspectManagedSessions({ registry, journal }).map((row) => row.sessionId)
  const results = []
  for (const sessionId of ids) {
    try {
      const result = await restoreManagedSession({ ctx, registry, journal, sessionId, logger })
      results.push({ sessionId, ...result })
    } catch (error) {
      results.push({ sessionId, restored: false, to: null, reason: String(error?.message ?? error) })
    }
  }
  return results
}
