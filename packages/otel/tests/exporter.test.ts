/**
 * OTel 导出器：OTLP/HTTP 的 JSON 形状、队列有界、失败不拖垮业务。
 */
import { makeSpan, OtlpExporter, randomHexId, unixNano } from '@ryharness/otel'
import { describe, expect, it } from 'vitest'

/** 一个够用的 Response 替身：导出器只问 ok 与 status。 */
function fakeResponse(ok: boolean, status: number): Response {
  const build = (): Response => {
    const response: Response = {
      ok,
      status,
      statusText: '',
      headers: new Headers(),
      body: null,
      bytes: async () => new Uint8Array(0),
      bodyUsed: false,
      redirected: false,
      type: 'basic',
      url: '',
      clone: build,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
      formData: async () => new FormData(),
      json: async () => ({}),
      text: async () => '',
    }
    return response
  }
  return build()
}

/** 记一次请求的假 fetch。 */
function fakeFetch(response: { ok: boolean; status: number }): {
  calls: Array<{ url: string; body: unknown; headers: Record<string, string> }>
  fetchImpl: typeof fetch
} {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as unknown,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return fakeResponse(response.ok, response.status)
  }
  return { calls, fetchImpl }
}

const span = makeSpan({
  name: 'turn',
  traceId: randomHexId(16),
  spanId: randomHexId(8),
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_000_250,
  attributes: { 'conversation.kind': 'direct', 'turn.index': 3 },
  status: { code: 'OK' },
})

describe('OTel 导出器', () => {
  it('span 按 OTLP 的形状发出去：字段名与资源属性都对', async () => {
    const fake = fakeFetch({ ok: true, status: 200 })
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness', serviceVersion: '0.3.0' },
      fetchImpl: fake.fetchImpl,
    })
    exporter.record(span)
    const result = await exporter.flush()
    expect(result.spans.ok).toBe(true)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.url).toBe('http://127.0.0.1:4318/v1/traces')
    const payload = fake.calls[0]?.body as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string }> }
        scopeSpans: Array<{ spans: Array<{ name: string; startTimeUnixNano: string }> }>
      }>
    }
    const resource = payload.resourceSpans[0]?.resource
    expect(resource?.attributes.map((attribute) => {
      return attribute.key
    })).toContain('service.name')
    const sent = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0]
    expect(sent?.name).toBe('turn')
    expect(sent?.startTimeUnixNano).toBe(unixNano(1_700_000_000_000))
  })

  it('指标走另一条路径（/v1/metrics）', async () => {
    const fake = fakeFetch({ ok: true, status: 200 })
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318/',
      resource: { serviceName: 'ryharness' },
      fetchImpl: fake.fetchImpl,
    })
    exporter.record({
      name: 'turn.total_ms',
      value: 250,
      unit: 'ms',
      timeUnixNano: unixNano(1_700_000_000_250),
      attributes: { 'turn.status': 'ok' },
    })
    const result = await exporter.flush()
    expect(result.metrics.ok).toBe(true)
    expect(fake.calls[0]?.url).toBe('http://127.0.0.1:4318/v1/metrics')
  })

  it('span 与指标分两批发', async () => {
    const fake = fakeFetch({ ok: true, status: 200 })
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness' },
      fetchImpl: fake.fetchImpl,
    })
    exporter.record(span)
    exporter.record({
      name: 'turn.total_ms',
      value: 1,
      timeUnixNano: unixNano(1),
      attributes: {},
    })
    await exporter.flush()
    expect(fake.calls.map((call) => {
      return call.url
    })).toEqual(['http://127.0.0.1:4318/v1/traces', 'http://127.0.0.1:4318/v1/metrics'])
  })

  it('发失败不抛：只记一笔失败', async () => {
    const fake = fakeFetch({ ok: false, status: 500 })
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness' },
      fetchImpl: fake.fetchImpl,
    })
    exporter.record(span)
    const result = await exporter.flush()
    expect(result.spans.ok).toBe(false)
    expect(result.spans.error).toContain('500')
    expect(exporter.stats().batchesFailed).toBe(1)
    expect(exporter.stats().batchesSent).toBe(0)
  })

  it('网络异常也不抛', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness' },
      fetchImpl,
    })
    exporter.record(span)
    const result = await exporter.flush()
    expect(result.spans.ok).toBe(false)
    expect(result.spans.error).toContain('ECONNREFUSED')
  })

  it('队列有界：满了丢最旧的，并记账', () => {
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness' },
      maxQueue: 2,
    })
    exporter.record(span)
    exporter.record(span)
    exporter.record(span)
    expect(exporter.pending).toBe(2)
    expect(exporter.stats().dropped).toBe(1)
  })

  it('flush 之后队列清空', async () => {
    const fake = fakeFetch({ ok: true, status: 200 })
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness' },
      fetchImpl: fake.fetchImpl,
    })
    exporter.record(span)
    await exporter.flush()
    expect(exporter.pending).toBe(0)
  })

  it('空队列不发请求', async () => {
    const fake = fakeFetch({ ok: true, status: 200 })
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness' },
      fetchImpl: fake.fetchImpl,
    })
    const result = await exporter.flush()
    expect(fake.calls).toHaveLength(0)
    expect(result.spans.ok).toBe(true)
    expect(result.metrics.ok).toBe(true)
  })

  it('请求头带上宿主给的那些（鉴权之类）', async () => {
    const fake = fakeFetch({ ok: true, status: 200 })
    const exporter = new OtlpExporter({
      endpoint: 'http://127.0.0.1:4318',
      resource: { serviceName: 'ryharness' },
      headers: { authorization: 'Bearer x' },
      fetchImpl: fake.fetchImpl,
    })
    exporter.record(span)
    await exporter.flush()
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer x')
  })
})
