/**
 * 环境变量取值：**新名优先，旧名仍然认**。
 *
 * 改名那天的兼容：用户的启动脚本、计划任务、CI 里写的还是旧名（RYAGENT_*）。直接不认
 * 的话，那些脚本会"突然不起作用"——比如数据目录悄悄换了个地方，用户打开应用发现
 * 自己的会话都不见了，却什么提示都没收到。
 *
 * @module @ryharness/server/env
 */

/** 环境变量取值：新名优先，旧名回落。 */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const current = env[`RYHARNESS_${name}`]
  if (current !== undefined && current.length > 0) return current
  const legacy = env[`RYAGENT_${name}`]
  return legacy !== undefined && legacy.length > 0 ? legacy : undefined
}
