/**
 * RyHarness 运行时能力目录：助理能查这个运行时有什么。
 *
 * @module @ryharness/extensions
 */

export { buildCatalog, ExtensionRegistry, searchCatalog } from './catalog.ts'
export { createRuntimeCatalogTool, RUNTIME_CATALOG_TOOL_NAME } from './tools.ts'
export type {
  CatalogRoute,
  CatalogService,
  CatalogTool,
  ExtensionErrorCode,
  ExtensionManifest,
  RuntimeCatalog,
  RuntimeCatalogInput,
} from './types.ts'
export { ExtensionError } from './types.ts'
