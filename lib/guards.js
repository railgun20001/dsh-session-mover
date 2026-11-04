/**
 * dsh-session-mover —— 官方写路径的两个护栏（写前修复 + attach 接管）。
 *
 * ## 为什么要在别人的方法上打补丁
 *
 * 本插件把归属账本当权威，但官方仍按 `header.cwd` + 内存索引
 * `sessionPaths` 判断成员资格。两处会踩到移动过的会话：
 *
 *   - `WorkspaceEntity.mutate()`：每次写都会 `sessionIds.filter(candidateMatches)`
 *     再把结果落盘（`dsh-workspace/lib/index.js` 的 mutate）。索引一旦被
 *     官方从 header 重建，下一次任何写（改名、排序、删除、新建会话）都会把
 *     移动过的会话**永久**从账本里剔除。所以写之前必须先把账本重新灌回索引。
 *   - `WorkspaceEntity.attachSession(sessionId)`：要求 `header.cwd` 等于
 *     `record.path`，否则抛错。分叉出来的子会话 header 写的是父会话**原始**
 *     cwd（旧项目），而 `forkWorkspace()` 按账本把子会话挂到父会话所在项目，
 *     于是校验必然失败，分叉直接报 `session/workspace-attach-failed`。
 *     这里在失败后按账本接管：只有能证明「这个会话确实属于本项目」时才绕过
 *     校验，其它情况原样抛出。
 *
 * ## 接线方式
 *
 * 两个方法都在 `WorkspaceEntity` 的原型上（类不导出，但能从任意实例拿到原型）。
 * 补丁装在原型上，对已经存在和以后新建的实体都生效；插件卸载时还原。
 * 用 `Symbol.for()` 做安装标记，插件重载（旧实例还没卸载）时复用同一份补丁，
 * 引用计数归零才真正还原。
 *
 * ## 边界
 *
 *   - 写前修复只处理**日志里记着的**会话（外加本次正在移动的那一个），
 *     不碰普通会话，官方原有的剪枝语义继续生效（死会话仍会被清掉）。
 *   - attach 接管只在「账本说它属于这里」或「它是本项目某个会话的分叉」时
 *     生效；且必须先读到 header。读不到 header 就放弃接管，让原来的错误冒泡。
 *   - 任何一步失败都只记日志，绝不影响官方流程本身。
 *
 * @module dsh-session-mover/lib/guards
 */

import { ownershipPaths, resolveRegistryParts } from './core.js'

/** 原型上的安装标记：同一个进程里只装一份。 */
const INSTALL_MARK = Symbol.for('dsh-session-mover/entity-guards')

/**
 * 正在移动的会话 id。
 *
 * `moveSessionInRegistry()` 会先改索引再写两个账本；写前修复如果在这一刻
 * 把索引改回旧目录，目标账本那边就会把刚移进来的会话剪掉。所以移动期间
 * 对这一个 id 跳过修复。
 *
 * @type {Set<string>}
 */
const inFlight = new Set()

/**
 * 在「移动进行中」的作用域里跑一段逻辑。
 *
 * @param {string} sessionId - 正在移动的会话。
 * @param {() => Promise<unknown>} run - 移动逻辑。
 * @returns {Promise<unknown>} `run` 的结果。
 */
export async function withMoveInFlight(sessionId, run) {
  inFlight.add(sessionId)
  try {
    return await run()
  } finally {
    inFlight.delete(sessionId)
  }
}

/**
 * 取 `WorkspaceEntity` 的原型。
 *
 * 优先走注册表的 `entities`（不触发任何 getter），拿不到再退回 `list()`。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @returns {object | null} 原型；没有任何实体时返回 null。
 */
export function entityPrototype(registry) {
  if (registry === null || typeof registry !== 'object') return null
  const entities = registry.entities
  if (entities !== null && typeof entities === 'object' && typeof entities.values === 'function') {
    const first = entities.values().next()
    if (first !== undefined && first.done === false && first.value !== null && typeof first.value === 'object') {
      return Object.getPrototypeOf(first.value)
    }
  }
  // 兜底：注册表内部字段改名时仍能拿到实例（`list()` 只读，不会触发写入）。
  if (typeof registry.list === 'function') {
    const list = registry.list()
    if (Array.isArray(list) && list.length > 0 && list[0] !== null && typeof list[0] === 'object') {
      return Object.getPrototypeOf(list[0])
    }
  }
  return null
}

/**
 * 写前修复：把日志里记着的归属重新灌回内存索引。
 *
 * 只修「账本仍指向日志里那个目录」的会话：会话被还原、被拖回、或账本记录
 * 已消失时都跳过（陈旧日志条目留给自检清理）。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {ReturnType<import('./journal.js').createJournalStore>} journal - 移动日志。
 * @returns {number} 修了几条。
 */
export function repairManagedPaths(registry, journal) {
  const parts = resolveRegistryParts(registry)
  if (parts === null || journal === undefined || journal === null) return 0
  const ledger = ownershipPaths(registry)
  let fixed = 0
  for (const [sessionId, entry] of journal.managedPaths()) {
    if (inFlight.has(sessionId)) continue
    if (ledger.get(sessionId) !== entry.path) continue
    if (parts.paths.get(sessionId) === entry.path) continue
    parts.paths.set(sessionId, entry.path)
    fixed += 1
  }
  return fixed
}

/**
 * 读一个会话的持久化 header（读不到就当没有）。
 *
 * @param {unknown} entity - workspace 实体。
 * @param {string} sessionId - 会话标识。
 * @returns {Promise<object | undefined>} header。
 */
async function readHeader(entity, sessionId) {
  const host = entity?.host
  if (host === null || typeof host !== 'object' || typeof host.readSessionHeader !== 'function') return undefined
  try {
    const header = await host.readSessionHeader(sessionId)
    return header !== null && typeof header === 'object' ? header : undefined
  } catch {
    return undefined
  }
}

/**
 * attach 失败后的账本接管。
 *
 * 触发条件（必须能证明归属）：
 *   1. 账本说这个会话就属于当前 workspace；或
 *   2. 它是当前 workspace 里某个会话的分叉（`isSeeded` + `parentSession`）。
 *
 * 满足时：把内存索引指到本项目，走同一条 `mutate` 把会话挂进来，
 * 并记进移动日志（后续写前修复与还原都依赖它）。
 *
 * @param {{
 *   entity: object,
 *   sessionId: string,
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 *   logger?: { info?: (message: string) => void, warn?: (message: string, error?: unknown) => void },
 * }} input - 参数。
 * @returns {Promise<boolean>} 是否接管成功。
 */
export async function adoptManagedAttach({ entity, sessionId, registry, journal, logger }) {
  if (entity === null || typeof entity !== 'object') return false
  const record = entity.record
  if (record === null || typeof record !== 'object') return false
  const targetPath = typeof record.path === 'string' ? record.path : ''
  if (targetPath.length === 0) return false
  // 已经在账本里的 id 不该走到这里；即便走到，也不能吞掉真正的存储错误。
  if (Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)) return false

  const ledger = ownershipPaths(registry)
  const owner = ledger.get(sessionId)
  const header = await readHeader(entity, sessionId)
  const parentId = typeof header?.parentSession === 'string' ? header.parentSession : ''
  const forkOfMember = header?.isSeeded === true && parentId.length > 0 && ledger.get(parentId) === targetPath
  if (owner !== targetPath && !forkOfMember) return false

  const host = entity.host
  if (host !== null && typeof host === 'object' && typeof host.rememberSessionPath === 'function') {
    host.rememberSessionPath(sessionId, targetPath)
  }
  await entity.mutate((current) => (
    Array.isArray(current.sessionIds) && current.sessionIds.includes(sessionId)
      ? current
      : { ...current, sessionIds: [sessionId, ...current.sessionIds] }
  ))
  journal?.record(sessionId, {
    path: targetPath,
    ...(typeof header?.cwd === 'string' && header.cwd.length > 0 ? { home: header.cwd, from: header.cwd } : {}),
    kind: forkOfMember ? 'fork' : 'attach',
  })
  journal?.save()
  logger?.info?.(`[dsh-session-mover] 会话 ${sessionId} 已挂到 ${JSON.stringify(targetPath)}（header cwd 不匹配，按归属账本接管）`)
  return true
}

/**
 * 安装两个护栏。
 *
 * @param {{
 *   registry: unknown,
 *   journal: ReturnType<import('./journal.js').createJournalStore>,
 *   logger?: { info?: (message: string) => void, warn?: (message: string, error?: unknown) => void },
 * }} input - 参数。
 * @returns {{ installed: boolean, reason: string, dispose: () => void }} 安装结果与卸载函数。
 */
export function installEntityGuards({ registry, journal, logger }) {
  const noop = () => {}
  const parts = resolveRegistryParts(registry)
  if (parts === null) return { installed: false, reason: 'registry/unsupported', dispose: noop }
  const proto = entityPrototype(registry)
  if (proto === null) return { installed: false, reason: 'registry/no-entity', dispose: noop }

  const installed = proto[INSTALL_MARK]
  if (installed !== undefined && installed !== null && typeof installed === 'object') {
    installed.refs += 1
    return { installed: true, reason: 'already', dispose: installed.dispose }
  }

  const originalMutate = typeof proto.mutate === 'function' ? proto.mutate : null
  const originalAttach = typeof proto.attachSession === 'function' ? proto.attachSession : null
  if (originalMutate === null && originalAttach === null) {
    return { installed: false, reason: 'entity/unsupported', dispose: noop }
  }

  /** 共享的安装状态：补丁函数只读它，插件重载时复用同一份。 */
  const state = { refs: 1, dispose: noop }

  /**
   * 写前修复包装：先按日志把索引修好，再交给官方 `mutate`。
   *
   * 修复失败只记日志——宁可少修一次，也不能让官方写操作失败。
   *
   * @param {(record: object) => object} change - 官方 mutate 的变更函数。
   * @returns {Promise<void>} 官方 mutate 的结果。
   */
  const guardedMutate = originalMutate === null ? null : function guardedMutate(change) {
    try {
      repairManagedPaths(registry, journal)
    } catch (error) {
      logger?.warn?.('[dsh-session-mover] 写前修复归属索引失败（本次写入按原索引执行）', error)
    }
    return originalMutate.call(this, change)
  }

  /**
   * attach 包装：官方校验失败后，只有账本能证明归属时才按账本接管。
   *
   * @param {string} sessionId - 要挂到本 workspace 的会话。
   * @returns {Promise<void>} 官方 attach 的结果。
   */
  const guardedAttachSession = originalAttach === null ? null : async function guardedAttachSession(sessionId) {
    try {
      return await originalAttach.call(this, sessionId)
    } catch (error) {
      // 接管本身失败时（例如 header 读不到、存储写失败）保留官方错误：
      // 用户看到的必须是真实原因，而不是我们这层的二次错误。
      let adopted = false
      try {
        adopted = await adoptManagedAttach({ entity: this, sessionId, registry, journal, logger })
      } catch (adoptError) {
        logger?.warn?.('[dsh-session-mover] 按账本接管 attach 失败（保留官方错误）', adoptError)
      }
      if (!adopted) throw error
      return undefined
    }
  }

  if (guardedMutate !== null) proto.mutate = guardedMutate
  if (guardedAttachSession !== null) proto.attachSession = guardedAttachSession

  state.dispose = () => {
    state.refs -= 1
    if (state.refs > 0) return
    if (guardedMutate !== null && proto.mutate === guardedMutate) proto.mutate = originalMutate
    if (guardedAttachSession !== null && proto.attachSession === guardedAttachSession) proto.attachSession = originalAttach
    delete proto[INSTALL_MARK]
  }
  proto[INSTALL_MARK] = state

  return { installed: true, reason: 'patched', dispose: state.dispose }
}
