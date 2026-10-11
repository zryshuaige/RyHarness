// M1: copy the M0 "必拷" minimal closure from deepseek-harness into RyAgent,
// renaming @deepseek-ai/{cordis,cosmokit,schemastery,dsh-*} -> @ryagent/*.
// Read-only against the source repo. Idempotent: wipes target package dirs first.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'F:/AgenticResearch/deepseek-harness'
const DST = 'F:/AgenticResearch/RyAgent'

// longest-first so '@deepseek-ai/dsh-util-values' wins over '@deepseek-ai/dsh-...' prefixes
const RENAME = [
  ['@deepseek-ai/dsh-typert-protocol', '@ryagent/typert-protocol'],
  ['@deepseek-ai/dsh-util-crypto', '@ryagent/util-crypto'],
  ['@deepseek-ai/dsh-util-values', '@ryagent/util-values'],
  ['@deepseek-ai/dsh-invariants', '@ryagent/invariants'],
  ['@deepseek-ai/dsh-attachment', '@ryagent/attachment'],
  ['@deepseek-ai/dsh-timeout', '@ryagent/timeout'],
  ['@deepseek-ai/dsh-llm', '@ryagent/llm'],
  ['@deepseek-ai/dsh-brand', '@ryagent/brand'],
  ['@deepseek-ai/cordis-plugin-include', '@ryagent/cordis-plugin-include'],
  ['@deepseek-ai/cordis-plugin-loader', '@ryagent/cordis-plugin-loader'],
  ['@deepseek-ai/cordis', '@ryagent/cordis'],
  ['@deepseek-ai/cosmokit', '@ryagent/cosmokit'],
  ['@deepseek-ai/schemastery', '@ryagent/schemastery'],
]
function renameText(text) {
  let out = text
  for (const [from, to] of RENAME) out = out.split(from).join(to)
  return out
}

// [sourceRelDir, targetRelDir, packageName, extraPackageJson]
const PACKAGES = [
  ['vendor/cordis', 'vendor/cordis', '@ryagent/cordis', {
    dependencies: { '@ryagent/cosmokit': 'workspace:*', '@standard-schema/spec': '^1.1.0' },
  }],
  ['vendor/cosmokit', 'vendor/cosmokit', '@ryagent/cosmokit', {}],
  ['vendor/schemastery', 'vendor/schemastery', '@ryagent/schemastery', {
    dependencies: { '@ryagent/cosmokit': 'workspace:*', '@standard-schema/spec': '^1.1.0' },
  }],
  ['packages/typert/protocol', 'packages/typert/protocol', '@ryagent/typert-protocol', {
    dependencies: { '@ryagent/brand': 'workspace:*' },
    peerDependencies: { '@ryagent/cordis': 'workspace:*' },
  }],
  ['packages/util/brand', 'packages/util/brand', '@ryagent/brand', {}],
  ['packages/util/values', 'packages/util/values', '@ryagent/util-values', {}],
  ['packages/util/crypto', 'packages/util/crypto', '@ryagent/util-crypto', {}],
  ['packages/util/timeout', 'packages/util/timeout', '@ryagent/timeout', {}],
  ['packages/runtime-diagnostics/invariants', 'packages/runtime-diagnostics/invariants', '@ryagent/invariants', {
    dependencies: { '@ryagent/cordis': 'workspace:*', '@ryagent/schemastery': 'workspace:*' },
  }],
  ['packages/llm/llm', 'packages/llm/llm', '@ryagent/llm', {
    dependencies: {
      '@ryagent/attachment': 'workspace:*',
      '@ryagent/brand': 'workspace:*',
      '@ryagent/timeout': 'workspace:*',
      '@ryagent/typert-protocol': 'workspace:*',
      '@ryagent/util-crypto': 'workspace:*',
      '@ryagent/util-values': 'workspace:*',
      'zod': '^4.4.3',
    },
    peerDependencies: { '@ryagent/cordis': 'workspace:*' },
  }],
]

function copySrc(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir)) {
    const s = join(srcDir, entry)
    const d = join(dstDir, entry)
    const st = statSync(s)
    if (st.isDirectory()) {
      if (entry === 'tests' || entry === 'node_modules' || entry === 'lib') continue
      copySrc(s, d)
      continue
    }
    if (!/\.(ts|mts)$/.test(entry) || /\.(test|spec)\.ts$/.test(entry)) continue
    writeFileSync(d, renameText(readFileSync(s, 'utf8')))
  }
}

function packageJson(name, extra) {
  return JSON.stringify({
    name,
    version: '0.1.0',
    type: 'module',
    main: './lib/index.js',
    types: './lib/index.d.ts',
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './src/*': './src/*',
      './package.json': './package.json',
    },
    scripts: { build: 'tsdown' },
    ...extra,
  }, null, 2) + '\n'
}

for (const [rel, dstRel, name, extra] of PACKAGES) {
  const dstDir = join(DST, dstRel)
  rmSync(dstDir, { recursive: true, force: true })
  copySrc(join(SRC, rel, 'src'), join(dstDir, 'src'))
  writeFileSync(join(dstDir, 'package.json'), packageJson(name, extra))
  console.log(`copied ${rel} -> ${dstRel} (${name})`)
}
console.log('done')
