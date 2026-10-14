/** The one Remote failure class shared by owners, the Gateway, and consumers. */
import type { RemoteErrorCode, RemoteErrorDetailsMap } from './types.ts'
/**
 * One Remote call failure: a real Error carrying its stable code and typed
 * details. Owners throw it at the failure point; the Host Gateway encodes it
 * onto the wire unchanged; the Client face rebuilds an instance for the
 * failure branch, so `throw result.error` keeps throw semantics.
 * Discrimination is always by `code`, never by instanceof.
 */
export declare class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
  readonly code: Code
  readonly details: RemoteErrorDetailsMap[Code]
  /** Structural marker: cross-realm/bundle identification never uses instanceof. */
  readonly isDSHRemoteError: true
  /**
   * @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
   * @param message - human diagnostic carried across the wire.
   * @param details - structured payload typed by the code.
   * @param options - standard Error options (`cause` survives in-process only).
   */
  constructor(code: Code, message: string, details: RemoteErrorDetailsMap[Code], options?: ErrorOptions)
}
