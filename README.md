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

## 本地装配到 profile

```bash
dsh plugin --profile web add .
dsh --profile web --dump-config   # 应看到 "# == @dsh-external/dsh-session-management" 层
dsh web
```

> bundle 成员关系变化需要重启 profile；修改 profile/home 层的 `cordis.patch.yml` 走热重载。

## 打包与发布

```bash
npm pack        # 生成 tgz（可直接 dsh plugin add <tgz>）
npm publish     # 若发布到 npm（记得先移除/调整 private 字段）
```

从 GitHub 直接安装时需确保构建产物随包分发或提供自包含 `prepare` 脚本，详见官方 [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.html)。

## 参考

- 官方插件开发指南：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
- 本仓库研究笔记：[docs/research/dsh-plugin-development.md](docs/research/dsh-plugin-development.md)