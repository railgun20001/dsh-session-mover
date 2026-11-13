/**
 * dsh-session-mover —— 启动补登记：把历史「独立分叉」从「未分组」接回项目。
 *
 * ## 为什么需要这一层
 *
 * 0.2.1-rc.3 起普通分叉不再写 `header.parentSession`。旧版插件的 attach 护栏
 * 与 `session/created` 对齐都把该字段当必需条件，所以在修复前分叉出来的子会话
 * 可能已经存在，却没进任何 workspace 账本——侧栏显示为「未分组」。仅修新分叉
 * 不够，这些历史对话也需要在下次启动时归位。
 *
 * ## 判定顺序（能证明才动账本）
 *
 * 1. 用 `sessionQuery.listSessions()` 读轻量 header，筛出「独立分叉 + 未分组
 *    + cwd 等于某个受管会话的原始目录」的候选；绝大多数会话在这一步就被排除，
 *    不会读完整日志。
 * 2. 对候选调 `sessionQuery.readSession()`，从继承前缀的
 *    `delivery-accepted.data.sessionId` 追已知来源；来源链最多 8 跳，
 *    遇到账本里已分组的会话就把它的项目目录作为目标。嵌套分叉也能沿
 *    祖先归位；官方不保证该 id 是直接父，但分叉链未跨项目搬动时归属相同。
 * 3. 读不到来源链时，才按「受管会话原始目录 → 项目目录」做唯一候选推断；
 *    多个项目符合同一原始目录时保持未分组，由用户手动拖一次，绝不猜。
 *
 * 归位复用 `moveSessionInRegistry()`（只改账本与内存索引，不搬会话文件），
 * 并写一条 `kind: 'fork'` 的移动日志，后续写前修复与启动自检都会覆盖它。
 * 工作目录不在这里切换：冷会话还没 Agent，下次打开时 `agent/created` 会按
 * 账本对齐（见 `lib/fork.js`）。
 *
 * 所有外部读取都按「失败就跳过」处理；`sessionQuery` 缺席、日志损坏、宿主版本
 * 改了字段名，最多是少补登记几条，绝不影响插件加载或已有分组。
 *
 * @module dsh-session-mover/lib/backfill
 */

import { moveSessionInRegistry, ownershipPaths, resolveRegistryParts } from './core.js'
import { hasManagedHome, isIndependentFork, resolveIndependentForkPath, sourceIdFromEvents } from './fork-origin.js'
import { withMoveInFlight } from './guards.js'
import { samePath } from './managed.js'

/** 来源链最多追多少跳：防循环，也避免异常日志把启动拖成长时间冷读。 */
const MAX_SOURCE_HOPS = 8

/**
 * 从 `listSessions()` / `readSession()` 的返回对象里取 header。
 *
 * 当前宿主用 `header`；冷读快照用 `session`；测试替身也可能直接传裸 header。
 * 三种都接受，结构不符返回 undefined。
 *
 * @param {unknown} record - 会话记录、冷读快照或裸 header。
 * @returns {Record<string, unknown> | undefined} header。
 */
function headerOf(record) {
  if (record === null || typeof record !== 'object') return undefined
  const nested = record.header ?? record.session
  if (nested !== null && typeof nested === 'object') return nested
  return typeof record.id === 'string' ? record : undefined
}

/**
 * 取日志条目记录的原始目录（header cwd 所在的目录）。
 *
 * @param {{ home?: string, from?: string }} entry - 日志条目。
 * @returns {string | undefined} 原始目录。
 */
function originPathOf(entry) {
  if (typeof entry.home === 'string' && entry.home.length > 0) return entry.home
  if (typeof entry.from === 'string' && entry.from.length > 0) return entry.from
  return undefined
}

/**
 * 读取仍有效的移动日志条目（账本仍记在日志所指目录里）。
 *
 * @param {ReturnType<import('./journal.js').createJournalStore>} journal - 移动日志。
 * @param {Map<string, string>} ledger - 归属投影。
 * @returns {Array<{ sessionId: string, path: string, home?: string, from?: string }>} 有效条目。
 */
function liveEntries(journal, ledger) {
  return journal.entries().filter((entry) => samePath(ledger.get(entry.sessionId), entry.path))
}

/**
 * 沿独立分叉的继承投递标记追到第一个「已分组」来源。
 *
 * 返回的是项目目录而不是会话 id：调用方只关心子会话应挂到哪个项目。
 * 任一次冷读失败、来源链成环或超过上限都返回 undefined，交给唯一目录候选兜底。
 *
 * @param {{ readSession?: (id: string) => Promise<unknown> }} query - 会话查询服务。
 * @param {string} sessionId - 当前追到的会话 id。
 * @param {Map<string, string>} ledger - 归属投影（启动期间会随补登记更新）。
 * @param {Set<string>} [seen] - 已访问会话，防环。
 * @param {number} [depth] - 当前跳数。
 * @returns {Promise<string | undefined>} 来源会话所属项目目录。
 */
async function readSourcePath(query, sessionId, ledger, seen = new Set(), depth = 0) {
  if (depth > MAX_SOURCE_HOPS || typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const grouped = ledger.get(sessionId)
  if (typeof grouped === 'string' && grouped.length > 0) return grouped
  if (seen.has(sessionId)) return undefined
  seen.add(sessionId)
  if (typeof query?.readSession !== 'function') return undefined
  let snapshot
  try {
    snapshot = await query.readSession(sessionId)
  } catch {
    return undefined
  }
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const sourceId = sourceIdFromEvents(snapshot.events, sessionId, snapshot.inheritedEventCount)
  if (typeof sourceId !== 'string') return undefined
  return readSourcePath(query, sourceId, ledger, seen, depth + 1)
}

/**
 * 启动补登记独立分叉。
 *
 * @param {{
 *   query?: { listSessions?: () => Promise<unknown>, readSession?: (id: string) => Promise<unknown> },
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 *   logger?: { info?: (message: string) => void, warn?: (message: string, error?: unknown) => void },
 *   isActive?: () => boolean,
 * }} input - 参数。
 * @returns {Promise<{
 *   scanned: number,
 *   candidates: number,
 *   adopted: number,
 *   skipped: number,
 *   reason?: string,
 * }>} 补登记汇总。
 */
export async function backfillIndependentForks({ query, registry, journal, logger, isActive }) {
  const inactive = () => typeof isActive === 'function' && isActive() === false
  if (inactive()) return { scanned: 0, candidates: 0, adopted: 0, skipped: 0, reason: 'disposed' }
  const ledger = ownershipPaths(registry)
  const entries = liveEntries(journal, ledger)
  if (entries.length === 0) return { scanned: 0, candidates: 0, adopted: 0, skipped: 0, reason: 'journal/empty' }
  if (typeof query?.listSessions !== 'function') {
    return { scanned: 0, candidates: 0, adopted: 0, skipped: 0, reason: 'sessionQuery/unavailable' }
  }

  let records
  try {
    records = await query.listSessions()
  } catch (error) {
    logger?.warn?.('[dsh-session-mover] 启动补登记：读取会话清单失败（历史分叉可能仍未分组）', error)
    return { scanned: 0, candidates: 0, adopted: 0, skipped: 0, reason: 'sessionQuery/list-failed' }
  }
  if (!Array.isArray(records)) {
    return { scanned: 0, candidates: 0, adopted: 0, skipped: 0, reason: 'sessionQuery/invalid-list' }
  }
  if (inactive()) return { scanned: records.length, candidates: 0, adopted: 0, skipped: 0, reason: 'disposed' }

  // 先按「原始目录」缩小候选：只有从受管会话原目录分叉出来的对话才可能掉组。
  const origins = entries.map(originPathOf).filter((path) => typeof path === 'string' && path.length > 0)
  const candidates = []
  const seenCandidates = new Set()
  for (const record of records) {
    const header = headerOf(record)
    const id = header?.id
    if (typeof id !== 'string' || id.length === 0 || seenCandidates.has(id)) continue
    if (!isIndependentFork(header)) continue
    if (ledger.has(id)) continue
    const cwd = header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) continue
    if (!origins.some((home) => samePath(home, cwd))) continue
    seenCandidates.add(id)
    candidates.push({ id, cwd })
  }

  let adopted = 0
  let skipped = 0
  for (const candidate of candidates) {
    if (inactive()) {
      skipped += candidates.length - adopted - skipped
      return { scanned: records.length, candidates: candidates.length, adopted, skipped, reason: 'disposed' }
    }
    // 来源链优先；它只给出分叉链上的已知祖先，所以目标项目还要有同源受管
    // 会话印证。读不到来源链时，才退回唯一目录候选。
    let targetPath = await readSourcePath(query, candidate.id, ledger)
    if (typeof targetPath === 'string' && !hasManagedHome(
      registry, journal, targetPath, candidate.cwd, { ledger, entries },
    )) {
      targetPath = undefined
    }
    if (targetPath === undefined) {
      targetPath = resolveIndependentForkPath(registry, journal, candidate.cwd, { ledger, entries })
    }
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      skipped += 1
      continue
    }
    // 账本里的路径是官方 entity.path 原值；内存索引 candidateMatches 用严格相等。
    // 按 samePath 找到 entity 后，后续的移动、索引与日志都统一用它的 path 原值，
    // 避免大小写/斜杠写法差异让会话刚挂进去就被剪掉。
    const workspace = registry.list().find((item) => samePath(item?.path, targetPath))
    if (workspace === undefined || ownershipPaths(registry).has(candidate.id)) {
      skipped += 1
      continue
    }
    const workspacePath = workspace.path
    try {
      await withMoveInFlight(candidate.id, () => moveSessionInRegistry(registry, candidate.id, workspace.id))
      // moveSessionInRegistry 已把索引设成 workspace.path；这里再兜一次严格相等，
      // 防止并发写入在 mutation 期间把它改回别的字符串。
      const parts = resolveRegistryParts(registry)
      if (parts !== null && parts.paths.get(candidate.id) !== workspacePath) parts.paths.set(candidate.id, workspacePath)
      journal.record(candidate.id, {
        path: workspacePath,
        home: candidate.cwd,
        from: candidate.cwd,
        kind: 'fork',
      })
      journal.save()
      // 后续嵌套分叉的来源链可以直接命中刚归位的父会话，不必再冷读一次。
      ledger.set(candidate.id, workspacePath)
      entries.push({
        sessionId: candidate.id,
        path: workspacePath,
        home: candidate.cwd,
        from: candidate.cwd,
        kind: 'fork',
      })
      adopted += 1
    } catch (error) {
      skipped += 1
      logger?.warn?.(`[dsh-session-mover] 启动补登记：无法把分叉会话 ${candidate.id} 接回项目`, error)
    }
  }

  const summary = {
    scanned: records.length,
    candidates: candidates.length,
    adopted,
    skipped,
  }
  logger?.info?.(`[dsh-session-mover] 启动补登记独立分叉：扫描 ${summary.scanned} 个会话，候选 ${summary.candidates} 个，归位 ${summary.adopted} 个，跳过 ${summary.skipped} 个`)
  return summary
}
