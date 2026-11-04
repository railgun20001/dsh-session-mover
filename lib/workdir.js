/**
 * dsh-session-mover —— 会话工作目录同步（宿主半、移动与分叉共用）。
 *
 * 「归属」和「工作目录」是两件独立的事：
 *
 *   - 归属记在 workspace 账本里（`sessionIds`），决定侧栏挂在哪个项目下；
 *   - 工作目录是会话自己的 `workingDirectory` 投影（由 `working-directory/change`
 *     事件折叠而来），决定工具在哪个目录里执行、`cd` 之后从哪继续。
 *
 * 移动会话要同时改这两处，分叉出来的子会话也一样（它继承的是父会话 header 里
 * 的**原始** cwd，而不是父会话当前的工作目录）。所以这一层抽成独立模块。
 *
 * @module dsh-session-mover/lib/workdir
 */

/**
 * 尽力把会话的工作目录切到目标目录。
 *
 * 三种情况：
 *   - 会话有存活 Agent：走官方的 `workingDirectory.set()`，会追加
 *     `working-directory/change` 事件并给模型一条通知；
 *   - 会话已加载但没有 Agent：补一条同样的官方事件（事件类型是框架公开的
 *     持久事实，恢复时会重新折叠成工作目录）；
 *   - 其它（会话尚未加载）：跳过，如实回报。此时归属已经生效，
 *     下次打开对话时会看到它挂在目标项目下，工作目录仍是原来的目录。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {string} sessionId - 会话标识。
 * @param {string} path - 目标项目目录。
 * @returns {Promise<'agent' | 'session' | 'skipped'>} 实际走通的路径。
 */
export async function syncWorkingDirectory(ctx, sessionId, path) {
  const agents = ctx.get('agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  const workingDirectory = ctx.get('workingDirectory')
  if (agent !== undefined && agent !== null) {
    if (typeof workingDirectory?.set === 'function') {
      await workingDirectory.set(agent, path)
      return 'agent'
    }
  }
  const sessions = ctx.get('sessions')
  const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  // 只在这一版宿主确实注册了 workingDirectory 服务时才补事件：该服务负责把
  // `working-directory/change` 注册进日志 schema。没有这个服务的旧宿主（如
  // 0.2.0-rc.2）会把这条事件当成「未知事件」，之后连 fork / 读取都会拒绝解析。
  if (workingDirectory !== undefined && workingDirectory !== null
    && session !== undefined && session !== null && typeof session.append === 'function') {
    session.append('working-directory/change', { cwd: path })
    return 'session'
  }
  return 'skipped'
}
