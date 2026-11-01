/**
 * RyHarness 分层装配：bundle 叠层。
 *
 * @module @ryharness/bundle
 */

export { BundleRegistry, resolveBundle, resolveBundles } from './resolve.ts'
export type {
  Bundle,
  BundleErrorCode,
  BundleLayer,
  BundlePluginDecision,
  ResolvedBundle,
} from './types.ts'
export { BundleError } from './types.ts'
