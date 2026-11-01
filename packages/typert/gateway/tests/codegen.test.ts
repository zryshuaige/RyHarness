/**
 * 生成的客户端：类型、源码与运行时代理。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  buildTypeGraph,
  createRemoteClientProxy,
  generateClientSource,
  generateClientTypes,
  namespaceTypeName,
} from '../src/index.ts'
import { GREETING_ANNOTATIONS, GreetingService } from './helpers.ts'

/** 造一张带注解的图。 */
function greetingGraph(): ReturnType<typeof buildTypeGraph> {
  return buildTypeGraph([{ namespace: 'greeting', service: new GreetingService(), methods: GREETING_ANNOTATIONS }])
}

/**
 * 用真正的 TypeScript 编译器检查一段源码。
 *
 * 为什么要真编译一遍：生成的客户端「编译期就报错」这句话，不亲自编译一次
 * 说了不算。
 * @param files - 文件名 → 内容。
 * @returns 每个文件里的编译错误。
 */
function compileFiles(files: Readonly<Record<string, string>>): ReadonlyMap<string, readonly ts.Diagnostic[]> {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-codegen-'))
  try {
    const paths = new Map<string, string>()
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name)
      writeFileSync(path, content, 'utf8')
      paths.set(path, content)
    }
    const program = ts.createProgram({
      rootNames: [...paths.keys()],
      options: {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: [],
      },
    })
    const byFile = new Map<string, ts.Diagnostic[]>()
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      if (diagnostic.file === undefined) continue
      const path = diagnostic.file.fileName
      const list = byFile.get(path) ?? []
      list.push(diagnostic)
      byFile.set(path, list)
    }
    return byFile
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('生成的客户端', () => {
  it('类型声明里有每个命名空间的接口', () => {
    const source = generateClientTypes(greetingGraph())
    expect(source).toContain('export interface GreetingRemote {')
    expect(source).toContain('greet(name: string, greeting?: string): Promise<string>')
    expect(source).toContain('add(a: number, b: number): Promise<number>')
    expect(source).toContain('export interface TypertRemoteClient {')
  })

  it('接口名由命名空间推出来，撞名时加序号', () => {
    expect(namespaceTypeName('greeting')).toBe('GreetingRemote')
    expect(namespaceTypeName('my-namespace')).toBe('MyNamespaceRemote')
    expect(namespaceTypeName('a.b')).toBe('ABRemote')
  })

  it('完整源码里有类型图与工厂函数', () => {
    const source = generateClientSource(greetingGraph())
    expect(source).toContain('const TYPERT_GRAPH: TypeGraph =')
    expect(source).toContain('export function createTypertRemoteClient(invoke: RemoteInvoker): TypertRemoteClient')
    expect(source).toContain('"namespace": "greeting"')
  })

  it('运行时代理照着图调方法', async () => {
    const graph = greetingGraph()
    const seen: string[] = []
    const proxy = createRemoteClientProxy(graph, async (namespace, method, args) => {
      seen.push(`${namespace}.${method}`)
      return args.join('|')
    })
    await expect(proxy.greeting.greet('甲', '乙')).resolves.toBe('甲|乙')
    expect(seen).toEqual(['greeting.greet'])
  })

  it('访问图里没有的命名空间：立刻抛错', () => {
    const proxy = createRemoteClientProxy(greetingGraph(), async () => undefined)
    expect(() => proxy.nope).toThrowError(/命名空间/)
  })

  it('调用图里没有的方法：立刻抛错，不发出去', async () => {
    const calls: string[] = []
    const proxy = createRemoteClientProxy(greetingGraph(), async (namespace, method) => {
      calls.push(`${namespace}.${method}`)
      return undefined
    })
    expect(() => proxy.greeting.nope).toThrowError(/方法/)
    expect(calls).toEqual([])
  })

  it('生成的客户端源码能过编译', () => {
    const types = generateClientTypes(greetingGraph())
    const diagnostics = compileFiles({
      'client.ts': types,
      'probe.ts':
        "import type { TypertRemoteClient } from './client.ts'\ndeclare const client: TypertRemoteClient\nexport const value = client.greeting.greet('甲')\n",
    })
    const errors = [...diagnostics.values()].flat()
    expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '))).toEqual([])
  })

  it('调用一个不存在的方法：编译期就报错', () => {
    const types = generateClientTypes(greetingGraph())
    const diagnostics = compileFiles({
      'client.ts': types,
      'probe.ts':
        "import type { TypertRemoteClient } from './client.ts'\ndeclare const client: TypertRemoteClient\nexport const value = client.greeting.nope('甲')\n",
    })
    const errors = [...diagnostics.values()].flat()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('\n')).toContain('nope')
  })
})
