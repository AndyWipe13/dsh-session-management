# ADR-0001：取消归档走 workspaceRegistry 运行时内部通道（带版本守卫）

- 状态：accepted
- 日期：2026-08-30
- 环境事实：DSH 0.1.0-rc.7

## 背景

DSH preview 提供官方归档能力（`ctx.workspaceRegistry.archiveSession()` / RPC `workspace.archiveSession`），持久化于 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`；归档后内置分组界面隐藏会话。但 rc.7 **没有 unarchive API/RPC**，也没有公开的归档集合写入口——归档的会话用户无法自行恢复。

## 决策

v1 取消归档通过 `ctx.workspaceRegistry` 的运行时内部通道实现：以 `enqueueOperation` 串行化，把目标 id 从 `archivedSessionIds` 中移除并 `setState` 落盘（与官方 `archiveSession` 完全对称的写路径）。

强制配套：

1. **形状守卫**：执行前断言所需方法/字段存在且行为符合预期（如 `enqueueOperation`、`requireState`、`setState`），并记录当前 DSH 版本；任一断言失败即抛错，绝不让"看起来成功"的静默错乱发生。
2. **收敛说明**：插件自身视图立即更新；内置侧栏的归档态依赖官方 `host/archived-sessions-changed` 帧（只在官方 archive 路径发出），因此页面刷新后收敛。此限制写入 UI 文案与文档。
3. **升级回退**：官方补出 unarchive API（或公开写入口）后，删除内部通道调用并切到官方实现；本 ADR 届时改为 superseded。

## 备选方案

- **等官方 API**：与需求（插件核心价值就是取消归档）冲突，否决。
- **直接改 `workspace.json` 文件**：与运行中 registry 的内存态/操作尾串行化脱节，可能覆盖并发写入，否决。
- **不提供取消归档**：违背需求方明示的"仅需覆盖取消归档"，否决。

## 后果

- 正面：功能完整，写路径与官方归档同构（同样经过 registry 的串行操作队列与 durable setState）。
- 负面：依赖 rc.7 内部形状，升级可能破裂——由守卫转为"响亮失败"而非静默损坏，符合安全底线 I6。
