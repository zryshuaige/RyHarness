/**
 * RyHarness 的技能目录：可复用的工作法，按需发现、按需加载。
 *
 * 三块东西：
 * - **注册表**（{@link SkillRegistry}）：把多个来源的技能目录合成一份，同名时
 *   按明规则裁决（内嵌 > 优先级 > 先注册），输掉的那一路记在 conflicts 里；
 * - **文件系统来源**（{@link FileSystemSkillProvider}）：从项目目录、用户目录、
 *   自定义目录里发现技能，解析 frontmatter，改了目录能刷新；
 * - **模型工具**（{@link createSkillTool}）：模型看到的是**目录**（名字 + 一句
 *   说明），点名才取正文。
 *
 * 本包**不含任何技能内容**——它是发现与加载的机制，不是内容本身。
 * @module @ryharness/skill
 */

export type { SkillErrorCode } from './errors.ts'
export { describeSkillFailure, SkillError } from './errors.ts'
export {
  defaultSkillRoots,
  FileSystemSkillProvider,
  type FileSystemSkillProviderOptions,
  SKILL_FILE_NAME,
  type SkillRoot,
} from './filesystem.ts'
export {
  type Frontmatter,
  type FrontmatterValue,
  frontmatterList,
  frontmatterText,
  parseFrontmatter,
} from './frontmatter.ts'
export { RUNTIME_SOURCE, SkillRegistry } from './registry.ts'
export {
  createSkillTool,
  renderSkillCatalog,
  renderSkillContent,
  SKILL_TOOL_NAME,
  type SkillToolOptions,
} from './tool.ts'
export type {
  Skill,
  SkillConflict,
  SkillDiagnostic,
  SkillProvider,
  SkillProviderFailure,
  SkillSummary,
} from './types.ts'
export { SKILL_NAME_PATTERN } from './types.ts'
