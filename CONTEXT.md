# CONTEXT.md — dsh-session-management 领域语境

本文件是仓库的**单一语境入口**：术语表 + 已拍板决策索引。所有 issue 标题、提交信息、测试名、代码命名使用这里的词汇；不在表中的新概念先回 `/domain-modeling` 对齐，不要自行发明同义词。

## 产品定位

`@dsh-external/dsh-session-management`：为 DeepSeek Harness（preview，0.1.0-rc.7）补全会话管理缺口——在 **DSH 设置页**提供 CC Switch Sessions 风格的统一会话管理（跨来源列表/搜索/预览/打开续聊/归档/取消归档/删除/清理/统计），并把 Claude Code、Codex 的本地历史会话**全保真转换**为可续聊的 DSH 原生会话。

## 术语表（ubiquitous language）

| 术语 | 定义 | 禁用同义词 |
|---|---|---|
| **会话（Session）** | DSH 事件溯源会话：不可变 header + 只追加事件流，落盘为 `~/.dsh/sessions/<cwd>/session-<id>/session.jsonl.zstd`。 | 对话、线程（thread 只指第三方源里的线程 id）、chat |
| **原生会话（native session）** | 由 DSH 自身产生并持久化的会话。 | 本地会话、DSH 会话（表述来源时才用） |
| **导入会话（imported session）** | 由第三方转录经全保真映射、走官方 seed 路径写入同一存储的 DSH 会话；来源经 manifest 溯源。 | 转换会话、迁移会话 |
| **来源（source）** | 会话的出处，v1 取值：`dsh` / `claude-code` / `codex`。 | provider（保留给模型供应商）、origin（官方 header 字段，指 subagent） |
| **归档（archive）** | 把会话 id 加入 DSH 官方 `workspaceRegistry.archivedSessionIds`；日志与工作区登记保留，内置分组界面隐藏。 | 隐藏、移出 |
| **取消归档（unarchive）** | 把会话 id 移出归档集合（rc.7 无官方 API，插件走内部通道 + 版本守卫，见 ADR-0001）。 | 恢复归档、还原 |
| **删除（delete）** | 永久删除 DSH 侧会话日志并同步清理归档集/工作区登记；不可逆。 | 移除、抹除 |
| **清理（cleanup）** | 按规则（时间/大小/空会话/归档态/来源）预览后批量删除；只作用 DSH 侧。 | 清扫、批处理 |
| **打开/续聊（open / resume）** | 用官方 `session.create { sessionId, cwd }` 触发宿主 `ctx.agents.resume`，在 Web 内挂起冷会话继续对话。 | 恢复会话（避免与"恢复归档"混淆，UI 用"打开/续聊"） |
| **保真映射（fidelity mapping）** | 导入转换策略：文本、thinking、工具调用与结果全部保留；DSH 不存在的工具降级为只读文本卡片，不伪造可执行工具。 | 无损转换（实际有降级，禁用"无损"） |
| **导入清单（import queue）** | 扫描源后「未导入」会话集合，支持勾选/全选/一键导入。 | 候选列表 |
| **去重键（dedupe key）** | `(source, sourceSessionId)`；命中 manifest 即视为已导入并跳过。 | 唯一键 |
| **源文件（source file）** | `~/.claude/projects/**` 与 `~/.codex/{sessions,archived_sessions}/**` 下的第三方 JSONL；**永远只读**（安全底线 I1）。 | 原文、外部日志 |
| **import manifest** | 插件自有 storageDomain unit（`session-management` v1）：`source + sourceSessionId ⇄ dshSessionId` 双向索引与导入时间。 | 映射表、溯源表 |

## 安全底线（不可变）

1. 第三方源文件永远只读（I1）。
2. 运行中的会话一律拒删（I2）。
3. 删除是显式不可逆操作，批量必须键入 `DELETE`（I3）。
4. 清理永远先预览后执行（I4）。
5. 复用官方能力，不重复造轮子（I5）。
6. rc.7 私有通道必须带版本守卫，不匹配时响亮失败（I6）。

完整规格见 [`docs/requirements.md`](docs/requirements.md)。

## 决策记录

| ADR | 决策 | 一句话 |
|---|---|---|
| [0001](docs/adr/0001-unarchive-internal-channel.md) | 取消归档走运行时内部通道 | rc.7 无官方 unarchive；内部通道 + 版本守卫，官方 API 出现后回退切换。 |
| [0002](docs/adr/0002-import-via-official-seed-path.md) | 导入走官方 seed 路径 | 转换器只产出事件流，写盘交给官方 session/持久化链路，绝不手写日志格式。 |
| [0003](docs/adr/0003-source-files-read-only.md) | 第三方源文件只读 | 删除/清理只作用 DSH 侧，源文件永不修改。 |

## 关键外部事实（rc.7 实测）

- 官方查询：`ctx.sessionQuery`（list/filter/search/read/trace）；官方持久化：`ctx.sessionPersistence`（append-only，`locate()` 给路径，无 delete）。
- 官方归档：`ctx.workspaceRegistry.archiveSession()` / RPC `workspace.archiveSession`；无 unarchive。
- 官方续聊：RPC `session.create` 携带已存在 sessionId 时走 `ctx.agents.resume`。
- 全文搜索默认关：`session-query-sqlite openAt: never`；插件覆盖为 `first-search`。
- Claude Code 2.1.x JSONL：`user/assistant` 消息含 `tool_use`/`tool_result`、`custom-title`、`file-history-snapshot`、`agent-*` 子代理文件。
- Codex rollout JSONL：`session_meta` / `response_item`（message/function_call/function_call_output/reasoning 等）；标题在 `session_index.jsonl` 与 `codex-dev.db threads`。
- ChatGPT 云线程：本机只有 sqlite 元数据（`source_kind=chatgpt`），正文在云端，v1 不导入。
