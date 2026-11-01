/**
 * 分层装配：一个 bundle 由若干层叠成，每层决定「装哪些插件、给它们什么配置」。
 *
 * 上游（`bundle`）的口径是：每个包声明一份 `dsh.bundle.patch`，启动器把这些补丁
 * **叠起来**装出一个具名 profile。我们照这个口径做，但层是**数据**（不是包），
 * 所以同一套装配逻辑既能用于内置层，也能用于用户自己写的层。
 *
 * 叠的规矩只有一条：**后一层覆盖前一层**。覆盖什么？插件的启用与否与它的配置。
 * 插件清单里出现顺序不影响结果（结果按插件 id 排），这样「叠」才是可预期的。
 * @module @ryharness/bundle/types
 */

/** 一层里对某个插件的决定。 */
export interface BundlePluginDecision {
  /** 插件 id。 */
  readonly id: string
  /** 这一层要不要它。 */
  readonly enabled: boolean
  /** 给它的配置（可省）。 */
  readonly config?: unknown
}

/** 一层。 */
export interface BundleLayer {
  /** 层 id（给人看的）。 */
  readonly id: string
  /** 这一层对插件的决定。 */
  readonly plugins: readonly BundlePluginDecision[]
}

/** 一个 bundle：一叠层。 */
export interface Bundle {
  /** bundle 名（`--profile` 用的就是它）。 */
  readonly name: string
  /** 层，**从底到顶**排。 */
  readonly layers: readonly BundleLayer[]
}

/** 叠完之后的结果：每个插件一条决定。 */
export interface ResolvedBundle {
  /** bundle 名。 */
  readonly name: string
  /** 插件决定（按插件 id 排）。 */
  readonly plugins: readonly BundlePluginDecision[]
  /** 叠的过程中被覆盖掉的决定（每条写清被谁盖了）。 */
  readonly overridden: ReadonlyArray<{ id: string; byLayer: string }>
}

/** 装配失败的原因码。 */
export type BundleErrorCode = 'invalid-name' | 'duplicate-bundle' | 'not-found' | 'empty-layer'

/** 装配失败：带机器码与一句人话。 */
export class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BundleError'
  }
}
