/**
 * dsh-session-mover —— 移动日志（journal）。
 *
 * ## 为什么需要它
 *
 * 本插件把「归属账本」当权威，会话 header 里的 `cwd` 仍停在原项目目录。
 * 两者分叉这件事必须被**记住**，否则三类操作会出问题：
 *
 *   1. **写前修复**：`WorkspaceEntity.mutate()` 会用内存索引
 *      `sessionPaths` 剪枝（不在索引目录里的会话会被从账本里删掉）。
 *      索引一旦被官方从 header 重建，下一次任何写都会把移动过的会话
 *      永久剔除——修复时必须知道「哪些会话是我们移过的」，不能靠猜。
 *   2. **启动自检**：告诉用户当前有哪些受管会话、目标目录还在不在。
 *   3. **一键还原**：把会话搬回 header 里的原目录（原项目还在时），
 *      或者在原项目已消失时把它从账本里摘下，回到「未分组」。
 *
 * 日志只记录**会话 id → 账本目录 / 原目录 / 时间 / 来源**，不含对话内容。
 *
 * ## 存放位置
 *
 * `$DSH_HOME/dsh-session-mover/journal-v1.json`（`DSH_HOME` 未设置时用
 * `~/.dsh`）。这与宿主里其它插件的数据目录约定一致（如 `restart-desktop`、
 * `task-board` 都直接放在 `$DSH_HOME` 下）。
 *
 * 写入用「临时文件 + rename」的原子替换：崩溃最多丢最后一次写入，
 * 不会留下半截 JSON 把下一次启动带崩。
 *
 * @module dsh-session-mover/lib/journal
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 日志格式版本：结构变化时递增，旧版本按「空日志」处理。 */
export const JOURNAL_VERSION = 1

/**
 * 解析日志文件路径。
 *
 * @param {Record<string, string | undefined>} [env] - 环境变量（测试可注入）。
 * @returns {string} 绝对路径。
 */
export function resolveJournalPath(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = configured.length > 0 ? configured : join(homedir(), '.dsh')
  return join(home, 'dsh-session-mover', 'journal-v1.json')
}

/**
 * 造一份空日志。
 *
 * 每条记录的含义：
 *   - `path`：会话当前被账本记在哪个项目目录（受管状态的「现在」）；
 *   - `home`：会话 header 里的原始目录（会话文件真正所在的目录，还原目标）；
 *   - `from`：上一次移动前的项目目录（展示用，`home` 缺失时作为还原兜底）；
 *   - `kind`：`move` / `fork` / `adopt`；
 *   - `at`：最后一次写入时间。
 *
 * @returns {{ version: number, sessions: Record<string, { path: string, home?: string, from?: string, at?: string, kind?: string }> }} 空状态。
 */
function emptyJournal() {
  return { version: JOURNAL_VERSION, sessions: {} }
}

/**
 * 把磁盘内容规整成内部状态：非对象、缺字段、路径为空的条目一律丢弃。
 *
 * 容错优先于严格：日志坏了最多丢掉「受管」标记（表现为还原/自检少几条），
 * 绝不能因此让插件加载失败。
 *
 * @param {unknown} parsed - `JSON.parse` 的结果。
 * @returns {{ version: number, sessions: Record<string, { path: string, from?: string, at?: string, kind?: string }> }} 规整后的状态。
 */
export function normalizeJournal(parsed) {
  const state = emptyJournal()
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return state
  const sessions = parsed.sessions
  if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) return state
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    if (path.length === 0) continue
    state.sessions[sessionId] = {
      path,
      ...(typeof entry.home === 'string' && entry.home.length > 0 ? { home: entry.home } : {}),
      ...(typeof entry.from === 'string' && entry.from.length > 0 ? { from: entry.from } : {}),
      ...(typeof entry.at === 'string' && entry.at.length > 0 ? { at: entry.at } : {}),
      ...(typeof entry.kind === 'string' && entry.kind.length > 0 ? { kind: entry.kind } : {}),
    }
  }
  return state
}

/**
 * 创建移动日志存储。
 *
 * 首次访问时才读盘（构造不抛错）；之后所有变更都写内存，`save()` 落盘。
 *
 * @param {string} filePath - 日志文件绝对路径。
 * @param {{ warn?: (message: string, error?: unknown) => void }} [logger] - 日志。
 * @returns {{
 *   path: string,
 *   entry(sessionId: string): ({ path: string, from?: string, at?: string, kind?: string } | null),
 *   entries(): Array<{ sessionId: string, path: string, from?: string, at?: string, kind?: string }>,
 *   managedPaths(): Map<string, { path: string, from?: string, at?: string, kind?: string }>,
 *   record(sessionId: string, patch: { path: string, from?: string, kind?: string, at?: string }): (object | null),
 *   forget(sessionId: string): boolean,
 *   save(): boolean,
 *   reload(): void,
 * }} 日志存储。
 */
export function createJournalStore(filePath, logger) {
  let state = emptyJournal()
  let loaded = false

  /** 读一次盘（只读一次；失败按空日志继续）。 */
  const load = () => {
    loaded = true
    try {
      const text = readFileSync(filePath, 'utf8')
      state = normalizeJournal(JSON.parse(text))
    } catch (error) {
      // 文件不存在是正常情况（第一次运行）；其它错误只记日志。
      if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
        logger?.warn?.('[dsh-session-mover] 读取移动日志失败（按空日志继续）', error)
      }
    }
  }

  /** 确保已读盘。 */
  const ensureLoaded = () => {
    if (!loaded) load()
  }

  return {
    path: filePath,

    entry(sessionId) {
      ensureLoaded()
      const entry = state.sessions[sessionId]
      return entry === undefined ? null : { ...entry }
    },

    entries() {
      ensureLoaded()
      return Object.entries(state.sessions).map(([sessionId, entry]) => ({ sessionId, ...entry }))
    },

    managedPaths() {
      ensureLoaded()
      return new Map(Object.entries(state.sessions).map(([sessionId, entry]) => [sessionId, { ...entry }]))
    },

    /**
     * 记录/更新一条受管会话。
     *
     * @param {string} sessionId - 会话标识。
     * @param {{ path: string, home?: string, from?: string, kind?: string, at?: string }} patch - 本次写入的字段。
     * @returns {object | null} 写入前的条目（供失败回滚），没有时返回 null。
     */
    record(sessionId, patch) {
      ensureLoaded()
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      if (patch === null || typeof patch !== 'object' || typeof patch.path !== 'string' || patch.path.length === 0) return null
      const previous = state.sessions[sessionId]
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...previous,
            ...patch,
            at: typeof patch.at === 'string' ? patch.at : new Date().toISOString(),
          },
        },
      }
      return previous === undefined ? null : { ...previous }
    },

    /**
     * 忘掉一条受管记录。
     *
     * @param {string} sessionId - 会话标识。
     * @returns {boolean} 是否真的删掉了。
     */
    forget(sessionId) {
      ensureLoaded()
      if (state.sessions[sessionId] === undefined) return false
      const sessions = { ...state.sessions }
      delete sessions[sessionId]
      state = { ...state, sessions }
      return true
    },

    /**
     * 落盘（原子替换）。
     *
     * @returns {boolean} 是否写入成功。
     */
    save() {
      ensureLoaded()
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        const temporary = `${filePath}.tmp`
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        renameSync(temporary, filePath)
        return true
      } catch (error) {
        logger?.warn?.('[dsh-session-mover] 写入移动日志失败（本次移动仍已生效）', error)
        return false
      }
    },

    /** 重新读盘（测试用；正常流程不会调用）。 */
    reload() {
      loaded = false
      state = emptyJournal()
      load()
    },
  }
}
