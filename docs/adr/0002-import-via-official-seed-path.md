# ADR-0002：第三方导入走官方 seed 路径，转换器只产出事件流

- 状态：accepted
- 日期：2026-08-30
- 环境事实：DSH 0.1.0-rc.7，`SESSION_FORMAT_VERSION = 0`（preview 无迁移保证）

## 背景

需求要求把 Claude Code / Codex 本地 JSONL **全保真转换**为可被 DSH 续聊的原生会话。DSH 会话是事件溯源日志：header + 只追加事件流，物理层为 zstd 压缩 JSONL（还可能含 chunk 打包、撕裂尾部修复等写路径细节）。

## 决策

1. **写盘只走官方 seed 路径**：转换器把第三方转录映射为 DSH `SessionEvent[]` 与 header 元数据，然后通过 `ctx.sessions` 官方构造链（seed → flush → 持久化监听器落盘）产出标准日志。**绝不**由插件手写 `session.jsonl.zstd`、绝不绕过 `sessionPersistence`。
2. **全保真映射**：文本 → `user/message` / `assistant/message`；thinking/reasoning → 推理块事件；工具调用/结果 → `tool/call` / `tool/result`。源工具名在 DSH 工具面不存在时，以只读文本卡片呈现该调用与结果——不丢信息、不伪造可执行工具。
3. **元数据**：`createdAt`、`cwd` 取原会话值；不写 `agentPreset`（续聊采用宿主当前默认预设组合）。新 DSH id 由插件铸造，`(source, sourceSessionId) → dshSessionId` 入 import manifest（自有 storageDomain unit）。
4. **排除规则**：Claude 跳过 `agent-*` 子代理会话；Codex 跳过 `session_meta.payload.source.subagent`；跳过无真实用户消息的空会话。

## 备选方案

- **直接生成 DSH 磁盘文件**：必须精确复刻 rc.7 的 zstd 帧布局、chunk 打包与 header 编码，`SESSION_FORMAT_VERSION = 0` 明示无兼容承诺，任何升级即破损。否决。
- **只读归档导入**：无法续聊，与需求方选择的"原生转换，导入后可直接续聊"冲突。否决。
- **伪造不存在的工具事件**：续聊时模型可能再次调用一个实际不存在的工具，产生错误幻觉。否决。

## 后果

- 正面：导入产物与原生会话完全同构，官方列表/搜索/历史/续聊/导出全部免费生效；格式升级由官方加载器吸收。
- 负面：转换器需精确构造 surface 事件（`surfaceOp`、seq 连续性、turn/step 边界），工作量集中在映射正确性；用本机真实 Claude/Codex 文件建回归夹具对冲。
