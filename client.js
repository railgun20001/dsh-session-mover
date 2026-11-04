/**
 * dsh-session-mover —— 客户端半（浏览器 bundle 的 factory 体）。
 *
 * ## 用户看到的行为
 *
 * 在侧栏里按住一个对话往另一个「项目」分组上拖，目标分组会亮起描边；
 * 松手后这段对话就归到那个项目下。整个过程不需要打开对话，也不需要菜单。
 *
 * ## 为什么要自己接管拖拽
 *
 * 官方的会话行本来就是 `draggable` 的，但那套拖拽只做**同一分组内的手动排序**：
 * `SessionNodeItem` 只在自己所属分组里把行标成可放置目标（`compatibleTarget`
 * 要求 `sameGroupDrag`），项目行（`ProjectRowItem`）的 `onDragOver` 只在拖动
 * 工作区分组本身时才挂。也就是说，把对话拖到另一个项目上在官方实现里是
 * 「无处可放」的手势。
 *
 * 本插件在 `window` 捕获阶段接管这个手势：
 *
 *   - `dragstart`：认出来源是侧栏里的会话行，记下会话 id 与它所在的分组；
 *   - `dragover`：命中「另一个项目」时 `preventDefault()` 并点亮目标；
 *   - `drop`：把会话交给宿主的移动路由，并阻止官方同组排序逻辑误判；
 *   - `dragend`：无论成功与否都清掉拖动状态，避免样式残留。
 *
 * 拖到**同一个**分组上时一律放行给官方处理（那就是排序），本插件不干预。
 *
 * ## 为什么还要动会话摘要的 cwd
 *
 * 归属账本换成目标项目之后，侧栏分组立刻变了，但**会话摘要里的 `cwd` 没变**：
 * 它来自会话持久化的 header（写一次就不会重写）。而侧边文件树的根、
 * 「在文件夹中打开」的目标都读这个字段——于是会出现「已经挂在新项目下，
 * 打开文件夹却是旧目录」。
 *
 * 所以这里在客户端会话列表的快照写入处补一层投影：把宿主 `/api/ownership`
 * 给出的账本覆盖到 `byId[sessionId].cwd` 上。宿主半同时接管了
 * `workspaceFileScope`（见 `lib/view.js`），保证新目录确实是宿主认可的
 * 工作区根，两边一致才不会出现「客户端要新目录、宿主拒绝越界」。
 *
 * ## 与 DOM 的耦合
 *
 * 侧栏不是插件渲染的，插件只能读官方组件留下的稳定标记：
 *   - 会话行：`[data-row-key="session:<id>"]`；
 *   - 项目行：`[data-row-key="workspace:<workspaceId>"]`；
 *   - 侧栏根：`[data-slot="sidebar"]`。
 *
 * 这里全部按「找不到就放弃」处理：官方改了标记，最坏结果是拖拽不生效，
 * 不会影响侧栏本身的任何交互。
 *
 * ## 视觉
 *
 * 插件不渲染任何常驻 UI：移动结果写进控制台日志（`console.info` / `console.warn`），
 * 界面上只保留拖动期间的项目描边与源行淡化，颜色全部取自 `--dsw-alias-*` 主题令牌。
 *
 * @module dsh-session-mover/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-mover',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 包名：日志、样式标签、路由前缀都用它。 */
    const PKG = 'dsh-session-mover'
    /** 移动接口：与宿主半的 `MOVE_PATH` 一致。 */
    const MOVE_ROUTE = `/${PKG}/api/move`
    /** 归属投影接口：与宿主半的 `OWNERSHIP_PATH` 一致。 */
    const OWNERSHIP_ROUTE = `/${PKG}/api/ownership`
    /** 受管会话清单接口：与宿主半的 `MANAGED_PATH` 一致（只读）。 */
    const MANAGED_ROUTE = `/${PKG}/api/managed`
    /** 拖动期间挂在 `<body>` 上的类名（用来点亮所有项目分组）。 */
    const DRAG_CLASS = 'dsm-dragging'
    /** 当前悬停目标上的标记属性。 */
    const OVER_ATTR = 'data-dsm-over'
    /** 拖动源行上的标记属性。 */
    const SOURCE_ATTR = 'data-dsm-drag-source'

    /**
     * 边缘自动滚动的触发带高度（CSS 像素）。
     *
     * 指针进入列表可见区上下各这么多像素时开始滚动；越贴近边缘越快。
     * 取 56px 是因为侧栏一行高 32px，这样大约「一行半」进入边缘就开始加速，
     * 手指还没到边界时列表已经动起来，长列表跨分组拖动才不别扭。
     */
    const EDGE_SCROLL_BAND = 56
    /** 边缘自动滚动的每帧最大位移（CSS 像素，约 60 帧/秒）。 */
    const EDGE_SCROLL_MAX_STEP = 18
    /** 边缘自动滚动的每帧最小位移：保证一进入触发带就有可见反馈。 */
    const EDGE_SCROLL_MIN_STEP = 2

    /** 侧栏根：官方 shell 给插槽内容写的稳定标记。 */
    const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
    /** 会话行标记前缀。 */
    const SESSION_PREFIX = 'session:'
    /** 项目行标记前缀。 */
    const WORKSPACE_PREFIX = 'workspace:'

    /**
     * 归属投影：sessionId → 所属项目目录。
     *
     * 由宿主半的 `/api/ownership` 给出（账本在宿主那边），客户端只读；空 Map
     * 表示「还不知道」，此时不改写任何快照。
     *
     * @type {Map<string, string>}
     */
    let ownership = new Map()

    /** 客户端会话服务；取不到时为 `null`，退化为不改写。 */
    let sessionsService = null

    /**
     * 最近一次写入列表快照的**原值**。
     *
     * 改写必须是「原快照 + 当前账本」，不能在已改写的快照上叠加——否则会话
     * 移回原项目时，旧的覆盖会粘住。
     */
    let lastSnapshot = null

    /**
     * 改写结果的复用表：原始行对象 → `{ ownership, row }`。
     *
     * 会话列表每次刷新都会推来一批行对象，而列表项按对象身份做 memo；按**原始行
     * 对象**做键复用改写结果：行没变时（宿主 `buildListSnapshot()` 会复用同一个
     * entry 对象）改写结果也保持不变，避免无谓重渲染。
     *
     * 注意不能用「会话 + cwd」这类值键：`running`、`blank`、`retainedBy` 等字段
     * 会独立变化，用旧键命中会把「进行中」状态永久冻结在改写那一刻——症状就是
     * 被移动过的会话在侧栏和状态中心都不再显示运行中（回归用例见
     * `test/client-test.mjs`）。
     *
     * @type {WeakMap<object, { ownership: Map<string, string>, row: object }>}
     */
    const rewrittenRows = new WeakMap()

    /**
     * 改写后的快照复用表：原快照对象 → 改写后的快照。
     *
     * 同一份原快照被重复写入时（例如账本变化后的重放）返回同一个对象，
     * 订阅方就不会因为「换了壳但内容一样」而白白重渲染。
     *
     * @type {WeakMap<object, object>}
     */
    const rewrittenSnapshots = new WeakMap()

    /**
     * 按归属账本改写一份会话列表快照里的 `cwd`。
     *
     * 为什么需要它：`cwd` 来自会话持久化的 header，永不重写；而侧边文件树的
     * 根、「打开文件夹」的目标都读这个字段。不改写的话，会话在侧栏已经挂到
     * 新项目下，文件树却还指着旧目录。
     *
     * 只动 `byId` 里确有账本条目的会话，并且值相同就原样返回同一个快照对象，
     * 避免无意义的重渲染。
     *
     * 边界：账本条目消失时（项目被删、会话变成「未分组」）这里不会把 cwd 还原
     * 成 header 原值——移动过的行可能已经带着改写后的目录。代价只是那棵文件树
     * 指向一个仍在磁盘上的目录，不影响会话本身；用户重新拖回任意项目即可修正。
     *
     * @param {unknown} snapshot - 会话列表快照。
     * @returns {unknown} 改写后的快照（无需改动时返回原对象）。
     */
    function applyOwnership(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object' || ownership.size === 0) return snapshot
      const byId = snapshot.byId
      if (byId === null || typeof byId !== 'object') return snapshot

      // 同一份原快照 + 同一份账本 = 同一个结果，直接复用（会话列表会反复推送
      // 同一批行，没必要每次都换壳）。
      const cached = rewrittenSnapshots.get(snapshot)
      if (cached !== undefined && cached.ownership === ownership) return cached.snapshot

      let changed = false
      const next = {}
      for (const sessionId of Object.keys(byId)) {
        const row = byId[sessionId]
        const path = ownership.get(sessionId)
        if (path === undefined || row === null || typeof row !== 'object' || row.cwd === path) {
          next[sessionId] = row
          continue
        }
        const cachedRow = rewrittenRows.get(row)
        if (cachedRow !== undefined && cachedRow.ownership === ownership) {
          next[sessionId] = cachedRow.row
          changed = true
          continue
        }
        const rewritten = { ...row, cwd: path }
        rewrittenRows.set(row, { ownership, row: rewritten })
        next[sessionId] = rewritten
        changed = true
      }

      const withOwnership = changed ? { ...snapshot, byId: next } : snapshot
      rewrittenSnapshots.set(snapshot, { ownership, snapshot: withOwnership })
      return withOwnership
    }

    /**
     * 把最近一份快照按最新账本重放一次。
     *
     * 移动不改变宿主的会话列表（会话 id 不变），所以不会有新的列表推送；
     * 这里拿原快照重放一次，让界面立刻跟上，不用等下一次刷新或重启页面。
     */
    function replayOwnership() {
      const store = sessionsService?.list
      if (store === undefined || store === null || typeof store.set !== 'function' || lastSnapshot === null) return
      try {
        store.set(lastSnapshot)
      } catch (error) {
        console.error(`[${PKG}] 重放归属投影失败（界面可能仍显示旧目录）`, error)
      }
    }

    /**
     * 已经见过的会话 id。
     *
     * 归属投影只覆盖「写这份投影时账本里已有的会话」；分叉（或任何新建）出来的
     * 会话在做完投影之后才出现，不及时重取就会带着父会话的原始 cwd。所以列表里
     * 一出现没见过的 id，就重新取一次账本。
     *
     * @type {Set<string>}
     */
    const seenSessions = new Set()

    /** 归属重取是否已排程（把同一批新会话合并成一次请求）。 */
    let ownershipRefreshScheduled = false

    /**
     * 排程一次归属重取（同一帧内多次触发只发一次）。
     */
    function scheduleOwnershipRefresh() {
      if (ownershipRefreshScheduled) return
      ownershipRefreshScheduled = true
      window.setTimeout(() => {
        ownershipRefreshScheduled = false
        void refreshOwnership()
      }, 0)
    }

    /**
     * 记下快照里的会话 id，返回是否需要重取归属投影。
     *
     * 判据是「出现了一个当前投影里还没有的会话」：分叉出来的子会话就是这样
     * （它在父会话之后才进账本）。已经在投影里的会话、以及投影为空（宿主没提供
     * 归属投影、或取失败）时都不重取，避免每帧都打一次接口。
     *
     * @param {unknown} snapshot - 会话列表快照。
     * @returns {boolean} 是否需要重取。
     */
    function noteNewSessions(snapshot) {
      const byId = snapshot?.byId
      if (byId === null || typeof byId !== 'object') return false
      if (ownership.size === 0) return false
      let unknown = false
      for (const sessionId of Object.keys(byId)) {
        if (seenSessions.has(sessionId)) continue
        seenSessions.add(sessionId)
        if (!ownership.has(sessionId)) unknown = true
      }
      return unknown
    }

    /**
     * 取一次归属投影，成功后重放当前快照。
     *
     * 失败只记日志：界面退回「会话摘要里的原始 cwd」，也就是没有读取侧覆盖时
     * 的行为，不会影响拖拽本身。
     */
    async function refreshOwnership() {
      try {
        const response = await fetch(OWNERSHIP_ROUTE, { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const payload = await response.json().catch(() => null)
        if (payload === null || payload === undefined || payload.ok !== true) return
        const paths = payload.paths
        if (paths === null || typeof paths !== 'object') return
        const next = new Map()
        for (const [sessionId, path] of Object.entries(paths)) {
          if (typeof path === 'string' && path.length > 0) next.set(sessionId, path)
        }
        ownership = next
        replayOwnership()
      } catch (error) {
        console.warn(`[${PKG}] 读取归属投影失败（界面可能仍显示旧目录）`, error)
      }
    }

    /**
     * 接管客户端会话列表快照的写入。
     *
     * `createSnapshotStore` 的 `set` 是唯一写入口（首屏拉取、重连修复、增删改
     * 都经过它），所以在这里改写一次即可覆盖全部来源。
     *
     * @param {object} ctx - 注入作用域上下文（`sessions` 已就绪）。
     * @returns {boolean} 是否接管成功。
     */
    function installCwdView(ctx) {
      let sessions
      try {
        sessions = ctx.get('sessions')
      } catch (error) {
        sessions = undefined
      }
      const store = sessions?.list
      if (store === null || typeof store !== 'object' || typeof store.set !== 'function') {
        console.warn(`[${PKG}] 取不到客户端会话列表，摘要 cwd 不会跟随移动`)
        return false
      }
      const originalSet = store.set
      /**
       * 改写入口：记住原快照，再把账本投影喂给真正的写入。
       *
       * 用普通函数而不是箭头函数，是为了透传调用方传入的 `this`
       * （快照存储可能把它绑在自己的闭包里）。
       */
      const patchedSet = function (snapshot) {
        lastSnapshot = snapshot
        // 新会话（例如刚刚分叉出来的子会话）要再取一次账本，否则它只会带着
        // 父会话 header 里的原始 cwd，侧栏文件树/「打开文件夹」还落在旧目录。
        if (noteNewSessions(snapshot)) scheduleOwnershipRefresh()
        return originalSet.call(this, applyOwnership(snapshot))
      }
      try {
        store.set = patchedSet
      } catch (error) {
        console.warn(`[${PKG}] 会话列表快照不可写，摘要 cwd 不会跟随移动`, error)
        return false
      }
      if (store.set !== patchedSet) {
        console.warn(`[${PKG}] 会话列表快照拒绝接管，摘要 cwd 不会跟随移动`)
        return false
      }
      sessionsService = sessions
      void refreshOwnership()
      return true
    }

    /**
     * 生成注入到页面的样式表。
     *
     * 说明：拖动高亮必须落在**官方渲染的行**上，所以只能用属性选择器；
     * 颜色全部来自主题令牌，明暗主题自动跟随。
     *
     * @returns {string} CSS 文本。
     */
    function buildCss() {
      return [
        /* ── 拖动中的全局提示：所有项目分组显示可放置描边 ── */
        `body.${DRAG_CLASS} [data-row-key^="${WORKSPACE_PREFIX}"]{outline:1px dashed var(--dsw-alias-border-l2);outline-offset:-1px;border-radius:var(--dsw-radius-md);cursor:copy}`,
        `body.${DRAG_CLASS} [data-row-key^="${WORKSPACE_PREFIX}"][${OVER_ATTR}]{outline:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}`,
        `body.${DRAG_CLASS} [data-row-key^="${SESSION_PREFIX}"][${SOURCE_ATTR}]{opacity:.45}`,
      ].join('\n')
    }

    /**
     * 判断一个节点是否在侧栏里。
     *
     * 侧栏根优先用官方的 `data-slot="sidebar"` 标记；拿不到时退化为
     * `document.body`——`data-row-key` 在整套客户端里只有工作区浏览器会用
     * （已核对：只出现在 `dsh-client-ui-workspace`），所以不会误命中别处。
     *
     * @param node - 任意节点。
     * @returns 遍历上界元素，永不返回 null。
     */
    function sidebarOf(node) {
      if (!(node instanceof Element)) return document.body
      return node.closest(SIDEBAR_SELECTOR) ?? document.body
    }

    /**
     * 取会话行（拖动来源）。
     *
     * @param target - 事件目标。
     * @returns `{ row, sessionId }` 或 null。
     */
    function resolveSessionRow(target) {
      if (!(target instanceof Element)) return null
      const row = target.closest(`[data-row-key^="${SESSION_PREFIX}"]`)
      if (!(row instanceof Element)) return null
      const key = row.getAttribute('data-row-key') ?? ''
      const sessionId = key.slice(SESSION_PREFIX.length)
      if (sessionId.length === 0) return null
      return { row, sessionId }
    }

    /**
     * 取事件目标所属的项目分组（放置目标）。
     *
     * 命中顺序：
     *   1. 目标本身在项目行里 → 直接用这个项目行；
     *   2. 目标落在分组内部的其它位置（会话行、空白）→ 向上找到「直接含有
     *      项目行」的容器，再取它的项目行。
     *
     * 若落点正好在某个会话行里，就把那个会话作为插入锚点（放到它前面）；
     * 落在项目标题上则没有锚点（放到最前）。锚点是否真在目标项目里由宿主校验，
     * 不在时退化到最前，不会出错。
     *
     * 「未分组」没有对应的 workspace 记录，不能作为移动目标，返回 null。
     *
     * @param target - 事件目标。
     * @returns `{ workspaceId, element, beforeSessionId? }` 或 null。
     */
    function resolveGroup(target) {
      if (!(target instanceof Element)) return null
      const root = sidebarOf(target)
      if (root === null) return null

      const anchorRow = target.closest(`[data-row-key^="${SESSION_PREFIX}"]`)
      const beforeSessionId = anchorRow instanceof Element && root.contains(anchorRow)
        ? (anchorRow.getAttribute('data-row-key') ?? '').slice(SESSION_PREFIX.length)
        : ''

      const direct = target.closest(`[data-row-key^="${WORKSPACE_PREFIX}"]`)
      if (direct instanceof Element && root.contains(direct)) {
        const workspaceId = (direct.getAttribute('data-row-key') ?? '').slice(WORKSPACE_PREFIX.length)
        if (workspaceId.length === 0) return null
        return {
          workspaceId,
          element: direct,
          ...beforeSessionId.length === 0 ? {} : { beforeSessionId },
        }
      }

      let node = target
      while (node !== null && node !== root) {
        const header = node.querySelector(`:scope > [data-row-key^="${WORKSPACE_PREFIX}"]`)
        if (header instanceof Element) {
          const workspaceId = (header.getAttribute('data-row-key') ?? '').slice(WORKSPACE_PREFIX.length)
          if (workspaceId.length === 0) return null
          return {
            workspaceId,
            element: header,
            ...beforeSessionId.length === 0 ? {} : { beforeSessionId },
          }
        }
        node = node.parentElement
      }
      return null
    }

    /**
     * 找到会话行所在的可滚动容器（侧栏的会话列表）。
     *
     * 官方没有给列表容器单独的稳定标记，所以按「轴上真的能滚」来判断：
     * 从行往上找第一个 `overflow-y` 为 auto/scroll 且内容高于可视区的祖先。
     * 找不到时返回 null——此时不做边缘滚动，其它拖拽行为不受影响。
     *
     * @param start - 拖动源行。
     * @returns 滚动容器或 null。
     */
    function findScrollContainer(start) {
      let node = start.parentElement
      while (node !== null && node !== document.body && node !== document.documentElement) {
        try {
          const style = window.getComputedStyle(node)
          const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll'
          if (scrollable && node.scrollHeight > node.clientHeight + 1) return node
        } catch {
          /* 计算样式失败时继续向上找 */
        }
        node = node.parentElement
      }
      return null
    }

    /**
     * 计算边缘自动滚动这一帧要走多少像素。
     *
     * 指针落在触发带里时，越贴近边缘速度越快（线性），到边界处达到上限；
     * 指针已经越过容器边界（拖到列表外面）时同样按上限滚动，这样用户不必
     * 精确停在容器内也能持续往下翻。
     *
     * @param rect - 滚动容器的可视区矩形。
     * @param y - 指针的视口纵坐标。
     * @returns 负数向上滚、正数向下滚、0 不滚。
     */
    function edgeScrollDelta(rect, y) {
      if (rect.height <= 0) return 0
      const band = Math.min(EDGE_SCROLL_BAND, rect.height / 2)
      if (band <= 0) return 0
      if (y < rect.top + band) {
        const depth = Math.min(1, (rect.top + band - y) / band)
        return -Math.max(EDGE_SCROLL_MIN_STEP, Math.round(EDGE_SCROLL_MAX_STEP * depth))
      }
      if (y > rect.bottom - band) {
        const depth = Math.min(1, (y - (rect.bottom - band)) / band)
        return Math.max(EDGE_SCROLL_MIN_STEP, Math.round(EDGE_SCROLL_MAX_STEP * depth))
      }
      return 0
    }

    /**
     * 插件入口：样式、会话摘要投影、拖拽监听。
     *
     * 每一项都单独 try/catch：任何一环失败只丢那一项，绝不让 apply 抛错
     * （apply 抛错会让整个页面起不来）。
     *
     * @param ctx - 插件上下文。
     */
    function apply(ctx) {
      try {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.dshPlugin = PKG
          tag.textContent = buildCss()
          document.head.appendChild(tag)
          return () => tag.remove()
        }, `${PKG}: 样式`)
      } catch (error) {
        console.error(`[${PKG}] 样式注入失败`, error)
      }

      try {
        ctx.inject(['sessions'], (scope) => {
          try {
            installCwdView(scope)
          } catch (error) {
            console.error(`[${PKG}] 接管会话摘要 cwd 失败（文件树仍显示原始目录）`, error)
          }
        })
      } catch (error) {
        console.error(`[${PKG}] 无法声明 sessions 依赖（文件树仍显示原始目录）`, error)
      }

      /** 当前拖动：来源会话、它所在的分组、来源行元素。 */
      let drag = null
      /** 当前高亮的放置目标（项目行元素）。 */
      let over = null
      /** 指针最近一次的视口坐标（拖拽期间持续更新，用于边缘滚动与落点重算）。 */
      let pointer = null
      /** 边缘滚动作用的容器（拖动开始时按 DOM 结构探测）。 */
      let scrollHost = null
      /** 边缘滚动的帧循环句柄。 */
      let scrollFrame = null
      /** 我们临时改过 `scroll-behavior` 的元素与它原来的值。 */
      let styledHost = null
      let styledBehavior = ''

      /** 清掉高亮但保留拖动状态。 */
      const clearOver = () => {
        if (over !== null) over.removeAttribute(OVER_ATTR)
        over = null
      }

      /** 切换到某个放置目标（同一个目标不重复写 DOM）。 */
      const setOver = (element) => {
        if (over === element) return
        clearOver()
        over = element
        if (over !== null) over.setAttribute(OVER_ATTR, '1')
      }

      /**
       * 用指针当前位置重新解析放置目标。
       *
       * 边缘滚动会让列表在指针不动的情况下移动，`dragover` 里的事件目标于是
       * 过期；命中测试必须重算，否则高亮会停在滚走的那一行上。
       *
       * @param fallbackTarget - 命中测试失败时回退用的事件目标。
       * @returns 放置目标或 null。
       */
      const groupAtPointer = (fallbackTarget) => {
        let element = null
        if (pointer !== null) {
          try {
            element = document.elementFromPoint(pointer.x, pointer.y)
          } catch {
            element = null
          }
        }
        return resolveGroup(element) ?? resolveGroup(fallbackTarget)
      }

      /**
       * 接管滚动容器的 `scroll-behavior`。
       *
       * 若容器设了 `scroll-behavior: smooth`，每帧给 `scrollTop` 赋值会不断
       * 重新启动平滑动画，边缘滚动会变得又慢又飘。拖动期间临时改成 `auto`，
       * 松手后原样还回去。
       *
       * @param host - 当前滚动容器，可为 null。
       */
      const adoptScrollHost = (host) => {
        if (styledHost === host) return
        if (styledHost !== null) {
          styledHost.style.scrollBehavior = styledBehavior
          styledHost = null
          styledBehavior = ''
        }
        if (host !== null) {
          styledHost = host
          styledBehavior = host.style.scrollBehavior
          host.style.scrollBehavior = 'auto'
        }
      }

      /** 边缘滚动的一帧：先按指针位置滚动，再按新布局重算高亮。 */
      const tickEdgeScroll = () => {
        if (drag === null) {
          scrollFrame = null
          return
        }
        let moved = false
        if (pointer !== null) {
          if (scrollHost !== null && !scrollHost.isConnected) scrollHost = findScrollContainer(drag.row)
          adoptScrollHost(scrollHost)
          if (scrollHost !== null) {
            const rect = scrollHost.getBoundingClientRect()
            const delta = edgeScrollDelta(rect, pointer.y)
            if (delta !== 0) {
              const before = scrollHost.scrollTop
              scrollHost.scrollTop = before + delta
              moved = scrollHost.scrollTop !== before
            }
          }
        }
        if (moved) {
          const group = groupAtPointer()
          if (group === null || group.workspaceId === drag.sourceWorkspaceId) clearOver()
          else setOver(group.element)
        }
        scrollFrame = window.requestAnimationFrame(tickEdgeScroll)
      }

      /** 启动边缘滚动帧循环（已在跑时忽略）。 */
      const startEdgeScroll = () => {
        if (scrollFrame !== null) return
        scrollFrame = window.requestAnimationFrame(tickEdgeScroll)
      }

      /** 停止帧循环，清掉与指针相关的临时状态。 */
      const stopEdgeScroll = () => {
        if (scrollFrame !== null) {
          window.cancelAnimationFrame(scrollFrame)
          scrollFrame = null
        }
        adoptScrollHost(null)
        pointer = null
        scrollHost = null
      }

      /** 结束一次拖动：清掉所有临时标记与帧循环。 */
      const finishDrag = () => {
        if (drag !== null) drag.row.removeAttribute(SOURCE_ATTR)
        drag = null
        clearOver()
        stopEdgeScroll()
        document.body.classList.remove(DRAG_CLASS)
      }

      /**
       * 调宿主的移动路由。
       *
       * 结果写进控制台：插件不渲染提示条，移动成功后界面上的唯一变化就是
       * 会话出现在目标项目下、文件树/「打开文件夹」改指新目录。
       *
       * @param sessionId - 会话标识。
       * @param workspaceId - 目标项目标识。
       * @param beforeSessionId - 可选锚点：插到这个会话之前。
       */
      const move = async (sessionId, workspaceId, beforeSessionId) => {
        try {
          const response = await fetch(MOVE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              workspaceId,
              ...beforeSessionId === undefined ? {} : { beforeSessionId },
            }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            const message = payload?.error?.message ?? `HTTP ${response.status}`
            console.warn(`[${PKG}] 移动失败：${message}`)
            return
          }
          if (payload.alreadyThere === true) {
            console.info(`[${PKG}] 会话 ${sessionId} 已在目标项目里`)
            return
          }
          // 归属变了：重新取一次账本投影并重放快照，让文件树 /「打开文件夹」
          // 立刻指向新目录（不等下一次列表刷新）。
          void refreshOwnership()
          const name = payload.workspace?.title ?? ''
          const directory = payload.workingDirectory === 'skipped' ? '工作目录保持不变' : '工作目录已切换'
          console.info(`[${PKG}] 已把会话 ${sessionId} 移到「${name}」（${directory}）`)
        } catch (error) {
          console.warn(`[${PKG}] 移动失败：${String(error?.message ?? error)}`)
        }
      }

      /** 拖动开始：只认侧栏里的会话行；项目行自己的拖动交给官方排序。 */
      const onDragStart = (event) => {
        const row = resolveSessionRow(event.target)
        if (row === null) return
        const group = resolveGroup(row.row)
        drag = { sessionId: row.sessionId, sourceWorkspaceId: group?.workspaceId ?? '', row: row.row }
        pointer = { x: event.clientX, y: event.clientY }
        scrollHost = findScrollContainer(row.row)
        row.row.setAttribute(SOURCE_ATTR, '1')
        document.body.classList.add(DRAG_CLASS)
        startEdgeScroll()
      }

      /**
       * 拖动经过：命中另一个项目就接管这次放置。
       *
       * 命中同组时什么都不做——那是官方的手动排序，插件不抢。
       */
      const onDragOver = (event) => {
        if (drag === null) return
        pointer = { x: event.clientX, y: event.clientY }
        const group = groupAtPointer(event.target)
        if (group === null || group.workspaceId === drag.sourceWorkspaceId) {
          clearOver()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
        setOver(group.element)
      }

      /** 放下：真正发起移动。 */
      const onDrop = (event) => {
        if (drag === null) return
        const group = groupAtPointer(event.target)
        if (group === null || group.workspaceId === drag.sourceWorkspaceId) return
        event.preventDefault()
        event.stopPropagation()
        const pending = drag
        finishDrag()
        void move(pending.sessionId, group.workspaceId, group.beforeSessionId)
      }

      /** 拖动结束（含未放下）：清理临时状态。 */
      const onDragEnd = () => {
        if (drag === null) return
        finishDrag()
      }

      try {
        ctx.effect(() => {
          window.addEventListener('dragstart', onDragStart, true)
          window.addEventListener('dragover', onDragOver, true)
          window.addEventListener('drop', onDrop, true)
          window.addEventListener('dragend', onDragEnd, true)
          return () => {
            window.removeEventListener('dragstart', onDragStart, true)
            window.removeEventListener('dragover', onDragOver, true)
            window.removeEventListener('drop', onDrop, true)
            window.removeEventListener('dragend', onDragEnd, true)
            finishDrag()
          }
        }, `${PKG}: 拖拽接管`)
      } catch (error) {
        console.error(`[${PKG}] 拖拽监听挂载失败`, error)
      }

      // 控制台诊断接口：只读，不提供任何改动数据的操作。
      try {
        ctx.effect(() => {
          const api = {
            /**
             * 取受管会话清单（只读）。
             *
             * @returns {Promise<{ sessions: Array<object>, summary: object } | null>} 清单。
             */
            async managed() {
              try {
                const response = await fetch(MANAGED_ROUTE, { headers: { accept: 'application/json' } })
                if (!response.ok) return null
                const payload = await response.json().catch(() => null)
                return payload?.ok === true ? { sessions: payload.sessions ?? [], summary: payload.summary ?? {} } : null
              } catch {
                return null
              }
            },
          }
          window.__DSH_SESSION_MOVER__ = api
          return () => {
            if (window.__DSH_SESSION_MOVER__ === api) delete window.__DSH_SESSION_MOVER__
          }
        }, `${PKG}: 控制台接口`)
      } catch (error) {
        console.error(`[${PKG}] 控制台接口挂载失败`, error)
      }
    }

    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
