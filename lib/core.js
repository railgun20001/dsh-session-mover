/**
 * dsh-session-mover —— 归属账本的核心操作（宿主半与测试共用）。
 *
 * ## 背景：会话的「所属项目」记在两处
 *
 * 1. 每个 workspace 记录里的 `sessionIds`：有序归属账本，落在
 *    `storageDomain` 的 `workspace` 域里，是持久化的事实。
 * 2. 注册表内存索引 `sessionPaths`（sessionId → 规范化 cwd）：读取账本时
 *    用它过滤掉「已经不在该目录」的成员（`candidateMatches`）。
 *
 * 官方 API 只提供同一 workspace 内的顺序调整（`insertSessionBefore` 明确要求
 * 会话已记在该账本里），跨 workspace 没有入口；会话的持久化 header 也是只读的
 * （JSONL 日志按 cwd 分目录、已提交的 header 永不重写）。所以本插件把
 * **归属账本当权威**：
 *
 *   - 移动时先把内存索引指向目标目录，再改写两边 workspace 的记录；
 *   - 启动时把账本里记着的归属重新灌回内存索引（`replayOwnership`），
 *     使移动结果跨重启保持。
 *
 * 这是一条**只改账本、不动会话文件**的路径：对话自身的日志、事件与
 * header 都原样保留，因此不会破坏历史、附件或崩溃恢复语义。
 *
 * ## 兼容性
 *
 * `table` 与 `sessionPaths` 是 `WorkspaceRegistry` 的运行时字段。插件在动手前
 * 用 {@link resolveRegistryParts} 做结构探测；形态不符时宁可整条能力不可用，
 * 也不猜测。这样 DSH 升级改了内部结构只会让「移动」失败并被告知，
 * 不会写坏别的数据。
 *
 * @module dsh-session-mover/lib/core
 */

/**
 * 探测 workspace 注册表内部结构。
 *
 * `table` 与 `sessionPaths` 是移动必需的两块；`headers`（会话 header 缓存）与
 * `entities` 属于可选的增强项——自检、还原与护栏用得上，拿不到时对应能力降级。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry` 实例。
 * @returns {{
 *   table: { get(id: string): unknown },
 *   paths: Map<string, string>,
 *   headers: Map<string, { cwd?: string, parentSession?: string, isSeeded?: boolean }> | null,
 *   entities: Map<string, unknown> | null,
 * } | null} 结构符合预期时返回引用；否则返回 null（调用方按「不支持」处理）。
 */
export function resolveRegistryParts(registry) {
  if (registry === null || typeof registry !== 'object') return null
  const table = registry.table
  const paths = registry.sessionPaths
  if (table === null || typeof table !== 'object' || typeof table.get !== 'function') return null
  if (!(paths instanceof Map)) return null
  const headers = registry.headers instanceof Map ? registry.headers : null
  const entities = registry.entities instanceof Map ? registry.entities : null
  return { table, paths, headers, entities }
}

/**
 * 读取某个 workspace 记录里**未经过滤**的会话 id 列表。
 *
 * `workspace.sessionIds` 的 getter 会按 `candidateMatches` 过滤，不能用它判断
 * 账本的真实内容；这里直接读持久化记录。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {string} workspaceId - 目标 workspace 标识。
 * @returns {string[]} 记录中的会话 id；结构不支持或记录不存在时为空数组。
 */
export function readRawSessionIds(registry, workspaceId) {
  const parts = resolveRegistryParts(registry)
  if (parts === null) return []
  const record = parts.table.get(workspaceId)
  if (record === null || typeof record !== 'object') return []
  const ids = record.sessionIds
  return Array.isArray(ids) ? ids : []
}

/**
 * 把归属账本重新灌回内存索引：账本里记着的会话，一律按记录所在的
 * workspace 目录参与成员判定。
 *
 * 启动时调用一次即可。它同时承担「移动结果跨重启保持」与「历史遗留的
 * 过滤告警自愈」两个职责——账本是持久事实，索引只是它的派生缓存。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @returns {{ supported: boolean, applied: number }} 是否可操作与修正条数。
 */
export function replayOwnership(registry) {
  const parts = resolveRegistryParts(registry)
  if (parts === null) return { supported: false, applied: 0 }
  let applied = 0
  for (const workspace of registry.list()) {
    const record = parts.table.get(workspace.id)
    if (record === null || typeof record !== 'object') continue
    const ids = record.sessionIds
    if (!Array.isArray(ids)) continue
    for (const sessionId of ids) {
      if (parts.paths.get(sessionId) !== workspace.path) {
        parts.paths.set(sessionId, workspace.path)
        applied += 1
      }
    }
  }
  return { supported: true, applied }
}

/**
 * 把归属账本摊成一张「会话 → 目录」表。
 *
 * 这是 {@link replayOwnership} 的反方向投影：那个函数把账本灌回注册表的内存
 * 索引（为了成员过滤），这个函数把同一份事实交给**读取侧**——文件树的根、
 * 「在文件夹中打开」的目标目录，都是按会话的 cwd 推出来的，而 cwd 存在会话
 * 自己的持久化 header 里、永不重写。所以移动之后要由读取侧按账本覆盖。
 *
 * 只读账本，不改任何东西；结构不被支持时返回空 Map（调用方按「没有可覆盖项」
 * 处理，行为与未安装插件时一致）。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @returns {Map<string, string>} sessionId → 所属 workspace 的目录。
 */
export function ownershipPaths(registry) {
  const paths = new Map()
  const parts = resolveRegistryParts(registry)
  if (parts === null) return paths
  for (const workspace of registry.list()) {
    const record = parts.table.get(workspace.id)
    if (record === null || typeof record !== 'object') continue
    const ids = record.sessionIds
    if (!Array.isArray(ids)) continue
    for (const sessionId of ids) {
      if (typeof sessionId === 'string' && sessionId.length > 0) paths.set(sessionId, workspace.path)
    }
  }
  return paths
}

/**
 * 把一个会话移动到目标 workspace 的归属账本。
 *
 * 步骤：
 *   1. 目标已记账时直接返回（幂等）；
 *   2. 把内存索引改指目标目录，让 `candidateMatches` 认可这次归属；
 *   3. 写目标记录：给了 `beforeSessionId` 且它确实在目标记录里，就插到它前面，
 *      否则插到最前（符合「刚拖进来的排最前」的直觉）；
 *   4. 从原记录移除；
 *   5. 第 3、4 步任一失败时回滚内存索引，让运行中的视图与账本保持一致。
 *
 * 说明：从原记录移除即使失败也无害——`mutate()` 的剪枝会在下一次写入时
 * 依据内存索引把它剔除；这里显式移除只是让变化立刻可见。
 *
 * @param {unknown} registry - `ctx.workspaceRegistry`。
 * @param {string} sessionId - 要移动的会话。
 * @param {string} targetWorkspaceId - 目标 workspace 标识。
 * @param {string} [beforeSessionId] - 可选锚点：插到这个会话之前。
 * @returns {Promise<{
 *   changed: boolean,
 *   alreadyThere: boolean,
 *   workspace: { id: string, title: string, path: string },
 *   from: { id: string, title: string } | null,
 * }>} 移动结果（workspace/from 只带展示需要的字段）。
 * @throws {Error} 结构不支持、目标不存在或写入失败时抛出；`code` 字段给出机器可读原因。
 */
export async function moveSessionInRegistry(registry, sessionId, targetWorkspaceId, beforeSessionId) {
  const parts = resolveRegistryParts(registry)
  if (parts === null) {
    const error = new Error('当前 DSH 版本的 workspace 注册表结构不受支持，无法移动会话')
    error.code = 'registry/unsupported'
    throw error
  }

  const target = registry.get(targetWorkspaceId)
  if (target === undefined || target === null) {
    const error = new Error('目标项目不存在（可能已被删除）')
    error.code = 'workspace/not-found'
    throw error
  }

  const targetRecord = parts.table.get(target.id)
  if (targetRecord === null || typeof targetRecord !== 'object' || !Array.isArray(targetRecord.sessionIds)) {
    const error = new Error('目标项目的归属记录不可读')
    error.code = 'workspace/record-missing'
    throw error
  }

  const workspaceView = { id: target.id, title: target.title, path: target.path }
  if (targetRecord.sessionIds.includes(sessionId)) {
    return { changed: false, alreadyThere: true, workspace: workspaceView, from: null }
  }

  const fromWorkspace = registry.list().find((workspace) => {
    if (workspace.id === target.id) return false
    return readRawSessionIds(registry, workspace.id).includes(sessionId)
  })

  const hadPrevious = parts.paths.has(sessionId)
  const previousPath = parts.paths.get(sessionId)
  parts.paths.set(sessionId, target.path)

  try {
    await target.mutate((record) => {
      if (record.sessionIds.includes(sessionId)) return record
      const without = record.sessionIds.filter((id) => id !== sessionId)
      const anchorIndex = typeof beforeSessionId === 'string' && beforeSessionId !== sessionId
        ? without.indexOf(beforeSessionId)
        : -1
      const at = anchorIndex === -1 ? 0 : anchorIndex
      return {
        ...record,
        sessionIds: [...without.slice(0, at), sessionId, ...without.slice(at)],
      }
    })

    if (fromWorkspace !== undefined) {
      await fromWorkspace.mutate((record) => ({
        ...record,
        sessionIds: record.sessionIds.filter((id) => id !== sessionId),
      }))
    }
  } catch (error) {
    if (hadPrevious) parts.paths.set(sessionId, previousPath)
    else parts.paths.delete(sessionId)
    throw error
  }

  return {
    changed: true,
    alreadyThere: false,
    workspace: workspaceView,
    from: fromWorkspace === undefined ? null : { id: fromWorkspace.id, title: fromWorkspace.title },
  }
}
