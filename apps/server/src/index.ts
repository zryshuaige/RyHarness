/**
 * RyAgent 本地后端（@ryagent/server）。
 *
 * HTTP API + WS 推送；可被 Electron 主进程内嵌（RyAgentServer.create），
 * 也可独立启动（src/main.ts）。API 与 WS 事件契约见包 README。
 * @module @ryagent/server
 */

export type { ServerOptions } from './app.ts'
export { RyAgentServer } from './app.ts'
export { EventHub } from './bus.ts'
export type { ProvidersConfigFile } from './config.ts'
export { DEFAULT_PROVIDERS, loadProvidersConfig, providerKeyConfigured, toAdapterConfig } from './config.ts'
export type { StampedWsEvent, WsEvent } from './events.ts'
export type { AgentTemplate } from './seed.ts'
export { AGENT_TEMPLATES, ensureSeedAgents, instantiateTemplate } from './seed.ts'
