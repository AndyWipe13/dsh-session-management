# dsh-session-management

**中文** | [English](README.en.md)

---

DeepSeek Harness（DSH）插件：管理 Harness 生成的会话，允许用户删除遗留会话，并支持从其他第三方 Agent（目前已支持 Claude Code、Codex）导入会话。

### 功能

- **统一会话管理**：在 DSH 设置页提供跨来源（DSH / Claude Code / Codex）的会话列表、搜索、预览、打开续聊、归档/取消归档、删除与批量清理、统计。
- **第三方会话导入**：把 Claude Code、Codex 的本地历史会话全保真转换为可续聊的 DSH 原生会话（文本、thinking、工具调用与结果全部保留，不伪造可执行工具）。
- **安全底线**：第三方源文件永远只读；运行中的会话一律拒删；删除显式不可逆（批量必须键入 `DELETE`）；清理永远先预览后执行。

### 安装方式

从 npm 一键安装（推荐）：

```bash
dsh plugin --profile web add @nathan110628/dsh-session-management
dsh --profile web --dump-config   # 应看到 "# == @nathan110628/dsh-session-management" 层
dsh web
```

或从 GitHub 安装（等价，仓库内附带已构建的 `lib/`）：

```bash
dsh plugin --profile web add github:AndyWipe13/dsh-session-management
```

卸载：

```bash
dsh plugin --profile web remove @nathan110628/dsh-session-management
```

### 开发构建与本地装配

- `src/index.ts` — 插件入口（导出 `apply(ctx)`）
- `cordis.patch.yml` — bundle 贡献的配置层（`dsh.bundle.patch`）
- `package.json` — 声明 `dsh.bundle` 与 peer 依赖
- `scripts/build.js` — 跨平台 Node 构建脚本

构建（无需 DSH 源码 checkout；自动回退到 `~/.dsh/profiles/node_modules` 官方依赖镜像）：

```bash
npm install
npm run build
```

产物输出到 `lib/`（入口 `lib/index.js`，类型 `lib/types/index.d.ts`）。

**装配：**

```bash
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

### 工程基线验证

无 DSH 源码 checkout 的 Windows 环境（依赖 `~/.dsh/profiles/node_modules` 官方依赖镜像）可直接跑：

```bash
npm run build       # 编译 src -> lib
npm run typecheck   # TypeScript 类型检查（自动先 build 链接依赖）
npm test            # 运行测试（自动先 build）
```

测试使用 Node 内置 test runner（`--test-isolation=none`），覆盖：

- 插件基线导出与 bundle 装配自检（hello 占位工具已移除）；
- fake 官方服务装配能力（`sessions` / `sessionQuery` / `sessionPersistence` / `workspaceRegistry` / `storageDomain`）；
- 只读夹具银行（Claude Code、Codex 含 archived_sessions、DSH 各 ≥2 个，含空会话/坏行/中文 Unicode/subagent 边界样本）。

夹具位于 `test/fixtures/`，任何测试前后不得修改其字节与 mtime；生成脚本见 `scripts/generate-fixtures.js`。

导入按源会话的 `cwd` 创建或复用官方工作区，日志持久化后再登记会话成员，并将扫描页标题保存为 `session/title` 事件。工作目录不存在时会报告导入失败。rc.7 侧栏需要刷新页面同步。

宿主接口回归位于 `test/host-contract.test.js`，覆盖官方标题的 `value.title.title` 嵌套、持久化后的工作区登记，以及旧导入修复的准备对象释放。`scripts/check-session-ui.cjs` 接收 Playwright `page` 和临时会话的 `{ sessionId, title }`，验证勾选、归档、取消归档、取消删除和实际删除；仅对可丢弃测试会话运行。

### 参考

官方插件开发指南：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
