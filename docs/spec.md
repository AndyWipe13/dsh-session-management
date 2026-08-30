# Spec：DSH 会话管理插件 v0.1（`@dsh-external/dsh-session-management`）

> 来源：三轮需求 grilling 结论 + rc.7 源码/本机数据实测。术语一律使用 `CONTEXT.md` 词汇表；已拍板决策见 ADR-0001～0003。

## Problem Statement

DSH preview（0.1.0-rc.7）的会话管理不完整。用户日常在 DSH Web 里工作，但：

- 会话一旦归档，官方**没有取消归档**的入口或 API，归档等于半只脚踏进坟墓；
- 官方**没有删除**会话的能力，遗留会话只能堆积在 `~/.dsh/sessions` 里；
- 用户过去在 Claude Code、Codex 里积累了大量历史会话，**无法带进 DSH 使用**——既不能统一浏览，也不能在 DSH 里续聊；
- 官方内置搜索只匹配标题/工作区名，**搜不到对话正文**；
- 没有统计与批量清理，磁盘占用不可见、不可控。

用户期望在 DSH 设置页拥有一个 CC Switch Sessions 风格的会话管理面：跨来源统一浏览/搜索/恢复 + 归档删除两级管理 + 第三方会话导入转原生。

## Solution

一个 DSH bundle 插件，在 **DSH 设置页**提供「会话管理」分区（三个页签：会话 / 导入 / 清理与统计），并同时给模型注册同名管理工具：

- **会话页**：DSH / Claude Code / Codex 统一列表（来源标签、标题、大小、消息数、运行中/归档标记），来源/状态/工作区筛选，**内容级全文搜索**，历史预览，**Web 内一键打开续聊**，归档/取消归档/删除；
- **导入页**：自动扫描 `~/.claude` 与 `~/.codex`（含 archived_sessions），列出未导入清单，勾选/全选一键导入，重复自动跳过，导入后展示成功/跳过/失败报告；导入会话走官方 seed 路径成为**可续聊的 DSH 原生会话**（全保真映射）；
- **清理与统计页**：全局汇总与每会话指标；按时间/大小/空会话/归档态/来源规则预览后批量删除；
- **Agent 工具**：同一套能力在对话里可用，危险操作过审批。

安全底线（不可变）：第三方源文件永远只读；运行中的会话一律拒删；批量删除必须键入 `DELETE`；清理永远先预览后执行；复用官方能力；对 rc.7 私有通道带版本守卫。

## User Stories

### 会话页

1. As a DSH Web 用户，I want 在设置页看到「会话管理」分区，so that 会话管理有一个稳定的入口而不是散落在对话里。
2. As a DSH Web 用户，I want 会话管理分区里有「会话 / 导入 / 清理与统计」三个页签，so that 不同任务（浏览、迁移、维护）互不干扰。
3. As a DSH Web 用户，I want 在一个列表里同时看到 DSH 原生会话和已导入的 Claude Code / Codex 会话，so that 我不必去三个应用里分别找历史。
4. As a DSH Web 用户，I want 每个会话行显示来源标签（DSH / Claude Code / Codex），so that 我能一眼区分会话出处。
5. As a DSH Web 用户，I want 每个会话行显示标题、最后活跃时间、日志大小、消息条数，so that 我不点开就能判断会话价值与体积。
6. As a DSH Web 用户，I want 运行中的会话与已归档会话都有明确标记，so that 我不会误操作正在使用的会话，也能找到被内置侧栏藏起来的归档会话。
7. As a DSH Web 用户，I want 按来源筛选会话，so that 我只看某一个 agent 的历史。
8. As a DSH Web 用户，I want 按归档状态（活跃/已归档）筛选会话，so that 清理归档存量时不被活跃会话干扰。
9. As a DSH Web 用户，I want 按工作区/项目目录分组或筛选会话，so that 我按项目而不是按时间找历史。
10. As a DSH Web 用户，I want 列表默认按最近活跃时间降序排列，so that 最新工作总在最上面。
11. As a DSH Web 用户，I want 用关键词搜索对话正文（用户/助手/工具消息），so that 我能靠"当时说了什么"找回会话，而不只是靠标题。
12. As a DSH Web 用户，I want 搜索与筛选可以叠加使用，so that 我在某个项目、某个来源、归档态里做内容检索。
13. As a DSH Web 用户，I want 搜索按需建索引（首次搜索时才付出索引成本），so that 平时启动和运行不被全文索引拖慢。
14. As a DSH Web 用户，I want 在设置里能把全文搜索关掉回退到标题搜索，so that 我不需要索引时可以省磁盘。
15. As a DSH Web 用户，I want 点开会话行看到历史记录预览，so that 确认内容后再决定归档还是删除。
16. As a DSH Web 用户，I want 对任意冷会话点「打开/续聊」后直接在 Web 里挂起该会话继续对话，so that 续聊不需要离开界面去敲 CLI 命令。
17. As a DSH Web 用户，I want 对运行中的会话点「打开」直接切换到该会话，so that 一个入口兼容两种状态。
18. As a DSH Web 用户，I want header 没有 cwd 或目录不可解析的会话在续聊按钮上给出禁用原因，so that 我不会对着一个点不动的按钮猜。
19. As a DSH Web 用户，I want 对活跃会话点归档后它从内置分组界面消失但保留在「已归档」筛选里，so that 归档语义与官方一致且可逆。
20. As a DSH Web 用户，I want 对已归档会话点「取消归档」后它回到活跃列表并恢复原工作区位置，so that 误归档可以无损撤销。
21. As a DSH Web 用户，I want 取消归档后插件列表立即反映变化，并在页面刷新后内置侧栏也收敛，so that 我知道界面更新存在明确的收敛时机而不是坏了。
22. As a DSH Web 用户，I want 删除单个会话前看到标题、大小和"不可恢复"文案的确认弹窗，so that 我不会手滑删错。
23. As a DSH Web 用户，I want 批量删除时勾选多个会话、显示总数量并要求键入 `DELETE` 才执行，so that 大批量误操作被一道强闸挡住。
24. As a DSH Web 用户，I want 删除后会话从所有列表消失且不再占用磁盘，so that 删除是真实删除而不是界面上的假动作。
25. As a DSH Web 用户，I want 尝试删除运行中的会话时得到明确拒绝和原因，so that 我理解为什么这个按钮不可用。
26. As a DSH Web 用户，I want 删除已归档会话时归档登记一并被清理，so that 归档集合里不会残留指向已删会话的僵尸 id。
27. As a DSH Web 用户，I want 中文与英文界面文案完整，so that 语言切换后管理页可读可用。

### 导入页

28. As a DSH Web 用户，I want 打开导入页时自动扫描 Claude Code 与 Codex 的默认目录，so that 我不需要知道 JSONL 藏在哪。
29. As a DSH Web 用户，I want 扫描结果只展示「未导入」的第三方会话，so that 已导入的历史不会反复出现在清单里。
30. As a DSH Web 用户，I want 清单里每个候选会话显示来源、标题、时间、大小与源路径，so that 我能判断哪些值得导入。
31. As a DSH Web 用户，I want 勾选任意候选、支持全选/取消全选，so that 批量导入与挑重点导入都顺手。
32. As a DSH Web 用户，I want 一键导入所选会话并看到进行状态，so that 大批量迁移不需要逐条点。
33. As a DSH Web 用户，I want 同一来源同一会话 id 已导入过时自动跳过，so that 重复导入不会产生重复会话。
34. As a DSH Web 用户，I want 导入完成看到报告（成功/跳过/失败及逐条原因），so that 每个结果都可追溯。
35. As a DSH Web 用户，I want 解析到坏行时跳过坏行并在报告中计数而不是整个会话失败，so that 少量脏数据不毁掉整次迁移。
36. As a DSH Web 用户，I want 导入后的会话立刻出现在「会话」页且来源标签正确，so that 迁移结果即时可见。
37. As a DSH Web 用户，I want 导入后的会话能在 Web 里直接打开续聊，so that 「导入到 DSH 使用」的承诺闭环。
38. As a DSH Web 用户，I want 导入过程绝不修改、移动或删除 Claude Code / Codex 的源文件，so that 原应用的会话列表与恢复能力不受影响。
39. As a DSH Web 用户，I want 导入的会话保留原会话的创建时间与项目目录，so that 时间线和工作区归属不失真。
40. As a DSH Web 用户，I want Claude Code 的自定义标题优先于首条用户消息，so that 我手动改过的标题在 DSH 里延续。
41. As a DSH Web 用户，I want Codex 线程标题（session_index / threads 表）优先于首条用户消息，so that 标题与 Codex 自己的列表一致。
42. As a DSH Web 用户，I want Claude Code 的子代理会话与 Codex subagent 会话被跳过，so that 清单里只出现真正的主会话。
43. As a DSH Web 用户，I want 没有任何真实用户消息的空会话被跳过，so that 不导入没有价值的空壳。
44. As a DSH Web 用户，I want 导入保留对话文本、thinking 与工具调用/结果的完整来龙去脉，so that 续聊时模型知道当时做过什么。
45. As a DSH Web 用户，I want 第三方工具在 DSH 中不存在时以只读文本卡片呈现调用与结果，so that 信息不丢、模型也不会去调用一个不存在的工具。
46. As a DSH Web 用户，I want 卸载插件后重新安装，来源标签与去重记录仍能恢复，so that 重装不会导致重复导入或来源失忆。
47. As a DSH Web 用户，I want 导入来源目录可在配置里自定义，so that 非默认安装位置也能导入。

### 清理与统计页

48. As a DSH Web 用户，I want 看到全局统计（会话总数、总日志大小、按来源分布），so that 磁盘占用和来源构成一目了然。
49. As a DSH Web 用户，I want 看到每个会话的日志大小、消息条数、会话时长与工具调用统计，so that 我能按"值不值得留"做决定。
50. As a DSH Web 用户，I want 按「最后活跃早于 N 天」生成清理候选，so that 陈年会话批量出清。
51. As a DSH Web 用户，I want 按「日志大于 N MB」生成清理候选，so that 大头会话优先处理。
52. As a DSH Web 用户，I want 按「空会话（无 turn/start）」生成清理候选，so that 点开就退出的空壳被清掉。
53. As a DSH Web 用户，I want 把清理候选限定在已归档会话，so that 活跃会话默认不会被批量清理误伤。
54. As a DSH Web 用户，I want 按来源限定清理范围，so that 我可以说"只清导入的 Codex 副本、不动原生会话"。
55. As a DSH Web 用户，I want 规则组合后先看到预览清单并逐项取消勾选，so that 规则误伤在预览阶段被拦住。
56. As a DSH Web 用户，I want 执行批量清理前键入 `DELETE` 确认，so that 批量不可逆操作有强确认。
57. As a DSH Web 用户，I want 清理完成后看到成功/失败报告，so that 结果可核对。
58. As a DSH Web 用户，I want 清理只作用于 DSH 侧会话、绝不触碰第三方源文件，so that Claude Code / Codex 的原始历史安然无恙。
59. As a DSH Web 用户，I want 清理同样拒绝运行中的会话，so that 活跃工作不会被规则扫掉。
60. As a headless DSH 用户，I want 通过对话让模型执行同样的列表/搜索/导入/归档/删除/清理/统计，so that 没有 Web UI 的 profile 也能管理会话。
61. As a DSH 对话用户，I want 模型执行删除与清理前必须经过我的批准，so that 模型不能擅自销毁历史。
62. As a DSH 用户，I want 所有可调参数（扫描路径、全文搜索开关、清理默认阈值）在插件配置里可改，so that 不改代码就能适配我的机器。

### 可靠性

63. As a DSH 用户，I want 插件在 rc.7 私有通道形状不匹配时响亮失败而不是静默写坏状态，so that 升级破坏是可诊断的。
64. As a DSH 用户，I want 插件卸载后不残留工具、监听与路由，so that 热重载与移除是干净的。
65. As a DSH 用户，I want 大会话（GB 级）导入与预览不把进程内存打爆，so that 真实历史都能处理。
66. As a DSH 用户，I want 中文与 Unicode 内容在导入、搜索、预览中原样保留，so that 中文工作历史不出现乱码或漏字。

## Implementation Decisions

1. **单一测试接缝**：所有操作收敛到一个 host 侧 `SessionManagement` 服务，方法为纯输入→纯输出（`list / search / preview / import / archive / unarchive / delete / cleanupPreview / cleanupExecute / stats`）。设置页 UI 与 Agent 工具只是它的薄适配层，不承载业务逻辑。
2. **复用官方读路径**：列表、标题、历史、搜索全部基于 `ctx.sessionQuery`（list/filter/search/read/title）与官方 `session.history` 语义；不自建第二份会话索引。
3. **归档写入复用官方**：归档调用 `ctx.workspaceRegistry.archiveSession()`（官方 RPC 同路径）。
4. **取消归档走内部通道（ADR-0001）**：通过 workspaceRegistry 运行时内部通道做对称的集合移除；执行前做形状/版本守卫，失败即抛错。插件自身视图立即更新；内置侧栏在刷新后收敛，UI 文案写明该收敛时机。
5. **删除走定位删除 + 对账**：以 `sessionPersistence.locate(header)` 定位并删除 DSH 侧产物；拒绝 `ctx.sessions` 中命中的运行中会话；随后同步清理归档集与工作区登记（同内部通道与守卫）。查询/投影缓存通过对账刷新收敛，不直接写它们的内部文件。
6. **导入走官方 seed 路径（ADR-0002）**：解析器把 Claude/Codex 转录映射为 DSH 会话事件流与 header 元数据，经 `ctx.sessions` 官方构造链落盘；插件绝不手写 `session.jsonl.zstd`。导入产物与原生会话同构，官方列表/搜索/续聊/导出全部免费生效。
7. **全保真映射规则**：文本→user/assistant 消息事件；thinking/reasoning→推理块；工具调用/结果→tool 事件；DSH 工具面不存在的工具→只读文本卡片（不伪造可执行工具）。
8. **标题规则（照抄 CC Switch 已验证策略）**：Claude 取 `custom-title` > 首条真实用户消息（剔除命令注入与 slash 命令）> 项目目录名；Codex 取 `session_index.jsonl` 与 `codex-dev.db threads` 标题（仅当与首条用户消息不同）> 首条真实用户消息（剔除 IDE 上下文注入）> 项目目录名。
9. **扫描与排除规则**：扫描 Claude Code 项目目录与 Codex `sessions/` + `archived_sessions/`；Claude 跳过 `agent-*` 子代理文件，Codex 跳过 `source.subagent` 会话，两边都跳过无真实用户消息的空会话；坏行跳过并计数进报告。
10. **去重与溯源（manifest）**：插件在 storageDomain 自建 unit（`session-management` v1），保存 `(source, sourceSessionId) ⇄ dshSessionId` 双向索引与导入时间。列表来源标签、去重、重装恢复全部读它。v1 不支持强制重复导入。
11. **导入 header 元数据**：`createdAt` 与 `cwd` 取原值；不写 `agentPreset`，续聊采用宿主当前默认预设组合。
12. **续聊（Web 内打开）走官方路径**：对冷会话以官方 `session.create { sessionId, cwd: header.cwd }` 触发宿主 `ctx.agents.resume`；对运行中会话直接切换；cwd 缺失/不可解析时禁用并说明。
13. **全文搜索配置**：bundle patch 覆盖官方 `session-query-sqlite` 配置为 `openAt: first-search` + 持久化索引路径；配置项可回退 `never`。
14. **安全底线在服务面硬拒绝**：源文件只读、运行中拒删、批量删除需 `DELETE` 令牌、清理先预览后执行——全部实现为服务方法的硬校验，UI 与工具无法绕过。
15. **清理规则**：`olderThanDays`（默认 30）、`largerThanMb`（默认 100）、空会话开关、`archivedOnly`（默认 true）、按来源过滤；规则组合后生成预览清单，执行时要求 `DELETE` 确认令牌。
16. **统计指标**：日志大小、消息条数、会话时长、工具调用次数（含成功/无结果）；全局按来源聚合。token 与模型信息不在 v1。
17. **Agent 工具与审批**：注册完整工具集并共用服务面；`delete`/`cleanup` 危险工具挂官方审批（ask），`import` 要求显式目标列表，`archive`/`unarchive` 可直接执行。
18. **配置（Schemastery）**：扫描路径、全文搜索开关、清理默认阈值全部可配；改配置走官方热替换。
19. **i18n**：设置页与工具文案中英双语，语言随 DSH locale。

## Testing Decisions

- **好测试的标准**：只断言外部行为——服务方法的输出、对注入依赖的可观察调用、以及对安全底线的拒绝；不测内部实现细节（文件路径布局、内部函数名、索引物理格式）。
- **单一接缝测试**：以 `SessionManagement` 服务为唯一测试面，装配 fake 的 `sessions` / `sessionQuery` / `sessionPersistence` / `workspaceRegistry` / `storageDomain` 驱动所有方法；解析器与转换器不单独暴露测试面，其行为通过 import 的产物断言（事件流内容、跳过/失败报告、去重结果）覆盖。
- **适配层薄测**：UI 与工具只测"以预期参数调用服务、正确渲染结果/错误"，业务行为不重复测。
- **安全底线专项**：删除/清理/导入路径分别包含负向用例——运行中会话拒删、无 `DELETE` 令牌拒绝执行、清理未预览不可执行、源文件路径出现在删除目标时直接抛错。
- **回归夹具**：使用本机真实 Claude Code、Codex、DSH 会话文件（脱敏后入仓）作为只读夹具；夹具源文件在测试前后做字节与 mtime 断言（ADR-0003 护栏）。
- **内部通道守卫测试**：fake 的 workspaceRegistry 提供正确形状与损坏形状各一组，断言后者响亮失败且不产生副作用。
- **prior art**：本仓库尚无测试套件；参照 cc-switch `session_manager/providers` 的表驱动解析夹具风格（我们已经读过其实现与测试），以及 DSH 官方 session 系包的契约测试风格（纯函数 + 边界用例）。
- **不做**：不测 zstd/官方持久化内部行为（官方职责）、不做浏览器端到端自动化（v1 以手工验收覆盖，验收标准见 PRD 第 7 节）。

## Out of Scope

- ChatGPT 云线程导入（正文在云端，本机只有 sqlite 元数据；待官方导出/API）。
- 重命名（官方 `session.rename`）、置顶、导出（官方日志导出）、fork（官方 `session.fork`）。
- 删除/清理连带删除第三方源文件（违反安全底线，永不支持）。
- 强制重复导入生成副本。
- Codex Desktop/VSCode 工程树整合；只按 rollout 文件扫描。
- token/模型版本统计。
- CLI 子命令形态（Agent 工具与设置页已覆盖 headless 与 Web）。

## Further Notes

- 本 spec 钉在 DSH **0.1.0-rc.7**；`SESSION_FORMAT_VERSION = 0` 无迁移承诺，因此导入只走官方 seed 路径，升级风险由官方加载器吸收。
- 取消归档与删除对账依赖 rc.7 内部形状：ADRs 已规定守卫与官方 API 出现后的切换义务。
- 全文索引有体积与首次延迟成本，`first-search` 是默认值而非唯一值。
- 大文件导入/预览需流式或分批读取，禁止整文件载入内存（用户故事 65）。
- 术语一律使用 `CONTEXT.md`：会话/原生会话/导入会话/来源/归档/取消归档/删除/清理/打开续聊/保真映射/导入清单/去重键/源文件/import manifest。
