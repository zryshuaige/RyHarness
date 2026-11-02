/**
 * OTLP/HTTP 导出器：把 span 与指标点发到 OTel 收集器。
 *
 * 为什么自己写：OTLP 的 JSON 编码就是几个固定形状的 JSON，而完整的 OTel SDK 有一大
 * 套采样、批处理、重试与上下文传播的实现——我们只要「把计量送出去」这一件事。
 *
 * 两条硬要求：
 * - **不卡住业务**：导出是异步的，失败只记一笔，不抛给调用方。
 * - **不无限堆积**：队列有上限，满了丢最旧的（丢计量比拖慢对话好）。
 * @module @ryharness/otel/exporter
 */

import type { MetricPoint, OtelResource, Span } from './types.ts'
import { unixNano } from './types.ts'

/** 导出器的构造参数。 */
export interface OtlpExporterOptions {
  /** OTLP/HTTP 的端点（完整 URL，例如 `http://127.0.0.1:4318/v1/traces`）。 */
  readonly endpoint: string
  /** 资源属性：这条服务是谁。 */
  readonly resource: OtelResource
  /** 请求头（比如鉴权）。 */
  readonly headers?: Readonly<Record<string, string>>
  /** 单次请求超时（毫秒）。默认 5000。 */
  readonly timeoutMs?: number
  /** 队列上限：超过就丢最旧的。默认 500。 */
  readonly maxQueue?: number
  /** 导出用的 fetch（测试注入用）。 */
  readonly fetchImpl?: typeof fetch
}

/** 导出结果：成功与否、失败原因。 */
export interface OtlpExportResult {
  readonly ok: boolean
  /** 失败原因（成功时是 undefined）。 */
  readonly error?: string
}

/** 一次导出失败累计了多少次（给界面看「遥测通道通不通」）。 */
export interface OtlpExporterStats {
  /** 成功发出的批次数。 */
  readonly batchesSent: number
  /** 失败的批次数。 */
  readonly batchesFailed: number
  /** 因为队列满被丢掉的条数。 */
  readonly dropped: number
  /** 当前队列里还排着多少条。 */
  readonly pending: number
}

/** span 队列的形状（一条 span 或一条指标点）。 */
type QueueItem = { kind: 'span'; span: Span } | { kind: 'metric'; point: MetricPoint }

/**
 * OTLP/HTTP 导出器。
 *
 * 用法：往 {@link record} 里塞 span 与指标点，`flush()` 时按类型分两批发出去。
 */
export class OtlpExporter {
  private readonly endpoint: string
  private readonly resource: OtelResource
  private readonly headers: Readonly<Record<string, string>>
  private readonly timeoutMs: number
  private readonly maxQueue: number
  private readonly fetchImpl: typeof fetch
  private readonly queue: QueueItem[] = []
  private batchesSent = 0
  private batchesFailed = 0
  private dropped = 0

  constructor(options: OtlpExporterOptions) {
    this.endpoint = options.endpoint
    this.resource = options.resource
    this.headers = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.maxQueue = options.maxQueue ?? 500
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * 记一条 span 或指标点。
   *
   * 队列满了丢最旧的：丢计量比拖慢对话好——对话是用户等着的，计量只是给事后看的。
   * @param item - span 或指标点。
   */
  record(item: Span | MetricPoint): void {
    const entry: QueueItem = 'traceId' in item ? { kind: 'span', span: item } : { kind: 'metric', point: item }
    this.queue.push(entry)
    while (this.queue.length > this.maxQueue) {
      this.queue.shift()
      this.dropped += 1
    }
  }

  /** 队列里现在有多少条。 */
  get pending(): number {
    return this.queue.length
  }

  /** 导出统计。 */
  stats(): OtlpExporterStats {
    return {
      batchesSent: this.batchesSent,
      batchesFailed: this.batchesFailed,
      dropped: this.dropped,
      pending: this.queue.length,
    }
  }

  /**
   * 把队列里的东西发出去。
   *
   * 按类型分两批（spans 与 metrics 各走各的路径）。**失败不抛**：导出失败不该让
   * 业务知道——计量是旁观者，它出问题不能拖垮对话。
   * @returns 两批的结果。
   */
  async flush(): Promise<{ spans: OtlpExportResult; metrics: OtlpExportResult }> {
    const spans = this.queue.filter((item): item is { kind: 'span'; span: Span } => item.kind === 'span')
    const metrics = this.queue.filter((item): item is { kind: 'metric'; point: MetricPoint } => item.kind === 'metric')
    this.queue.length = 0
    return {
      spans:
        spans.length === 0
          ? { ok: true }
          : await this.send('/v1/traces', this.tracesPayload(spans.map((item) => item.span))),
      metrics:
        metrics.length === 0
          ? { ok: true }
          : await this.send('/v1/metrics', this.metricsPayload(metrics.map((item) => item.point))),
    }
  }

  /** 清空队列（停机时用：没送出去的也别留）。 */
  clear(): void {
    this.queue.length = 0
  }

  /** 组装 traces 的 OTLP JSON。 */
  private tracesPayload(spans: readonly Span[]): unknown {
    return {
      resourceSpans: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeSpans: [
            {
              scope: { name: 'ryharness' },
              spans: spans.map((span) => {
                return {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
                  name: span.name,
                  startTimeUnixNano: span.startTimeUnixNano,
                  endTimeUnixNano: span.endTimeUnixNano,
                  attributes: Object.entries(span.attributes).map(([key, value]) => {
                    return { key, value: { stringValue: String(value) } }
                  }),
                  status: {
                    code: span.status.code,
                    ...(span.status.message === undefined ? {} : { message: span.status.message }),
                  },
                }
              }),
            },
          ],
        },
      ],
    }
  }

  /** 组装 metrics 的 OTLP JSON。 */
  private metricsPayload(points: readonly MetricPoint[]): unknown {
    return {
      resourceMetrics: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeMetrics: [
            {
              scope: { name: 'ryharness' },
              metrics: [
                {
                  name: points[0]?.name ?? 'ryharness.metric',
                  sum: {
                    dataPoints: points.map((point) => {
                      return {
                        timeUnixNano: point.timeUnixNano,
                        asDouble: point.value,
                        attributes: Object.entries(point.attributes).map(([key, value]) => {
                          return { key, value: { stringValue: String(value) } }
                        }),
                      }
                    }),
                  },
                },
              ],
            },
          ],
        },
      ],
    }
  }

  /** 资源属性（service.name 至少要有）。 */
  private resourceAttributes(): unknown[] {
    const attributes: Array<{ key: string; value: { stringValue: string } }> = [
      { key: 'service.name', value: { stringValue: this.resource.serviceName } },
    ]
    if (this.resource.serviceVersion !== undefined) {
      attributes.push({ key: 'service.version', value: { stringValue: this.resource.serviceVersion } })
    }
    for (const [key, value] of Object.entries(this.resource.attributes ?? {})) {
      attributes.push({ key, value: { stringValue: String(value) } })
    }
    return attributes
  }

  /** 发一批出去。失败只记数，不抛。 */
  private async send(path: string, payload: unknown): Promise<OtlpExportResult> {
    const url = this.endpoint.endsWith('/') ? `${this.endpoint}${path.slice(1)}` : `${this.endpoint}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        this.batchesFailed += 1
        return { ok: false, error: `HTTP ${response.status}` }
      }
      this.batchesSent += 1
      return { ok: true }
    } catch (error) {
      this.batchesFailed += 1
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 造一个 span（时间戳用毫秒，内部换算成纳秒）。 */
export function makeSpan(input: {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  startedAtMs: number
  endedAtMs: number
  attributes?: Readonly<Record<string, string | number | boolean>>
  status?: { code: 'UNSET' | 'OK' | 'ERROR'; message?: string }
}): Span {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    name: input.name,
    startTimeUnixNano: unixNano(input.startedAtMs),
    endTimeUnixNano: unixNano(input.endedAtMs),
    attributes: input.attributes ?? {},
    status: input.status ?? { code: 'UNSET' },
  }
}
