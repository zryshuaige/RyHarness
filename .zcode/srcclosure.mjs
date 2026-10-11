// src-import closure + size measurement
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'F:/AgenticResearch/deepseek-harness';
const pkgs = new Map();
function scan(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) {
        try { const j = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')); if (j.name) pkgs.set(j.name, p); } catch {}
      }
    } catch {}
  }
}
scan(join(ROOT, 'packages'));
scan(join(ROOT, 'vendor'));
for (const e of readdirSync(join(ROOT, 'packages'))) {
  const p = join(ROOT, 'packages', e);
  if (statSync(p).isDirectory()) scan(p);
}

function srcImports(name) {
  const dir = pkgs.get(name);
  if (!dir) return new Set();
  const out = new Set();
  (function walk(d) {
    let ents; try { ents = readdirSync(d); } catch { return; }
    for (const e of ents) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e) && !e.endsWith('.d.ts')) {
        const txt = readFileSync(p, 'utf8');
        const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g;
        let m;
        while ((m = re.exec(txt))) {
          const spec = m[1] || m[2];
          if (spec.startsWith('.') || spec.startsWith('#')) continue;
          out.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
        }
      }
    }
  })(join(dir, 'src'));
  return out;
}

const seeds = process.argv.slice(2);
const seen = new Set(seeds);
const q = [...seeds];
while (q.length) {
  const n = q.pop();
  for (const i of srcImports(n)) if (pkgs.has(i) && !seen.has(i)) { seen.add(i); q.push(i); }
}
console.log('=== src-import closure of', seeds.join(', '), '===');
console.log([...seen].sort().join('\n'));

// sizes
console.log('\n=== sizes (src .ts files, excl. tests/*.test.*) ===');
for (const n of [...seen].sort()) {
  const dir = pkgs.get(n);
  let files = 0, loc = 0;
  (function walk(d) {
    let ents; try { ents = readdirSync(d); } catch { return; }
    for (const e of ents) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(e) && !/\.(test|spec)\.ts$/.test(e) && !e.endsWith('.d.ts')) {
        files++; loc += readFileSync(p, 'utf8').split('\n').length;
      }
    }
  })(join(dir, 'src'));
  console.log(`${n}\t${relative(ROOT, dir)}\t${files} files\t${loc} loc`);
}
