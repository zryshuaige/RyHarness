/**
 * OTel 数据形状：Span 与指标点。
 *
 * 用的是 OTLP 的**字段名**（traceId / spanId / startTimeUnixNano …），但线上的
 * 编码在 {@link ../exporter.ts} 那层做——这里只有纯数据。
 * @module @ryharness/otel/types
 */

/** Span 的状态码。 */
export type SpanStatusCode = 'UNSET' | 'OK' | 'ERROR'

/** 一个 span。 */
export interface Span {
  /** 32 位十六进制的 trace id。 */
  readonly traceId: string
  /** 16 位十六进制的 span id。 */
  readonly spanId: string
  /** 父 span id；根 span 没有。 */
  readonly parentSpanId?: string
  /** span 的名字（做什么）。 */
  readonly name: string
  /** 开始时刻（Unix 纳秒）。 */
  readonly startTimeUnixNano: string
  /** 结束时刻（Unix 纳秒）。 */
  readonly endTimeUnixNano: string
  /** 属性（键值对，值只能是字符串/数字/布尔）。 */
  readonly attributes: Readonly<Record<string, string | number | boolean>>
  /** 状态。 */
  readonly status: {
    readonly code: SpanStatusCode
    readonly message?: string
  }
}

/** 一个指标点。 */
export interface MetricPoint {
  /** 指标名。 */
  readonly name: string
  /** 数值。 */
  readonly value: number
  /** 单位（可选）。 */
  readonly unit?: string
  /** 采样时刻（Unix 纳秒）。 */
  readonly timeUnixNano: string
  /** 属性。 */
  readonly attributes: Readonly<Record<string, string | number | boolean>>
}

/** 资源属性（这条进程/服务是谁）。 */
export interface OtelResource {
  /** 服务名。 */
  readonly serviceName: string
  /** 服务版本。 */
  readonly serviceVersion?: string
  /** 其它资源属性。 */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
}

/** 把毫秒时间戳换成 Unix 纳秒字符串（OTLP 用字符串承载 64 位整数）。 */
export function unixNano(milliseconds: number): string {
  return String(BigInt(Math.round(milliseconds)) * 1_000_000n)
}

/** 生成一个随机十六进制 id（指定字节数）。 */
export function randomHexId(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) buffer[i] = Math.floor(Math.random() * 256)
  return Array.from(buffer, (byte) => {
    return byte.toString(16).padStart(2, '0')
  }).join('')
}
