/**
 * RyHarness OTel 通道：把运行时计量按 OTLP 送出去。
 *
 * @module @ryharness/otel
 */

export type { OtlpExporterOptions, OtlpExporterStats, OtlpExportResult } from './exporter.ts'
export { makeSpan, OtlpExporter } from './exporter.ts'
export type { MetricPoint, OtelResource, Span, SpanStatusCode } from './types.ts'
export { randomHexId, unixNano } from './types.ts'
