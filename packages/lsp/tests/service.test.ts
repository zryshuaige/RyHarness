/**
 * 服务层：按扩展名挑 provider、派发四个操作、把「没有 provider」与
 * 「不支持这个操作」说清楚。
 *
 * 这里用的是内存里的假 provider：服务层要验的是**挑谁、派给谁、失败怎么讲**，
 * 这些与真服务器无关。真服务器的活儿在 `stdio-provider.test.ts` 里。
 */
import { describe, expect, it } from 'vitest'
import {
  LSP_OPERATIONS,
  LspError,
  type LspOperation,
  type LspProvider,
  type LspProviderCapabilities,
  LspService,
  selectProvider,
} from '../src/index.ts'

/** 记下被调了哪些操作的假 provider。 */
interface RecordingProvider extends LspProvider {
  readonly calls: string[]
}

/**
 * 造一个假 provider。
 * @param id - provider 的 id。
 * @param extensions - 它认哪些扩展名。
 * @param operations - 它支持哪些操作。
 * @returns 假 provider。
 */
function fakeProvider(
  id: string,
  extensions: string[],
  operations: readonly LspOperation[] = LSP_OPERATIONS,
): RecordingProvider {
  const calls: string[] = []
  return {
    id,
    extensions,
    calls,
    capabilities: { operations } satisfies LspProviderCapabilities,
    async definition(filePath, position) {
      calls.push('definition')
      return [{ uri: `file:///${filePath}`, line: position.line, character: position.character }]
    },
    async references(filePath, position) {
      calls.push('references')
      return [{ uri: `file:///${filePath}#ref`, line: position.line + 1, character: 0 }]
    },
    async implementations(filePath, position) {
      calls.push('implementations')
      return [{ uri: `file:///${filePath}#impl`, line: position.line + 2, character: 0 }]
    },
    async hover() {
      calls.push('hover')
      return { contents: '假文档' }
    },
  }
}

/** 把抛出来的错误抓下来，用来断言 code 与文案。 */
async function capture(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('代码导航服务', () => {
  it('按扩展名挑 provider', () => {
    const service = new LspService()
    const ts = fakeProvider('ts', ['.ts', '.tsx'])
    service.register(ts)

    expect(service.providerFor('src/app.ts')?.id).toBe('ts')
    expect(service.providerFor('src/app.tsx')?.id).toBe('ts')
    expect(service.providerFor('src/app.py')).toBeUndefined()
  })

  it('扩展名比大小写：.TS 也归到 .ts 的 provider', () => {
    const service = new LspService()
    service.register(fakeProvider('ts', ['.ts']))

    expect(service.providerFor('src/App.TS')?.id).toBe('ts')
  })

  it('没有扩展名的文件挑不到 provider', () => {
    const service = new LspService()
    service.register(fakeProvider('ts', ['.ts']))

    expect(service.providerFor('Makefile')).toBeUndefined()
  })

  it('多个 provider 都认这个扩展名时，先登记的赢', () => {
    const service = new LspService()
    service.register(fakeProvider('first', ['.ts']))
    service.register(fakeProvider('second', ['.ts']))

    expect(service.providerFor('a.ts')?.id).toBe('first')
    expect(selectProvider([fakeProvider('x', ['.ts']), fakeProvider('y', ['.ts'])], 'a.ts')?.id).toBe('x')
  })

  it('文件类型没有配语言服务器：报 no-provider，不拿别的顶替', async () => {
    const service = new LspService()
    service.register(fakeProvider('ts', ['.ts']))

    const error = await capture(service.definition('src/app.py', { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('no-provider')
    expect((error as LspError).message).toContain('.py')
  })

  it('文件连扩展名都没有：说清是没有扩展名，不是「类型没配」', async () => {
    const service = new LspService()
    service.register(fakeProvider('ts', ['.ts']))

    const error = await capture(service.definition('Makefile', { line: 0, character: 0 }))

    expect((error as LspError).code).toBe('no-provider')
    expect((error as LspError).message).toContain('没有扩展名')
  })

  it('provider 不支持这个操作：报 unsupported-operation', async () => {
    const service = new LspService()
    service.register(fakeProvider('ts', ['.ts'], ['definition', 'references']))

    const error = await capture(service.hover('src/app.ts', { line: 0, character: 0 }))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('unsupported-operation')
    expect((error as LspError).message).toContain('hover')
  })

  it('四个操作各自派给 provider', async () => {
    const service = new LspService()
    const provider = fakeProvider('ts', ['.ts'])
    service.register(provider)

    const definitions = await service.definition('src/app.ts', { line: 3, character: 5 })
    const references = await service.references('src/app.ts', { line: 3, character: 5 })
    const implementations = await service.implementations('src/app.ts', { line: 3, character: 5 })
    const hover = await service.hover('src/app.ts', { line: 3, character: 5 })

    expect(definitions).toEqual([{ uri: 'file:///src/app.ts', line: 3, character: 5 }])
    expect(references).toEqual([{ uri: 'file:///src/app.ts#ref', line: 4, character: 0 }])
    expect(implementations).toEqual([{ uri: 'file:///src/app.ts#impl', line: 5, character: 0 }])
    expect(hover?.contents).toBe('假文档')
    expect(provider.calls).toEqual(['definition', 'references', 'implementations', 'hover'])
  })

  it('同一个 id 再登记一次是替换，不是多一个', () => {
    const service = new LspService()
    service.register(fakeProvider('ts', ['.ts']))
    service.register(fakeProvider('ts', ['.py']))

    expect(service.listProviders()).toHaveLength(1)
    expect(service.providerFor('a.py')?.id).toBe('ts')
  })

  it('撤掉 provider', () => {
    const service = new LspService()
    service.register(fakeProvider('ts', ['.ts']))

    expect(service.unregister('ts')).toBe(true)
    expect(service.unregister('ts')).toBe(false)
    expect(service.listProviders()).toHaveLength(0)
  })

  it('dispose 收掉所有 provider，一个失败不挡着别的', async () => {
    const service = new LspService()
    let disposed = 0
    const good: LspProvider = {
      id: 'good',
      extensions: ['.ts'],
      capabilities: { operations: LSP_OPERATIONS },
      async definition() {
        return []
      },
      async references() {
        return []
      },
      async implementations() {
        return []
      },
      async hover() {
        return undefined
      },
      async dispose() {
        disposed += 1
      },
    }
    const bad: LspProvider = {
      ...good,
      id: 'bad',
      async dispose() {
        disposed += 1
        throw new Error('收不干净')
      },
    }
    service.register(good)
    service.register(bad)

    await service.dispose()

    expect(disposed).toBe(2)
    expect(service.listProviders()).toHaveLength(0)
  })
})
