# DSH（DeepSeek Harness）插件开发研究笔记

> 研究日期：2026-08-30 · 研究方式：以官方文档仓库 `deepseek-ai/DeepSeek-Harness`（master 分支）为唯一一手来源，另核对了本机 `$DSH_HOME` 的实际配置。
> 官方入口页：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>（对应源码 [docs/user/develop/basic/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.md)）

## TL;DR

1. **插件 = 一个 TypeScript/JavaScript 模块**，导出 `apply(ctx)` 函数（另有对象/类两种形态），通过 `ctx` 注册一切能力。
2. **一切能力都是"效果"**：通过 `ctx` 注册的监听器、工具、服务、定时器在插件卸载时自动清理；自定义资源用 `ctx.effect(() => disposer)` 挂清理函数。
3. **依赖靠 `inject` 声明**：`export const inject = ['tools']` 让框架等 `ctx.tools` 就绪后再加载插件。
4. **工具用 `@deepseek-ai/dsh-tools` 的 `defineTool()`** 定义：schema 自动进 system prompt、args 自动校验、`output.schema` 声明规范返回值、`output.render` 负责给模型看的文本。
5. **配置用 Schemastery**：导出与 `Config` 类型同名的 `Config` Schema，配置经校验+默认值后才进 `apply(ctx, config)`。
6. **分发形态是 bundle**：`package.json` 里声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，用户用 `dsh plugin --profile <name> add <包/路径/git>` 安装；bundle 的 patch 是一个"插入插件行"的配置层。
7. 本仓库（dsh-session-management）应按 **bundle** 形态组织，详见文末"对本仓库的建议"。

---

## 1. 插件模型：Cordis 之上的 `apply(ctx)`

官方定义：插件是一个导出 `apply` 函数的模块，框架加载时调用 `apply` 并传入 `ctx`（Cordis Context），插件通过 `ctx` 注册能力（[basic/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.md)）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // 在这里注册能力
}
```

`name` 标识插件；若消费 `tools`/`llm` 等服务，必须用 `inject` 声明，框架会等所有必需服务就绪后再执行 `apply`（[basic/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.md)）。

### 三种插件形态

| 形态 | 写法 | 适用场景 |
|---|---|---|
| 函数 | `export function apply(ctx) {}` + `export const name/inject` | 大多数场景，推荐默认 |
| 对象 | `export default { name, inject, apply(ctx) {} }` | 配置集中时 |
| 类 | `export default class X extends Service { static inject = [...] ; constructor(ctx) { super(ctx, '服务名') } }` | 要向其他插件**提供服务**时 |

来源：[basic/index.md — Three plugin forms](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.md)；类形态细节见 [framework/service.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/framework/service.md)。

> 底层框架是 DeepSeek 维护的 Cordis（`@deepseek-ai/cordis`，vendor 目录，版本 4.0.1，见 [vendor/cordis/package.json](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/vendor/cordis/package.json)）。官方有一个纯 Cordis 教程：[docs/cordis-tutorial](https://github.com/deepseek-ai/DeepSeek-Harness/tree/master/docs/cordis-tutorial)。

## 2. 生命周期与自动清理

每个已加载插件拥有一个 Fiber 作用域，状态机为（[framework/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/framework/index.md)）：

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

要点：

- **依赖驱动加载**：`inject` 声明的服务不齐就停在 PENDING；运行时必需服务消失（如 provider 被替换）→ 插件自动卸载，服务恢复后自动重载。
- **自动清理**：`ctx.on()`、`ctx.tools.register()`、`ctx.llm.registerAdapter()` 全部在卸载时自动撤销；需要显式清理的资源（网络连接、定时器等）用 `ctx.effect(() => { ...; return cleanup })`，返回的 disposer 在卸载时执行。
- **卸载顺序**：disposer 按注册的**逆序**开始，但多个异步 disposer 并发执行、无串行保证；有顺序依赖的清理要放进同一个 `ctx.effect()` 返回的单一 disposer 里串行 await。
- **嵌套/手动控制**：`ctx.plugin(childPlugin)` 创建子 Fiber（随父卸载递归清理）；`await fiber.dispose()` 可提前停掉一个实例，保证所有注册被移除、子插件递归卸载、异步清理完成后才 resolve。
- **HMR**：在 cordis.yml 加载 `@deepseek-ai/cordis-plugin-hmr` 后，改插件源文件会"卸载旧实例 → 加载新代码 → 重新 apply"，注册因为自带清理而不会残留。

## 3. 依赖与服务（Services）

服务是插件之间共享的能力；`tools`、`llm`、`agents` 都是服务，挂在 `ctx` 上（[framework/service.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/framework/service.md)）。

**消费**：

```ts
export const inject = ['tools']   // 必需依赖
export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
}
// 可选依赖：不写 inject，用 ctx.get('metrics')?.record(...) 就地查询
```

**提供**（类形态 + 声明合并获得类型安全）：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { metrics: MetricsService }
}

export default class MetricsService extends Service {
  static inject = ['llm']        // 服务自身也可以有依赖
  constructor(ctx: Context) { super(ctx, 'metrics') }
  record(event: string, value: number) { /* ... */ }
}
```

其他插件 `inject: ['metrics']` 后即可用 `ctx.metrics.record(...)`。

- **服务隔离**：cordis.yml 中可用 `isolate:` + `group: true` 让不同插件组各持一份服务实例（如不同超时的 Bash）。
- 内置服务的名称/方法/源码位置由仓库生成到 subsystem 页面（`docs/subsystems/core.md`），开发时以生成的区域和 TS 接口为准，不要维护第二份静态清单。
- 三个角色的能力分层（Service Definition / Provider / Consumer，如 `dsh-shell` / `dsh-bash-local` / `dsh-tool-bash`）是官方推荐的进阶组织方式，见 [practice/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/practice/index.md)。简单工具插件不需要预拆分。

## 4. 事件系统

事件是插件间松耦合通信机制（[framework/events.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/framework/events.md)）：

| 模式 | 调用 | 语义 |
|---|---|---|
| 广播 | `ctx.emit(name, payload)` | 同步执行所有监听器，返回值忽略 |
| 短路 | `ctx.bail(name, input)` | 首个非 `null/false/undefined` 返回值即最终结果 |
| 串行 | `await ctx.serial(name, ctx)` | 按注册顺序 await，同上短路 |
| 管道 | `await ctx.waterfall(name, input, async () => input)` | 每个监听器**必须调用 `next()`**，可包裹下游结果 |

- 类型安全用 declaration merging 扩展 `interface Events`。
- Harness 的 Cordis 事件使用 `namespace/action` 命名（如 `agent/pre-step`、`agent/request`、`tools/result`、`session/event`）；`turn/*`、`tool/call`、`tool/result`、`compaction/*` 是持久化会话事件，**不是**同名 Cordis 事件，要监听 `session/event` 再看 `event.type`。
- 监听器是效果，随插件卸载自动移除。

## 5. 开发一个模型可调用工具（defineTool）

最小形态（[basic/tool.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/tool.md)）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

关键契约（[cookbook/adding-a-tool.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/cookbook/adding-a-tool.md)）：

- **args 自动校验**：`parameters` 用统一的 ParameterSchemaSpec，模型传参在执行前被校验；`execute` 内 `args` 类型自动推导。schema 也自动进入 system prompt 组装。
- **返回一个规范 JSON 值**：`output.schema` 声明 canonical value（标量/数组/对象/null 根均可）；`execute` 只返回该值，系统会校验、冻结并交给 `output.render(args, value)` 生成给模型看的内容块。不要直接返回内容块、不要让调用方从散文中解析 id。
- **异常即失败**：抛错或返回非法值 → `isError`；基础设施失败用 throw。
- **尊重 `exec.signal`**：取消进行中的工作。
- **异步通知**：`exec.agent.inject({...})` 把上下文注入模型的下一次请求（不是唤醒）。
- **长任务**：用 `ctx.jobs.start({ kind, label, owner: exec.agent, run })` 注册后台任务，返回 `{ kind: 'background', jobId }` 这类规范句柄。
- **策略/观测扩展点**：`tools/pre-execute`（allow/deny/ask）、`ctx.tools.guard()`（最终否决）、`tools/execute`（包一层加超时/重试/指标）、`tools/post-execute`、`tools/result`。
- **PTC 模式**：注册的工具自动成为 `await tools.<name>(args)` 可用，类型由同一 schema 推导。
- **UI 卡片**：`presentCall`/`presentResult` 是**纯函数**（直播与回放都要跑，禁止 I/O、读会话状态、时钟/随机）；`output.presentationMeta` 负责从 canonical value 派生可回放的卡片数据。无 UI 展示时退回 generic 卡片。

## 6. 插件配置（Schemastery）

导出 `Config` 类型 + 同名的 Schemastery Schema，默认值直接写在 schema 字段上（[basic/config.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/config.md)）：

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; maxRetries: number; verbose?: boolean }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) { /* config 已校验 + 填默认 */ }
```

cordis.yml 里给对应行配 `config:`；加载时校验，非法配置直接加载失败。注意：

- **不要导出普通对象当 Config**——不实现 Standard Schema 接口。
- **一切可调参数都要做成配置字段**（判断标准：不改代码、只改 cordis.yml 能否改这个值）；非法配置要"响亮地失败"。
- 改配置会热替换插件（旧实例卸载、新实例加载，注册不残留）。

## 7. 打包与安装：bundle 与 profile（最重要的分发概念）

安装体系建立在两个概念上，都用 `package.json` 描述，但在 `dsh` 键下携带**不同种类的 manifest**（[basic/publish.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.md)）：

| 概念 | manifest | 回答的问题 | 例子 |
|---|---|---|---|
| **bundle** | `dsh.bundle` | 这个包贡献什么配置层？ | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| **profile** | `dsh.profile` | 哪些 bundle、以什么顺序组成一套可运行环境？ | `"dsh": { "profile": { "bundles": [...] } }` |

一个包**要么是 bundle 要么是 profile，不会两者皆是**。bundle 是你开发分发的；profile 位于 `$DSH_HOME/profiles/<name>`，用户用 `dsh --profile <name>` 启动。

### Bundle 的文件结构

```
hello-plugin/
├── package.json        # 声明 dsh.bundle
├── cordis.patch.yml    # 该包贡献的配置层
└── index.js            # patch 行引用的插件模块
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml：与 --patch 叠加层格式相同的 YAML 数组，
# 但插件行按“包名”引用，让 Node 解析命中安装后的代码。
- insert:
    - id: hello
      name: dsh-hello-plugin
```

> 没有 `dsh.bundle` 声明的包也能安装，但只是普通依赖：`dsh plugin` 会警告且不激活任何配置层。这种格式给"插件 import 的库包"用。

### 安装进 profile

```sh
dsh plugin --profile demo add ./hello-plugin      # 本地 checkout（pnpm link）
dsh plugin --profile demo add github:you/hello-plugin   # git 源
dsh plugin --profile demo add your-package        # npm
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz # tarball
```

`dsh plugin <args>` 就是在 profile 目录里转发给 pnpm（pnpm 必须在 PATH）。首次使用会初始化 profile（第一个 bundle 为 `@deepseek-ai/dsh-base`），link 包并把 bundle 追加进 `dsh.profile.bundles`。`remove` 同时删依赖和配置层。验证与启动：

```sh
dsh --profile demo --dump-config   # 应出现 "# == dsh-hello-plugin" 层
dsh --profile demo
```

### 加载顺序（layer 优先级，后写覆盖先写）

生效配置在一个空根上依次叠加（[publish.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.md)、[CLI reference](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/apps/cli/reference/README.md)）：

1. `dsh.profile.bundles` 列表中的每个 bundle patch（按列表顺序，`@deepseek-ai/dsh-base` 第一）；
2. profile 自己的 `cordis.patch.yml`；
3. 机器级 `$DSH_HOME/cordis.patch.yml`（所有 profile 共享，压过 per-profile 层）；
4. 每个 `--patch <path>` 叠加层（按 argv 顺序）。

Patch 语义要点：

- **按行 id 覆盖，后写者赢**；覆盖时替换整行 `config` 的**整个值**，不做深合并——bundle 作者覆盖早先层时要重述该行所需全部键。
- 顶层 patch 条目是"id 定向覆盖"；要**新增**插件行必须用 `insert:` 列表形式（本机 profile 注释亦有此说明，见 [本机 web profile 的 cordis.patch.yml](file:///C:/Users/26716/.dsh/profiles/web/cordis.patch.yml)）。
- 内建 bundle 名始终从 dsh 安装本身解析（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-sdk-app`、`@deepseek-ai/dsh-sdk-minimal`、`@deepseek-ai/dsh-acp-app`）；pnpm 只管理 out-of-tree 包。裸插件名则经 profile 目录的 Node 父级向上走到维护的扁平 fallback `$DSH_HOME/profiles/node_modules`（每次启动自愈一个符号链接/依赖闭包包）。
- 该机制的决策记录：[2026-08-05-profile-plugin-bundles.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md)（"Everything becomes a profile"）。
- **bundle 成员关系变化要重启 profile**；而 profile/家目录 cordis.patch.yml 的普通编辑走热重载（`dsh.profile.patchReload`：`live` 监听 / `startup` 一次性；自定义 profile 默认 `live`）。

### 从 GitHub 安装的构建坑（官方明确警告）

git 安装拉的是**源码而非构建产物**，不会替你跑 `build`，TypeScript 包会因缺 `lib/` 而加载失败（[publish.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.md)）：

- **作者侧**：在 `prepare` 脚本里做自包含构建（不能依赖 monorepo 开发环境，如项目引用/类型检查之外的 tsdown 转译）。
- **用户侧**：pnpm ≥10 默认拒绝 git 依赖的 `prepare`，首次 `add` 失败后，把 pnpm 打印的确切包键写进 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  再重跑 `add`。该允许 = "授权该包在你机器上安装期执行代码"（在 agent 沙箱之外），只放行可信源码并**钉住 commit**（`github:you/hello-plugin#<sha>`）。
- 不想麻烦用户就走**构建产物**：npm 发布（`lib/` 在 publish 时构建好）或 `pnpm pack` 的 tarball，两种都不需要 build 权限。

### 给 bundle 自带命令行（进阶）

bundle 挂一个普通 provider 插件：`inject = ['cmdlineArgs']` + `parseCmdline`（`@deepseek-ai/dsh-cmdline`），从 program action 提供自己的服务；行配置用 `!!js ctx.myAppStartup.port ?? 8080` 读 flag 值（flag 优先于字面配置）。详见 [publish.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.md)。

## 8. 本地开发工作流（不打包的快速路径）

官方教程路径（[basic/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.md)）适用于在 harness 源码 checkout 内开发：

```sh
# 仓库根
mkdir -p scratch-plugin/src
# scratch-plugin/cordis.yml（Web 叠加层，插入本地插件；路径必须绝对）：
#   - insert:
#       - id: hello
#         name: '/绝对路径/deepseek-harness/scratch-plugin/src/my-plugin.ts'
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

本仓库是**独立的外部插件仓库**，等价做法：先把包 build 出 `lib/`，再 `dsh plugin --profile <name> add .`（相对路径锚定在调用目录），或临时用 `--patch ./cordis.yml`（patch 内 name 用绝对路径）做实验。推荐直接用 `--dump-config` 校验层已进入组合。

## 9. 进阶主题索引

- **三角色能力设计**（Definition/Provider/Consumer）：[practice/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/practice/index.md)
- **LLM adapter**（接入新模型后端：`LlmAdapter.stream()` + `ctx.llm.registerAdapter()`，StreamChunk 协议、`GenerateOptions`、`resolveModel`）：[practice/llm-adapter.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/practice/llm-adapter.md)
- **运行时动态 Cordis**（模型借 `@deepseek-ai/dsh-tool-cordis` 挂载/卸载内存插件）：[practice/dynamic-cordis.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/practice/dynamic-cordis.md)
- **在 monorepo 内加包**（含包结构/编译/装配约定）：[docs/cookbook/adding-a-package.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/cookbook/adding-a-package.md)
- **CLI 权威行为**（层优先级、profile 机制、`--dump-config`、`dsh plugin` 转发的精确语义）：[apps/cli/reference/README.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/apps/cli/reference/README.md)

## 10. 对本仓库（dsh-session-management）的落地建议

现状：仓库目前只有 README 与 docs/，无插件代码；远程为 `github.com/AndyWipe13/dsh-session-management`。目标是一个会话管理插件（删除遗留会话、导入 Claude Code/Codex 会话）。建议按官方 **bundle** 形态组织：

```
dsh-session-management/
├── package.json
├── cordis.patch.yml
├── src/index.ts            # 插件入口（apply）
├── tsconfig.json
├── scripts/build.sh        # 可选：DSH_CHECKOUT 探测 + tsc
└── lib/                    # 构建产物（提交或随发布打包）
```

`package.json` 草图（bundle 声明为官方必需，peerDependencies 为本会话内置脚手架工具采用的工程约定，便于范围声明而不硬编码版本）：

```json
{
  "name": "@dsh-external/dsh-session-management",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "cordis.patch.yml"],
  "scripts": { "build": "tsc -p tsconfig.json", "prepare": "npm run build" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*"
  }
}
```

`cordis.patch.yml` 草图：

```yaml
- insert:
    - id: session-management
      name: '@dsh-external/dsh-session-management'
      config: {}
```

开发循环：

1. `npm run build`（或 `pnpm build`）产出 `lib/`；
2. 首次装配：`dsh plugin --profile web add .`（等价 pnpm link + 追加到 `dsh.profile.bundles`）；
3. `dsh --profile web --dump-config` 确认出现本 bundle 层；
4. `dsh web` 启动；此后改 `src` 要重新 build；改动 profile/home 层 `cordis.patch.yml` 走热重载，增删 bundle 需重启。
5. 发布：npm 发布、`npm pack` 产 tgz，或 GitHub Release 附 tgz（`dsh plugin add github:...` 则记得 `prepare` + 用户侧 `allowBuilds`）。

会话管理功能可参考 monorepo 内现成包作为服务/工具边界样板：`packages/session`、`packages/session-query`（含 `tool-session-query`）、`packages/subagent/subagent-claude-code`、`packages/subagent/subagent-codex`（树清单见 [DeepSeek-Harness 仓库](https://github.com/deepseek-ai/DeepSeek-Harness)）；服务签名以生成的 [subsystem 页面](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/subsystems/core.md) 为准。

## 11. 本机环境事实（2026-08-30 观测）

- 本机 `dsh`：**0.1.0-rc.7**；`pnpm`：**11.8.0**（`dsh plugin` 需要 pnpm 在 PATH）。
- `$DSH_HOME` = `C:\Users\26716\.dsh`；已有 `profiles/web`。
- 本机 `profiles/web/package.json` 的 `dsh.profile.bundles` 实测为：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@dsh-external/dsh-super-injector`、`@linxin666/dsh-ssh`、`@linxin666/dsh-remote-web-ui` —— 印证外部插件用 `@dsh-external/dsh-*` 或作者 scope（`@linxin666/*`）命名，既可 `link:` 本地路径也可 npm 版本安装（[本机文件](file:///C:/Users/26716/.dsh/profiles/web/package.json)）。
- 官方仓库当前快照：`@deepseek-ai/cordis` 4.0.1（[vendor/cordis/package.json](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/vendor/cordis/package.json)）、`@deepseek-ai/dsh-tools` 0.1.2-alpha.1（[packages/core/tools/package.json](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/packages/core/tools/package.json)）。
- 本会话还内置一套"插件生产线"开发工具（`dev_scaffold_plugin` / `dev_build_plugin` / `dev_inject_plugin` / `dev_install_package` / `dev_reload_package` / `dev_release_plugin` 等），可自动生成 toolkit / daemon-loop / ui-panel / hybrid 四种骨架并完成 build→装配→热重载；它们属于**本会话环境工具**，不是官方文档内容，底层语义仍以上述官方机制为准（bundle patch、lib 构建、profile bundles）。

## 来源清单（全部一手）

- 官方插件开发指南入口：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
- [docs/user/develop/basic/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.md)（插件定义、三种形态、自动清理、inject、scratch-plugin 流程）
- [docs/user/develop/basic/tool.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/tool.md)（defineTool 入门）
- [docs/user/develop/basic/config.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/config.md)（Schemastery 配置）
- [docs/user/develop/basic/publish.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.md)（bundle/profile、安装、层顺序、git 安装坑）
- [docs/user/develop/framework/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/framework/index.md)（Fiber 生命周期）
- [docs/user/develop/framework/service.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/framework/service.md)（服务与依赖）
- [docs/user/develop/framework/events.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/framework/events.md)（事件系统）
- [docs/user/develop/practice/index.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/practice/index.md)（三角色能力设计）
- [docs/user/develop/practice/llm-adapter.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/practice/llm-adapter.md)（LLM 适配器）
- [docs/user/develop/practice/dynamic-cordis.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/practice/dynamic-cordis.md)（运行时动态插件）
- [docs/cookbook/adding-a-tool.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/cookbook/adding-a-tool.md)（工具契约完整参考）
- [apps/cli/reference/README.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/apps/cli/reference/README.md)（CLI/层顺序/`dsh plugin` 权威语义）
- [.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md)（profile/bundle 设计决策）
- 本机观测：`C:\Users\26716\.dsh\profiles\web\{package.json,cordis.patch.yml}`、`dsh --version`、`pnpm --version`。
