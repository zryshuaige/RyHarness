/**
 * 运行时能力目录：让助理能**查**这个运行时到底有什么。
 *
 * 上游叫 `tool-cordis`（两个只读工具做运行时 API 发现）。我们给它同一个形状：
 * 一份描述（工具、路由、服务），一个按关键词查的入口。
 *
 * **只读**：这一族不提供「让模型自己挂插件」的口子——那等于把宿主的能力面交给
 * 模型，而模型的判断力不足以承担这个风险。真要装插件，走人点的界面。
 * @module @ryharness/extensions/types
 */

/** 一个工具在目录里的样子。 */
export interface CatalogTool {
  readonly name: string
  readonly description: string
}

/** 一条路由在目录里的样子。 */
export interface CatalogRoute {
  readonly method: string
  readonly pattern: string
}

/** 一个服务在目录里的样子。 */
export interface CatalogService {
  readonly name: string
  readonly description: string
}

/** 运行时能力目录。 */
export interface RuntimeCatalog {
  readonly tools: readonly CatalogTool[]
  readonly routes: readonly CatalogRoute[]
  readonly services: readonly CatalogService[]
}

/** 目录的输入（宿主把自己的运行时事实倒进来）。 */
export interface RuntimeCatalogInput {
  readonly tools?: readonly CatalogTool[]
  readonly routes?: readonly CatalogRoute[]
  readonly services?: readonly CatalogService[]
}

/** 一份扩展清单：这个扩展**提供**什么、**依赖**什么。 */
export interface ExtensionManifest {
  /** 稳定 id。 */
  readonly id: string
  /** 给人看的名字。 */
  readonly name: string
  /** 一句话说明它带来什么。 */
  readonly description: string
  /** 它提供的工具名（给人查目录用）。 */
  readonly providesTools?: readonly string[]
  /** 它依赖的其它扩展 id。 */
  readonly requires?: readonly string[]
}

/** 扩展清单校验失败的原因码。 */
export type ExtensionErrorCode = 'invalid-id' | 'duplicate-id' | 'missing-requirement' | 'circular-dependency'

/** 扩展清单校验失败：带机器码与一句人话。 */
export class ExtensionError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ExtensionError'
  }
}
