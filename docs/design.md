# 设计文档 —— dsh-session-mover

> 面向维护者；用户文档见 [README.md](../README.md)。真机验收矩阵见 [acceptance.md](acceptance.md)。

## DSH 的双记账模型

DSH 把「会话属于哪个项目」记在两处：

- 每个 workspace 记录里的 `sessionIds`（持久化的有序归属账本）；
- 注册表内存索引 `sessionPaths`（sessionId → 规范化 cwd），用于过滤掉已经不在该目录的成员。

官方 API 只支持同一 workspace 内的排序（`insertSessionBefore` 要求会话已记账），会话的 JSONL
header 又是只读的（按 cwd 分目录、已提交的 header 永不重写）。所以本插件把**归属账本当权威**：

- 移动时先让内存索引指向目标目录，再改写两边 workspace 的记录；
- 启动时把账本里的归属重新灌回索引，让移动跨重启保持；
- 每次写官方账本前再修一次索引（写前修复），避免被剪枝。

但「归属」还有第三个读者：**任何按会话 `cwd` 推导目录的界面**。侧边文件树的根、会话头部的
「打开文件夹」目标、聊天里相对路径的解析，用的都是会话摘要里的 `cwd`——它来自永不重写的
header，不会因为账本变了而变。所以插件再补两块（都不改写会话文件的内容与位置）：

- **宿主侧**：用 typert 的 effect-scoped 覆盖点接管 `workspaceFileScope` 查找参数
  （`lib/view.js`），让文件系统接口按账本而不是 header 解析工作区根。这是 DSH 明确支持的
  装配扩展点（业务包注册声明与默认策略，Host 组合可覆盖解析行为），插件卸载即撤除；
  账本里没有的会话原样交回默认策略。
- **客户端侧**：宿主多开一个只读的 `/api/ownership`（会话 → 目录），客户端半在会话列表
  快照的写入处把 `cwd` 覆盖成账本目录。`createSnapshotStore` 的 `set` 是唯一写入口，
  改写一次即覆盖首屏、重连修复、增删改全部来源；移动完成后立刻重放一次快照，不必等页面刷新。

唯一写入会话日志的地方是「工作目录切换」：会话已加载时插件调用官方的 `workingDirectory.set()`，
它会追加一条 `working-directory/change` 事件（与用户自己 `cd` 完全一样，模型也会收到一条
目录变更通知）；会话未加载时跳过，不写任何东西。

## 写入路径的两道护栏

插件不满足官方「`header.cwd` 必须等于 workspace 目录」这条不变式，所以官方有两处写路径
会踩到移动过的会话，插件各加了一层护栏（`lib/guards.js`）：

1. **写前修复**：官方 `WorkspaceEntity.mutate()` 每次写都会按内存索引 `sessionPaths` 剪枝
   （不在该目录的会话会被从账本里删掉并落盘）。护栏在写之前按移动日志把索引修好，
   避免「改名/排序/删除/新建会话」这类无关操作把受管会话静默剔除。
2. **attach 接管**：官方 `attachSession()` 要求 `header.cwd` 等于目标项目目录，否则抛错。
   分叉出来的子会话 header 写的是父会话**原始** cwd，`forkWorkspace()` 又按账本把它挂到
   父会话所在项目——校验必然失败。护栏在失败后按账本接管：只有能证明「这个会话确实属于
   本项目」（账本指向它，或它是本项目某个会话的分叉）时才绕过校验，其余情况原样抛错。

两道护栏都只处理移动日志里记着的会话 + 本次正在移动的那一个，普通会话的官方剪枝语义不变；
插件卸载时补丁会被还原。

## 分叉跟随父会话

DSH 的「分叉会话」是「复制一段事件前缀 + 新建会话」，子会话 header 里写的是父会话
**header 里的原始 cwd**，而不是父会话当前的工作目录。对移动过的会话（账本在项目 B、
header 还停在项目 A）就会出现：子会话带着 A 的目录，宿主的成员索引（`candidateMatches`）
不认它，侧栏于是把它过滤出项目分组，Agent 也还在 A 里干活。

**0.2.1-rc.3 起普通分叉是独立 Session**：header 不再写 `parentSession`，也不写替代来源字段；
官方声明无法从持久化数据还原新普通分叉的直接父。但复制的事件前缀仍保留
`session-log-deepseek/delivery-accepted.data.sessionId`，它给出分叉链上的一个已知来源
（新分叉通常就是父）；沿继承边界之前最后一枚「外来投递标记」可追到已分组祖先。插件用三层
证据，能证明才动账本：

1. **来源链**：从 seed 继承前缀读出已知来源，按账本取它所在项目；该线索还要与「目标项目内
   存在同源受管会话」互相印证，避免把嵌套分叉的祖先标记误当直接父；
2. **attach 目标**：官方 `forkWorkspace()` 已选中父会话的项目，`attachSession()` 失败时在该
   项目内按「受管会话原始目录 = 子会话 cwd」接管；
3. **唯一原始目录候选**：仅对确实未分组、且前两束光都拿不到的子会话，按受管会话原始目录推断；
   只有指向一个项目才归位，多个项目共享原目录时保持「未分组」，由用户手动拖一次，不猜。
   官方已按 `header.cwd` 正常安置的普通分叉不会被覆盖。

插件在 `session/created` 之后（等官方 `attachSession` 走完）对齐三件事：**账本归属 → 内存索引
→ 工作目录**；并在会话被打开（`agent/created`）时再对齐一次工作目录，把更早分叉出来、当时
没机会对齐的子会话也治好。判定只看 header 与 seed 里的稳定事实（`isSeeded` / `parentSession` /
`origin` / 继承投递标记），父会话未分组、目标项目被删、Agent 还没起来时都只是跳过，绝不影响
分叉本身。

子会话同样会写进移动日志（`kind: "fork"`），所以写前修复与自检都覆盖它。修复前已经掉到
「未分组」的历史分叉，启动补登记（`lib/backfill.js`）会用 `sessionQuery.listSessions()` +
`readSession()` 追回项目；冷读失败、服务缺席或来源歧义时保持原状，最多少补几条，不影响已有分组。

## 兼容性

插件对 `WorkspaceRegistry` 的内部结构做运行时探测（`lib/core.js` 的 `resolveRegistryParts`）。
结构不符时「移动」会失败并给出说明，不会写坏任何数据；侧栏本身永远不受影响。

读取侧的接管同样全部按「失败就降级」处理：`typert` 缺失、`workspaceFileScope` 没被注册、
或已被别的组合配置过，插件都只在日志里说明原因，文件树退回按会话 header 解析目录——与没有
读取侧覆盖时完全一致，不影响移动。

护栏同理：实体原型上拿不到 `mutate` / `attachSession` 时只记日志，官方行为保持原样。

工作目录同步也按「宿主有没有这个服务」决定：旧宿主（如 0.2.0-rc.2）没有
`workingDirectory` 服务时，插件只改归属、不写 `working-directory/change` 事件——
那个版本不注册该事件类型，写进去会让日志变成「未知事件」，之后 fork / 读取都会拒绝解析。

历史分叉来源歧义的完整口径：多个项目都从同一个原目录移入过会话，且分叉日志没有可追的
继承投递标记时，持久化数据不足以还原来源；这类历史分叉保持「未分组」，手动拖到目标项目
一次即可。新分叉由宿主选中的 attach 目标精确归位，不受此限制。继承投递标记不是完整血缘：
官方不保证它等于直接父；插件只把它用于「项目归属」判断，并要求目标项目内同源受管会话佐证，
绝不据此重建父子关系或改会话 header。

## 测试

```bash
node test/core-test.mjs     # 归属账本：移动、幂等、锚点、启动重放、归属投影
node test/scroll-test.mjs   # 边缘自动滚动：触发带与速度曲线
node test/view-test.mjs     # 读取侧视图：账本优先、默认回退、各类降级
node test/client-test.mjs   # 客户端半：快照 cwd 改写、行/快照复用、新会话重取
node test/fork-test.mjs     # 分叉跟随：账本/索引/工作目录对齐与全部降级分支
node test/fork-origin-test.mjs # 独立分叉：seed 来源链、attach 目标、唯一目录候选
node test/backfill-test.mjs # 启动补登记：历史未分组分叉归位与歧义跳过
node test/guard-test.mjs    # 护栏：写前修复、attach 接管、日志存取
node test/managed-test.mjs  # 自检与日志清理：清单、陈旧条目跳过/清理
node test/workdir-test.mjs  # 工作目录：Agent/会话/旧宿主三条路径
```
