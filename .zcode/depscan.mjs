// Dependency closure scanner for deepseek-harness workspace packages.
// Usage: node depscan.mjs <pkgName> [<pkgName>...]
// Prints: declared-dep closure, plus src-import analysis of workspace-internal imports.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'F:/AgenticResearch/deepseek-harness';

// --- collect all workspace packages (packages/*/*/package.json + vendor/*) ---
const pkgs = new Map(); // name -> dir
function scan(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) {
        const pj = join(p, 'package.json');
        try {
          const j = JSON.parse(readFileSync(pj, 'utf8'));
          if (j.name) pkgs.set(j.name, p);
        } catch {}
      }
    } catch {}
  }
}
scan(join(ROOT, 'packages'));
scan(join(ROOT, 'vendor'));
// also nested llm group
(function deeper() {
  for (const e of readdirSync(join(ROOT, 'packages'))) {
    const p = join(ROOT, 'packages', e);
    if (statSync(p).isDirectory()) scan(p);
  }
})();

const declaredClosure = new Set();
function depsOf(name) {
  const dir = pkgs.get(name);
  if (!dir) return [];
  let j;
  try { j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return []; }
  return [...Object.keys(j.dependencies || {}), ...Object.keys(j.peerDependencies || {})];
}

function closure(seeds) {
  const out = new Set();
  const q = [...seeds];
  while (q.length) {
    const n = q.pop();
    if (out.has(n) || !pkgs.has(n)) continue;
    out.add(n);
    q.push(...depsOf(n));
  }
  out.delete(...seeds.filter(s => !pkgs.has(s)));
  return out;
}

// --- src import scan for a package: which workspace package names + external names it imports ---
function scanImports(name) {
  const dir = pkgs.get(name);
  if (!dir) return null;
  const srcDir = join(dir, 'src');
  const files = [];
  (function walk(d) {
    let ents;
    try { ents = readdirSync(d); } catch { return; }
    for (const e of ents) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|js)$/.test(e) && !e.endsWith('.d.ts')) files.push(p);
    }
  })(srcDir);
  const imports = new Set();
  const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(txt))) {
      const spec = m[1] || m[2] || m[3];
      imports.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
    }
  }
  return { files: files.length, imports: [...imports] };
}

const seeds = process.argv.slice(2);
const closureSet = closure(seeds);
console.log('=== Closure of', seeds.join(', '), '===');
for (const n of [...closureSet].sort()) {
  const { files, imports } = scanImports(n) || {};
  const internal = (imports || []).filter(i => pkgs.has(i));
  const external = (imports || []).filter(i => !pkgs.has(i) && !i.startsWith('.') && !i.startsWith('#'));
  console.log(`${n}\n  dir=${relative(ROOT, pkgs.get(n))} files=${files}`);
  console.log(`  internal-imports: ${internal.join(', ') || '(none)'}`);
  console.log(`  external-imports: ${external.join(', ') || '(none)'}`);
}
