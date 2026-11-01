/**
 * 分层装配：把若干层叠成一个 bundle。
 *
 * 叠的规矩：**后一层覆盖前一层**（覆盖的是「启用与否」与「配置」）。插件清单按 id
 * 排——叠的结果与层里写的顺序无关，这样「叠」才是可预期的。
 * @module @ryharness/bundle/resolve
 */

import { type Bundle, BundleError, type BundlePluginDecision, type ResolvedBundle } from './types.ts'

/**
 * 叠一层。
 *
 * @param current - 已经叠好的决定（插件 id → 决定）。
 * @param layer - 要叠上去的这一层。
 * @param overridden - 记录被覆盖的那些（谁盖了谁）。
 * @returns 叠完后的决定。
 */
function applyLayer(
  current: Map<string, BundlePluginDecision>,
  layer: Bundle['layers'][number],
  overridden: Array<{ id: string; byLayer: string }>,
): Map<string, BundlePluginDecision> {
  for (const decision of layer.plugins) {
    const previous = current.get(decision.id)
    if (previous !== undefined) overridden.push({ id: decision.id, byLayer: layer.id })
    current.set(decision.id, decision)
  }
  return current
}

/**
 * 叠一个 bundle。
 *
 * @param bundle - bundle（层从底到顶）。
 * @returns 叠完的结果。
 */
export function resolveBundle(bundle: Bundle): ResolvedBundle {
  if (bundle.name.trim().length === 0) {
    throw new BundleError('invalid-name', 'bundle 没有名字')
  }
  const current = new Map<string, BundlePluginDecision>()
  const overridden: Array<{ id: string; byLayer: string }> = []
  for (const layer of bundle.layers) {
    if (layer.plugins.length === 0) {
      throw new BundleError('empty-layer', `层 "${layer.id}" 一个插件都没决定，空层不装`)
    }
    applyLayer(current, layer, overridden)
  }
  const plugins = [...current.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { name: bundle.name, plugins, overridden }
}

/**
 * 把若干 bundle 叠在一起（按数组顺序，后面的盖前面的）。
 *
 * 这是「profile 之上再叠一层」的那种用法：基础 bundle + 用户自己那份。
 * @param bundles - 要叠的 bundle（从底到顶）。
 * @returns 叠完的结果。
 */
export function resolveBundles(bundles: readonly Bundle[]): ResolvedBundle {
  if (bundles.length === 0) {
    throw new BundleError('not-found', '一个 bundle 都没给')
  }
  const merged: Bundle = {
    name: bundles.map((bundle) => bundle.name).join('+'),
    layers: bundles.flatMap((bundle) => bundle.layers),
  }
  return resolveBundle(merged)
}

/** bundle 注册表：按名字存一份，取出来就能叠。 */
export class BundleRegistry {
  private readonly bundles = new Map<string, Bundle>()

  /**
   * 登记一个 bundle。
   * @param bundle - bundle。
   */
  register(bundle: Bundle): void {
    if (bundle.name.trim().length === 0) {
      throw new BundleError('invalid-name', 'bundle 没有名字')
    }
    if (this.bundles.has(bundle.name)) {
      throw new BundleError('duplicate-bundle', `bundle "${bundle.name}" 已经登记过了`)
    }
    this.bundles.set(bundle.name, bundle)
  }

  /** 已登记的 bundle（按名字排）。 */
  list(): Bundle[] {
    return [...this.bundles.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 按名字取一个 bundle 并叠好。
   * @param name - bundle 名。
   * @returns 叠完的结果。
   */
  resolve(name: string): ResolvedBundle {
    const bundle = this.bundles.get(name)
    if (bundle === undefined) {
      throw new BundleError('not-found', `没有这个 bundle：${name}`)
    }
    return resolveBundle(bundle)
  }
}
