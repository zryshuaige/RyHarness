/**
 * RyHarness 本地后端（@ryharness/server）。
 *
 * HTTP API + WS 推送；可被 Electron 主进程内嵌（RyHarnessServer.create），
 * 也可独立启动（src/main.ts）。API 与 WS 事件契约见包 README。
 * @module @ryharness/server
 */

export type { ServerOptions } from './app.ts'
export { RyHarnessServer } from './app.ts'
export { EventHub } from './bus.ts'
export type { ProviderConfig, ProviderPreset, ProviderProtocol, ProvidersConfigFile } from './config.ts'
export {
  configureSecretStore,
  DEFAULT_PROVIDERS,
  deleteApiKey,
  loadApiKeys,
  loadProvidersConfig,
  PROVIDER_PRESETS,
  providerKeyConfigured,
  type SafeStorageLike,
  type SecretCodec,
  saveApiKey,
  secretStoreCipher,
  toAdapterConfig,
  writeProvidersConfig,
} from './config.ts'
export type { StampedWsEvent, WsEvent } from './events.ts'
export type { AskUserPluginDeps } from './plugins/ask-user.ts'
export { ASK_USER_PLUGIN_ID, ASK_USER_RESULT, askUserPlugin, createAskUserTool } from './plugins/ask-user.ts'
export type { QuestionEntry, QuestionStatus } from './plugins/ask-user-store.ts'
export {
  MAX_ANSWER_LENGTH,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  QuestionError,
  QuestionStore,
  renderQuestionContext,
} from './plugins/ask-user-store.ts'
export type { GrillMePluginDeps } from './plugins/grill-me.ts'
export {
  createGrillTool,
  GRILL_ASKED,
  GRILL_ME_PLUGIN_ID,
  GRILL_STOP,
  GRILL_TOOL_NAME,
  GRILL_WAIT,
  grillMePlugin,
  MAX_GRILL_OPTIONS,
  MIN_GRILL_OPTIONS,
} from './plugins/grill-me.ts'
export type { PluginCapabilities, PluginEntry, PluginGroup, PluginStatus, PluginView } from './plugins/host.ts'
export { PluginError, PluginHost } from './plugins/host.ts'
export type { RegisteredRoute } from './plugins/routes.ts'
export { RouteRegistry } from './plugins/routes.ts'
export type { SkillSpec, SkillView } from './plugins/skills.ts'
export { GRILL_ME_SKILL, GRILL_ME_SKILL_ID, SCAFFOLD_TOOL_NAME } from './plugins/skills.ts'
export type { TodoGroup, TodoItem } from './plugins/todo.ts'
export { TodoError, TodoStore } from './plugins/todo.ts'
export { createScaffoldTool } from './plugins/vibe-scaffold.ts'
export type { VoiceEngineStatus, VoiceProvider, VoiceProviderDeps } from './plugins/voice.ts'
export { VOICE_PLUGIN_ID, VoiceRegistry, voicePlugin } from './plugins/voice.ts'
export type {
  PiperChild,
  PiperExtract,
  PiperFetch,
  PiperInstallerOptions,
  PiperPluginOptions,
  PiperRunnerOptions,
  PiperSizeLimits,
  PiperSpawn,
} from './plugins/voice-piper.ts'
export {
  createPiperProvider,
  PIPER_BINARY_MIRRORS,
  PIPER_INSTALL_PATH,
  PIPER_MODEL_CONFIG_MIRRORS,
  PIPER_MODEL_MIRRORS,
  PIPER_PROFILE,
  PIPER_PROFILE_ID,
  PIPER_SIZE_LIMITS,
  PIPER_STATUS_PATH,
  PiperInstaller,
  PiperRunner,
  VOICE_PIPER_PLUGIN_ID,
  voicePiperPlugin,
} from './plugins/voice-piper.ts'
export type {
  ConnectLookup,
  FetchLike,
  ReadUrlOptions,
  ReadUrlResult,
  ResolveHost,
  UrlPin,
} from './plugins/web-read.ts'
export {
  createPinnedFetch,
  createReadUrlTool,
  decodeHtmlEntities,
  htmlToText,
  isPrivateAddress,
  pinnedRequestOptions,
  READ_URL_MAX_BYTES,
  READ_URL_MAX_CHARS,
  READ_URL_TIMEOUT_MS,
  WEB_READ_PLUGIN_ID,
  webReadPlugin,
} from './plugins/web-read.ts'
export type { ProactiveRun, ProactiveSettings, ProactiveSnapshot } from './proactive.ts'
export { composeProactiveMessage, localDayKey, PROACTIVE_AGENT_ID, PROACTIVE_BLOCK_TYPE } from './proactive.ts'
export type { ConversationState } from './routes/conversations.ts'
export type { MemoryHealthReport, MemoryRecall } from './routes/memory.ts'
export type { UserProfile } from './routes/profile.ts'
export type { ProviderUsage } from './routes/providers.ts'
export type {
  ConversationUsageRow,
  ProviderAgentUsage,
  ProviderUsageRow,
  UsageReport,
} from './routes/usage.ts'
export type {
  VibeOutputView,
  VibeProjectView,
  VibeQuestionView,
  VibeSessionView,
  VibeSquadMemberView,
  VibeVersionView,
} from './routes/vibe.ts'
export { MAX_SQUAD_SIZE, outputOf, pickSquad, registerVibeRoutes } from './routes/vibe.ts'
export type { AgentTemplate } from './seed.ts'
export { AGENT_TEMPLATES, ensureSeedAgents, instantiateTemplate } from './seed.ts'
export type { TelemetrySnapshot, TurnTiming } from './telemetry.ts'
export type { VibeProject, VibeProjectFile } from './vibe/project.ts'
export { DELIVERABLE_KINDS, type DeliverableKind } from './vibe/project.ts'
export type { VibeSession, VibeStage, VibeStageEvent, VibeStatus } from './vibe/store.ts'
export { MAX_QUESTIONS_PER_ROUND, MAX_REQUIREMENT_LENGTH, MAX_ROUNDS, VibeError, VibeStore } from './vibe/store.ts'
export type { VibeValidationCheck, VibeValidationReport } from './vibe/validation.ts'
export { parseCsv, validateVibeProject } from './vibe/validation.ts'
export type { VibeProjectVersion } from './vibe/versions.ts'
