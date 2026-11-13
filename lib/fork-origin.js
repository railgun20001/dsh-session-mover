/**
 * dsh-session-mover —— 「独立分叉」的来源判定。
 *
 * ## 背景：0.2.1-rc.3 起，普通分叉不再写父会话 id
 *
 * 宿主 `dsh-api-session-controller` 的 `fork()` 给子会话写的 header 只有
 * `{ cwd: source.header.cwd, isSeeded: true, agentPreset? }`：
 *
 *   - `parentSession` 被省略（官方升级指南：`independent-session-forks/guide.zh.md`）；
 *   - 官方明说「不写入替代来源字段」，因此 header 本身无法还原新普通分叉的来源。
 *
 * 对本插件的冲击：父会话被从 A 移到 B 后，header 仍停在 A。分叉出来的子会话
 * 继承 A，于是 `forkWorkspace()` 按账本选中 B，`attachSession()` 却要求
 * `header.cwd === B`，必然校验失败；而插件旧的两处「认亲」逻辑
 * （`lib/guards.js` 的 `forkOfMember` 与 `lib/fork.js` 的 `forkFactsOf`）
 * 都把 `parentSession` 当必需铁证，于是子会话既没进账本也补不了索引，
 * 侧栏把它显示成「未分组」。
 *
 * ## 三束可验证的光
 *
 * 1. **继承投递记录**：复制过来的事件前缀里，`delivery-accepted.data.sessionId`
 *    仍指向产生这段历史的会话。取继承边界之前最后一枚与当前会话 id 不同的
 *    sessionId，即可得到一个已知祖先（新分叉通常就是直接父）。官方已明确
 *    「基于来源的追踪查询无法还原新普通 fork 的来源」，所以嵌套分叉里它可能
 *    是更早的祖先；插件只用它取项目归属，并要求目标项目内同源受管会话印证。
 * 2. **宿主选中的 attach 目标**：`attachSession()` 只会在 `forkWorkspace()`
 *    选中的那一个 workspace 实体上调用；该实体本身就是父会话当前归属的权威
 *    信号。此时只需确认本项目里有「原始目录等于子会话 cwd」的受管会话
 *    （见 {@link hasManagedHome}），不需要跨项目猜。
 * 3. **唯一目录候选**：启动补登记历史会话时，若前两束光都拿不到，就按
 *    「受管会话原始目录 → 当前项目目录」做跨项目推断；**只有候选唯一**才归位，
 *    歧义时如实跳过（见 {@link resolveIndependentForkPath}）。
 *
 * 所有读取都按「读不到就降级」处理：宿主改了字段名、服务缺席或日志损坏时，
 * 宁可让用户手动拖一次，也不把对话挂错项目。
 *
 * @module dsh-session-mover/lib/fork-origin
 */

import { ownershipPaths } from './core.js'
import { samePath } from './managed.js'

/** 继承投递记录的事件类型：它的 data.sessionId 指向产生这条历史的会话。 */
const DELIVERY_EVENT = 'session-log-deepseek/delivery-accepted'

/**
 * 判断一个 header 是否属于「独立分叉」（0.2.1-rc.3+ 的普通 fork）。
 *
 * 三条稳定事实：
 *   - `isSeeded === true`：继承了父会话的事件前缀（普通新会话没有）；
 *   - `origin !== 'subagent'`：子代理会话有自己的生命周期，始终保留创建者；
 *   - 没有 `parentSession`：旧版分叉/子代理派生仍带来源字段，由账本按父 id 判定。
 *
 * @param {unknown} header - 会话 header（可能为 undefined）。
 * @returns {boolean} 是否为不带来源字段的普通分叉。
 */
export function isIndependentFork(header) {
  if (header === null || typeof header !== 'object') return false
  if (header.isSeeded !== true) return false
  if (header.origin === 'subagent') return false
  return typeof header.parentSession !== 'string' || header.parentSession.length === 0
}

/**
 * 从分叉会话的继承事件里读出已知来源会话 id。
 *
 * 普通分叉虽然省略了 `header.parentSession`，但复制过来的事件前缀仍带着
 * 历史投递确认：`delivery-accepted.data.sessionId`。取继承边界之前最后一枚
 * 与当前会话 id 不同的 sessionId，即可得到这条分叉链上最后一个已知祖先。
 * 官方不保证它是直接父（嵌套分叉可能继承更早的标记），所以调用方只用它取
 * 项目归属，不声称还原完整血缘。若边界信息缺失，退化为扫描全部事件。
 *
 * 该字段是宿主持久化日志的稳定事实（V4 格式校验器会拒绝当前代投递标记
 * 指向错误会话），但插件仍按「读不到就跳过」处理，不把它当强依赖。
 *
 * @param {readonly { type?: unknown, data?: unknown }[] | undefined} events - 会话事件（含继承前缀）。
 * @param {unknown} sessionId - 当前子会话 id。
 * @param {unknown} [inheritedEventCount] - 继承前缀长度；缺省时扫描全部事件。
 * @returns {string | undefined} 已知来源会话 id；无法判定时为 undefined。
 */
export function sourceIdFromEvents(events, sessionId, inheritedEventCount) {
  if (!Array.isArray(events) || typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const cut = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0
    ? Math.min(inheritedEventCount, events.length)
    : events.length
  let sourceId
  for (let index = 0; index < cut; index += 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== DELIVERY_EVENT) continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const id = data.sessionId
    if (typeof id === 'string' && id.length > 0 && id !== sessionId) sourceId = id
  }
  return sourceId
}

/**
 * 从 live Session 对象里读出独立分叉的已知来源会话 id。
 *
 * `snapshotEvents()` 是宿主当前版本公开在 Session 上的同步读取口（虽标记
 * deprecated，但仍是该版本唯一能拿到完整继承前缀的同步方法）；拿不到时
 * 退回替身/观察对象常见的 `events` 数组。任何异常都按「读不到」处理。
 *
 * @param {unknown} session - 刚创建的 Session 或冷读观察对象。
 * @returns {string | undefined} 已知来源会话 id；无法判定时为 undefined。
 */
export function independentForkSourceId(session) {
  if (session === null || typeof session !== 'object') return undefined
  const header = session.header
  if (!isIndependentFork(header)) return undefined
  const sessionId = typeof session.id === 'string' ? session.id : header.id
  const cut = Number.isSafeInteger(session.inheritedEventCount) ? session.inheritedEventCount : undefined
  let events
  try {
    if (typeof session.snapshotEvents === 'function') {
      events = cut === undefined ? session.snapshotEvents() : session.snapshotEvents(0, cut)
    }
  } catch {
    events = undefined
  }
  if (!Array.isArray(events) && Array.isArray(session.events)) events = session.events
  return sourceIdFromEvents(events, sessionId, cut)
}

/**
 * 读一条日志条目记录的「原始目录」。
 *
 * `home` 是 header 里的原始 cwd（自检也用它），早期条目只写了 `from`，
 * 两者都取不到时返回 undefined。
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
 * 判断一条日志条目是否仍有效（账本仍把它记在日志所指的目录里）。
 *
 * 会话被拖回原项目、删除或改归属后，日志会变成陈旧条目，不能拿来证明归属。
 *
 * @param {{ sessionId: string, path: string }} entry - 日志条目。
 * @param {Map<string, string>} ledger - `ownershipPaths(registry)` 的结果。
 * @returns {boolean} 条目是否仍与账本一致。
 */
function liveEntry(entry, ledger) {
  return typeof entry.path === 'string' && samePath(ledger.get(entry.sessionId), entry.path)
}

/**
 * 取本次判定要用的日志条目。
 *
 * 启动补登记会先冻结一份条目快照，避免随后的 `pruneJournal()` 与异步冷读
 * 产生竞态；其余调用直接读当前日志。
 *
 * @param {ReturnType<import('./journal.js').createJournalStore> | null | undefined} journal - 移动日志。
 * @param {{ entries?: readonly object[] }} options - 判定选项。
 * @returns {readonly object[]} 日志条目。
 */
function entriesOf(journal, options) {
  if (Array.isArray(options.entries)) return options.entries
  if (journal !== undefined && journal !== null && typeof journal.entries === 'function') return journal.entries()
  return []
}

/**
 * 在**指定项目内**验证：是否存在一个受管会话，它的原始目录等于给定 cwd。
 *
 * 这是 attach 护栏的精确判据。宿主已经把 `attachSession()` 调到这个 workspace
 * 上，所以只需要看「本项目的受管会话里有没有从 cwd 移进来的」；不同项目即使
 * 都从同一个原目录移入过会话，也互不干扰。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {ReturnType<import('./journal.js').createJournalStore> | null | undefined} journal - 移动日志。
 * @param {string} targetPath - 宿主选中的 workspace 目录（权威信号）。
 * @param {unknown} cwd - 子会话 header 里的原始目录。
 * @param {{ ledger?: Map<string, string>, entries?: readonly object[] }} [options] - 可复用的归属投影与日志快照。
 * @returns {boolean} 是否能证明子会话来自本项目的受管会话。
 */
export function hasManagedHome(registry, journal, targetPath, cwd, options = {}) {
  if (journal === undefined || journal === null) return false
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  const ledger = options.ledger ?? ownershipPaths(registry)
  for (const entry of entriesOf(journal, options)) {
    if (!liveEntry(entry, ledger)) continue
    if (!samePath(entry.path, targetPath)) continue
    const home = originPathOf(entry)
    if (typeof home === 'string' && samePath(home, cwd)) return true
  }
  return false
}

/**
 * 跨项目推断一个独立分叉应跟随的项目目录（兜底路径）。
 *
 * 只在「原始目录等于 cwd 的受管会话都指向同一个项目」时返回该目录；
 * 没有候选或多个项目都符合时返回 `undefined`，调用方应如实跳过，绝不猜。
 *
 * 典型歧义：多个项目都从 `C:\work\my` 移入过会话，那么 cwd 为
 * `C:\work\my` 的历史独立分叉无法从持久化数据还原来源（这是宿主的硬限制），
 * 保持「未分组」由用户手动拖一次即可。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {ReturnType<import('./journal.js').createJournalStore> | null | undefined} journal - 移动日志。
 * @param {unknown} cwd - 子会话 header 里的原始目录。
 * @param {{ ledger?: Map<string, string>, entries?: readonly object[] }} [options] - 可复用的归属投影与日志快照。
 * @returns {string | undefined} 唯一候选项目目录；无法判定时为 undefined。
 */
export function resolveIndependentForkPath(registry, journal, cwd, options = {}) {
  if (journal === undefined || journal === null) return undefined
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const ledger = options.ledger ?? ownershipPaths(registry)
  /** @type {string[]} 按 samePath 去重后的候选目录 */
  const targets = []
  for (const entry of entriesOf(journal, options)) {
    if (!liveEntry(entry, ledger)) continue
    const home = originPathOf(entry)
    if (typeof home !== 'string' || !samePath(home, cwd)) continue
    if (!targets.some((path) => samePath(path, entry.path))) targets.push(entry.path)
    if (targets.length > 1) return undefined
  }
  return targets.length === 1 ? targets[0] : undefined
}
