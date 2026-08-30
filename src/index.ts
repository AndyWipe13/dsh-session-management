/**
 * @dsh-external/dsh-session-management — 会话管理插件。
 *
 * 当前为工程基线切片（issue #2）：
 * - 已移除脚手架 hello 占位工具；
 * - 插件保持可构建、可装配、可卸载的干净入口；
 * - 后续切片将在此注册 SessionManagement 服务、设置页与 Agent 工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = '@dsh-external/dsh-session-management'
export const inject: string[] = []

export interface Config {}

export const Config = z.object({})

export function apply(_ctx: Context, _config: Config): void {
  // 基线切片暂无业务注册；后续功能全部挂 ctx.effect，热重载/卸载自动清理。
}