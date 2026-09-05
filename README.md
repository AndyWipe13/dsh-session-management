# @dsh-external/dsh-session-management

DeepSeek Harness（DSH）插件：管理 Harness 生成的会话，允许用户删除遗留会话，并支持从其他第三方 Agent（Claude Code、Codex）导入会话。

## 开发构建

本仓库已按官方 **bundle** 形态组织：

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

## 工程基线验证

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

导入按源会话的 `cwd` 创建或复用官方工作区，日志持久化后再登记会话成员，并将扫描页标题保存为 `session/title` 事件。工作目录不存在时会报告导入失败。旧版本已导入但未分组的会话，可在会话页点击「修复导入工作区」补全登记与缺失标题；已有标题不会覆盖，原会话 ID 与历史保持不变。rc.7 侧栏需要刷新页面同步。

宿主接口回归位于 `test/host-contract.test.js`，覆盖官方标题的 `value.title.title` 嵌套、持久化后的工作区登记，以及旧导入修复的准备对象释放。`scripts/check-session-ui.cjs` 接收 Playwright `page` 和临时会话的 `{ sessionId, title }`，验证勾选、归档、取消归档、取消删除和实际删除；仅对可丢弃测试会话运行。

## 安装到 profile（最终用户）

从 GitHub 一键安装（推荐，无需先拉取源码）：

```bash
dsh plugin --profile web add github:AndyWipe13/dsh-session-management
dsh --profile web --dump-config   # 应看到 "# == @dsh-external/dsh-session-management" 层
dsh web
```

卸载：

```bash
dsh plugin --profile web remove @dsh-external/dsh-session-management
```

> 本仓库的 `lib/` 构建产物已随 git 提交，因此 `github:` 安装无需 prepare 脚本或 pnpm `allowBuilds` 授权。
> bundle 成员关系变化需要重启 profile；修改 profile/home 层的 `cordis.patch.yml` 走热重载。

## 开发者：从源码本地装配

只有需要修改插件源码时才使用本地路径装配：

```bash
npm install
npm run build
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

> `add .` 只用于本地开发调试，不是最终用户的安装方式。

## 打包与发布

```bash
npm pack        # 生成 tgz（可直接 dsh plugin add <tgz>）
npm publish     # 若发布到 npm（记得先移除/调整 private 字段）
```

分发方式：

- **GitHub 一键安装**：`dsh plugin --profile web add github:AndyWipe13/dsh-session-management`。本仓库已随 git 提交 `lib/` 构建产物，所以不需要 `prepare` 脚本或 pnpm `allowBuilds` 授权。
- **npm 包**：`dsh plugin --profile web add @dsh-external/dsh-session-management`（发布后可用）。
- **tarball**：`npm pack` 后执行 `dsh plugin --profile web add ./dsh-external-dsh-session-management-0.0.1.tgz`。

官方安装/发布机制详见 [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.html)。

## 参考

- 官方插件开发指南：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
- 本仓库研究笔记：[docs/research/dsh-plugin-development.md](docs/research/dsh-plugin-development.md)
