/**
 * dsh-session-mover —— 受管会话的自检与清单。
 *
 * 「受管会话」= 移动日志里记着的、且账本仍把它算在某个项目里的会话。
 * 它和普通会话的区别只有一条：**header 里的 cwd 仍停在原项目目录**，
 * 所以文件树、「打开文件夹」、工作目录这些读 header 的地方需要插件投影。
 *
 * 这里提供三件事（全部只读）：
 *
 *   1. **启动自检**：数一数有多少受管会话，目标目录还在不在，原目录是不是
 *      已经没了（原目录没了就意味着会话文件已经跟着旧文件夹走了）。
 *   2. **清单**：给客户端/用户看的明细（含时间与来源）。
 *   3. **日志清理**：把已经不再受管的陈旧条目从移动日志里删掉。
 *
 * 插件不提供「还原」：要回到原项目，直接把会话拖回去即可；这也让插件保持
 * 单一职责——只改归属与读取投影，不对账本做额外的补偿操作。
 *
 * @module dsh-session-mover/lib/managed
 */

import { statSync } from 'node:fs'
import { ownershipPaths, readRawSessionIds } from './core.js'

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
