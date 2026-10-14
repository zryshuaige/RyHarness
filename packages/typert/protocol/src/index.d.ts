/**
 * Remote decorators and the Service base that binds them, backed by versioned
 * descriptors carried on decorated class prototypes. Strict reflection and the
 * RPC carrier remain a Typert compiler / Gateway responsibility this repo does
 * not implement.
 * @module @ryagent/typert-protocol
 */
import { Context, Service } from '@ryagent/cordis'

export { RemoteError } from './remote-error.ts'
export type { RemoteErrorCode, RemoteErrorDetailsMap } from './types.ts'
/** Options for an explicit Service-to-Gateway binding. */
export interface TypertGatewayBindingOptions {
  /** Wire namespace; defaults to the Cordis service key. */
  readonly namespace?: string
}
/** Visible declaration that one Service participates in Typert Gateway export. */
export interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service
  readonly serviceKey: string
  readonly namespace: string
}
type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void
/** Cordis Service base that exposes its registered name through Typert Gateway. */
export declare abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>
  /**
   * Register the Service and bind the same key to Typert Gateway.
   * @param ctx - owning Cordis Context.
   * @param serviceKey - exact Cordis service key and default wire namespace.
   * @param options - optional distinct wire namespace.
   */
  protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions)
}
/**
 * Mark one public instance method as a direct Remote invocation.
 * @param _method - decorated method; retained only by the class itself.
 * @param context - standard decorator context used to schedule private marking.
 */
export declare function Remote<This extends object, Args extends unknown[], Result>(
  _method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void
/**
 * Mark one public instance method under an exported name.
 * @param exportName - endpoint method name; defaults to the method name.
 * @returns a standard method decorator.
 */
export declare function Remote(exportName: string): RemoteMethodDecorator
