# 会话管理插件 v0.1 需求对齐书（PRD）

- 状态：已与需求方逐轮对齐（grilling 三轮），可直接进入实现排期
- 目标环境：DeepSeek Harness **0.1.0-rc.7**（preview），web profile 为主、headless 兼容
- 对齐基准：CC Switch 的 Sessions 页（跨来源浏览/搜索/恢复）+ Codex 的归档/删除语义
- 关联术语表：`CONTEXT.md`；关联决策：`docs/adr/0001`～`0003`

---

## 1. 问题与目标

DSH preview 的会话管理不完整：归档了就无法取消归档（没有 unarchive 入口）、没有删除、没有第三方会话导入、没有统计与批量清理。用户需要在 **DSH 设置页**里拥有一个 CC Switch Sessions 风格的统一会话管理面：

1. **导入**：把 Claude Code、Codex 的本地历史会话转成 DSH 原生会话，导入后可在 DSH 里直接续聊；
2. **管理**：统一列表 / 内容级搜索 / 预览 / 打开续聊 / 归档与取消归档 / 删除 / 批量清理 / 统计。

## 2. 不可变安全底线（任何实现不得违反）

| # | 底线 |
|---|---|
| I1 | **第三方源文件永远只读**：`~/.claude/projects/**` 与 `~/.codex/sessions/**`、`~/.codex/archived_sessions/**` 只被扫描与解析，插件绝不修改、移动、删除其中任何文件。删除/清理只作用于 DSH 侧（原生会话 + 已导入的 DSH 副本）。 |
| I2 | **运行中的会话一律拒删**：`ctx.sessions.get(id)` 命中即拒绝删除/清理；归档不受此限（官方语义允许）。 |
| I3 | **删除是显式不可逆操作**：单删弹窗展示标题/大小/不可逆文案；批量删除必须键入 `DELETE` 并显示数量。 |
| I4 | **清理永远先预览后执行**：规则命中后只生成预览清单，用户确认前不产生任何副作用。 |
| I5 | **不重复造 DSH 已内置的轮子**：列表基础数据、标题、历史预览、归档（写入方向）、重命名、fork、导出均复用官方能力；插件只补缺口。 |
| I6 | **对 rc.7 私有通道带版本守卫**：凡走运行时内部通道（取消归档、删除后的登记清理），必须校验服务形状/版本，不匹配时响亮失败，绝不静默写坏状态。 |

## 3. 术语（详见 CONTEXT.md）

| 术语 | 定义 |
|---|---|
| 原生会话 | DSH 自身产生、写入 `~/.dsh/sessions/` 的事件溯源会话。 |
| 导入会话 | 由第三方转录转换生成、走官方 seed 路径写入同一存储的 DSH 会话；来源由插件 manifest 记录。 |
| 来源（Source） | `dsh` / `claude-code` / `codex`，会话列表的来源标签。 |
| 归档 / 取消归档 | DSH 官方 `workspaceRegistry.archivedSessionIds` 集合的加入/移出；日志与工作区登记均保留。 |
| 删除 | 永久删除 DSH 侧会话日志并同步清理归档集/工作区登记，不可逆。 |
| 清理 | 按规则（时间/大小/空会话/归档态/来源）预览后批量删除，只作用 DSH 侧。 |
| 打开 / 续聊 | 以 `session.create { sessionId, cwd }` 触发宿主 `ctx.agents.resume`，在 Web 内挂起冷会话继续对话。 |
| 保真映射 | 全保真导入转换：文本、thinking、工具调用与结果全部保留；DSH 中不存在的工具降级为文本卡片，不丢信息、不伪造可执行工具。 |
| 导入清单 / 去重键 | 扫描来源得到「未导入」清单；去重键 = `(source, sourceSessionId)`，已存在即跳过。 |

## 4. rc.7 现状盘点（实测，非推测）

### 4.1 DSH 已内置、插件直接复用

| 能力 | 官方入口 |
|---|---|
| 会话列表基础数据 | `session.list`（`SessionSummary`：updatedAt/running/blank/lineage/cwd/agentPreset/title 投影） |
| 历史预览 | `session.history`（分页、投影基线、只读不 attach） |
| 标题与重命名 | `session.title` 投影 + `session.rename`（追加 `session/title` 事件） |
| 归档（写入方向） | `workspace.archiveSession` RPC / `ctx.workspaceRegistry.archiveSession()`，持久化于 `~/.dsh/storages/workspace.json` |
| fork、日志导出、模型选择 | `session.fork`、`dsh-session-log-export`、`session.selectModel` 等 |
| Web 内续聊冷会话 | `session.create { sessionId: <已有id>, cwd: <原目录> }` → `ensureSession` 检测持久化命中 → `ctx.agents.resume`（官方路径，已读源码确认） |
| 查询服务 | `ctx.sessionQuery`：`listSessions/filterSessions/searchSessions/readSession/readTitle/listEvents` |

### 4.2 rc.7 缺失、插件负责补

| 能力 | 方案 |
|---|---|
| 取消归档 | 无官方 API/RPC。走 `workspaceRegistry` 运行时内部通道（含版本守卫，见 ADR-0001）；插件视图即时更新，内置侧栏归档态在页面刷新后收敛。 |
| 删除 | 无官方 API。按 `sessionPersistence.locate(meta).path` 删除会话目录，并同步清理归档集与工作区登记（内部通道，同守卫）。 |
| 第三方导入 | 无。全保真转换 + 官方 seed 路径写标准日志（ADR-0002）。 |
| 内容级全文搜索 | 默认关闭（`session-query-sqlite openAt: never`）。插件 bundle patch 覆盖为 `openAt: first-search` + 持久化索引路径。 |
| 统计 / 批量清理 / 统一设置页 / Agent 工具 | 全新实现。 |

## 5. 功能规格

### 5.1 设置页「会话管理」

在 DSH 设置页注册一个 `settings.section` 分区（id `session-management`），含三个页签。

#### 页签 A：会话

- **统一列表**：DSH 原生 + 已导入会话同列，来源标签（DSH / Claude Code / Codex，由 manifest 反查）；每行显示：标题、来源、最后活跃时间、日志大小、消息条数、运行中标记、归档标记。
- **筛选与排序**：按来源 / 归档状态 / 工作区过滤；默认最近活跃降序。
- **全文搜索**：内容级（用户/助手/工具消息正文），与筛选叠加；依赖 5.6 的全文搜索开关。
- **预览**：点击行展开历史记录（复用官方 `session.history` 数据或直接展示本插件拉取的日志，避免与内置侧栏冲突）。
- **打开/续聊**：对冷会话调用 `session.create { sessionId, cwd: header.cwd }` 官方续聊路径；运行中会话直接切换到该会话。header 无 cwd 或目录不可解析时禁用并给出原因。
- **归档 / 取消归档**：归档走官方 `workspace.archiveSession`；取消归档走 ADR-0001 内部通道。
- **删除**：遵守 I2/I3；删除后同步清理归档集与工作区登记（内部通道，同守卫）。
- 已归档会话在本页签内可见（内置侧栏隐藏它们，这正是本页签的存在价值之一）。

#### 页签 B：导入

- **扫描源**（v1）：
  - Claude Code CLI：`~/.claude/projects/<编码cwd>/*.jsonl`；
  - Codex CLI：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `~/.codex/archived_sessions/*.jsonl`。
- **排除规则**（照抄 CC Switch 已验证经验）：Claude 跳过 `agent-*` 子代理会话；Codex 跳过 `session_meta.payload.source.subagent` 会话；跳过没有任何真实用户消息的空会话。
- **标题规则**：
  - Claude：`custom-title` 记录 > 首条非 meta 用户消息（剔除 `<local-command-caveat>` 与 `/` 斜杠命令）> 项目目录名；
  - Codex：`~/.codex/session_index.jsonl` 与 `codex-dev.db threads.title`（仅当与首条用户消息不同）> 首条用户消息（剔除 IDE context 注入）> 项目目录名。
- **交互**：自动扫描 → 展示「未导入」清单（标题/来源/时间/大小/路径）→ 全选/勾选 → 一键导入；重复（`(source, sourceSessionId)` 已在 manifest 中）自动跳过；导入完成展示报告：成功 / 跳过（已存在）/ 失败（原因，可点开明细）。
- **转换策略（全保真）**：
  - 文本消息 → `user/message` / `assistant/message`；
  - thinking/reasoning → 推理块事件；
  - 工具调用/结果 → `tool/call` / `tool/result`；工具名在 DSH 不存在时，把该调用+结果作为只读文本卡片呈现（不伪造可执行工具）。
- **写入路径**：通过 `ctx.sessions` 官方 seed 路径构造会话并 flush，产物是标准 `~/.dsh/sessions/<cwd>/session-<id>/session.jsonl.zstd`（详见 ADR-0002）。
- **溯源 manifest**：插件在 `storageDomain` 自建 domain（unit `session-management` v1），保存 `source → sourceSessionId → dshSessionId` 双向索引与导入时间；用于来源标签、去重与报告。
- **元数据**：`createdAt`/`cwd` 取原会话值；不写 `agentPreset`（续聊时采用宿主当前默认预设组合）。

#### 页签 C：清理与统计

- **统计**：全局汇总（会话总数、总日志大小、按来源分布）+ 每会话指标：日志大小、消息条数、会话时长、工具调用次数（含成功/无结果）。会话页行内展示前三项。
- **批量清理规则**（可组合）：
  - 最后活跃时间早于 N 天（N 可配，默认 30）；
  - 日志大小大于 N MB（N 可配，默认 100）；
  - DSH 空会话（无 `turn/start`）；
  - 限定归档态开关（默认开启：只扫已归档）；
  - 按来源筛选（默认全部 DSH 侧来源）。
- **执行**：规则命中 → 预览清单（标题/大小/时间/来源，可逐项取消勾选）→ 确认（批量输入 `DELETE`）→ 执行 → 结果报告（成功/失败数）。
- **作用域（I1）**：只清 DSH 侧；永不触碰第三方源文件。

### 5.2 Agent 工具（headless 与对话内管理）

注册完整工具集，与 UI 共用同一套 host 层逻辑：

| 工具 | 类别 | 审批策略 |
|---|---|---|
| `list_sessions` / `search_sessions` / `preview_session` | 只读 | 无需审批 |
| `import_sessions` | 写（DSH 侧新增，不动源文件） | 参数显式列出目标会话，执行结果回报 |
| `archive_session` / `unarchive_session` | 写 | 可直接执行（可逆） |
| `delete_sessions` / `cleanup_sessions` | 危险写 | 必须过 `user-approval`（ask），展示目标与不可逆文案 |

### 5.3 插件配置（Schemastery）

所有可调参数进 Config，改配置热替换插件：

| 字段 | 默认 |
|---|---|
| `claudePath` | `~/.claude/projects`（空 = 自动探测） |
| `codexPath` | `~/.codex`（空 = 自动探测） |
| `fullTextSearch` | `first-search`（`never` 可关） |
| `cleanup.olderThanDays` | `30` |
| `cleanup.largerThanMb` | `100` |
| `cleanup.archivedOnly` | `true` |
| `deleteAllowLive` | `false`（硬编码 false，不暴露） |

### 5.4 全文搜索的 bundle patch

本插件的 `cordis.patch.yml` 增加一层覆盖（后层整值覆盖，需重述全部键）：

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: !!js dshHomePath('storages/session-query.sqlite')
    openAt: first-search
```

## 6. 非目标（v1 不做，进 backlog）

- ChatGPT 云线程导入（正文在云端，本机只有 sqlite 元数据；待官方导出/API 后再开）。
- 重命名（官方已有 `session.rename`）、置顶、导出、fork（官方已有）。
- 删除/清理连带删除第三方源文件（违反 I1，永不支持）。
- Codex Desktop/VSCode 的目录树/工程视图整合；只按 rollout 文件扫描。
- 强制重复导入生成副本。

## 7. 验收标准（v0.1 完成定义）

1. 设置页出现「会话管理」分区与三个页签，中英文文案完整。
2. 会话页签能看到原生 + 已导入会话统一列表，来源标签正确，筛选/排序/内容级全文搜索可用。
3. 归档（官方路径）与取消归档（内部通道+守卫）均可操作；取消归档后本插件视图立即更新，刷新后内置侧栏收敛。
4. 从 Claude Code 与 Codex 各导入至少一个真实会话（用本机真实文件做夹具）：标题规则正确、subagent/空会话被跳过、重复导入自动跳过、报告准确。
5. 导入会话可在 Web 内直接打开续聊（`session.create` 官方路径），历史完整可见；不存在的第三方工具以文本卡片呈现。
6. 删除与清理遵循全部安全底线：运行中会话拒删、批量必须键入 `DELETE`、清理先预览、第三方源文件零改动。
7. 统计指标（大小/消息数/时长/工具调用）与清理规则（时间/大小/空会话/归档态）按配置工作。
8. Agent 工具在 headless 下可用；危险工具过审批。
9. `npm run build` 产物可安装；卸载插件后不残留路由/工具/监听；重装后 manifest 可恢复来源标签。
10. 升级守卫：对 rc.7 内部通道形状做断言，官方补齐 API 后切换到官方实现（ADR-0001 的回退路径）。

## 8. 风险与回退

| 风险 | 缓解 |
|---|---|
| rc.7 内部通道随版本变化 | 版本/形状守卫 + 响亮失败；官方补 unarchive/delete API 后立即切换（ADR-0001）。 |
| `SESSION_FORMAT_VERSION = 0` 无迁移保证 | 导入只走官方 seed 路径写日志，不手写格式；DSH 升级后若格式变更，以官方加载器为准，转换器只需产出事件流。 |
| 导入转换器的方言差异（Claude/Codex 版本演进） | 解析器按行容错（坏行跳过并计数进报告）；用本机真实文件建回归夹具。 |
| 全文索引体积与首次延迟 | `first-search` 按需建索引；提供配置关闭回退标题搜索。 |
| 删除与 query/projection 缓存残留 | 删除后触发对账/刷新路径；列表以 `sessionPersistence.list()` 为准，残留投影行只读不展示。 |
