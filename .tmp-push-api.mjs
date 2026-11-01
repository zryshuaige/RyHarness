// 一次性脚本：github.com 的 git 协议连不上时，用 Git Data API 把本地提交推上去。
// 做法：blob → tree → commit → PATCH ref → 建 tag。
// 关键：commit 的作者/提交者/时刻/消息/树/父提交全按本地那份复刻，于是 API 造出来的
// commit 与本地那个**同一个 sha**（commit 的 sha 就是这些字段的哈希）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const repo = 'zryshuaige/RyHarness'
const base = 'origin/main'
const message = execFileSync('git', ['log', '-1', '--pretty=%B', 'HEAD'], { encoding: 'utf8' }).trim()
const parent = execFileSync('git', ['rev-parse', base], { encoding: 'utf8' }).trim()
const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const who = (fmt) => execFileSync('git', ['log', '-1', `--pretty=${fmt}`, 'HEAD'], { encoding: 'utf8' }).trim()

function gh(args, input) {
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out)
}

const raw = execFileSync('git', ['diff', '--name-status', base, 'HEAD'], { encoding: 'utf8' })
const modes = new Map()
for (const line of execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' }).split('\n')) {
  if (line.trim().length === 0) continue
  const [meta, ...rest] = line.split('\t')
  const mode = (meta ?? '').split(' ')[0] ?? '100644'
  modes.set(rest.join('\t'), mode)
}

const entries = []
for (const line of raw.split('\n')) {
  if (line.trim().length === 0) continue
  const parts = line.split('\t')
  const status = parts[0] ?? ''
  const path = parts[parts.length - 1] ?? ''
  if (status.startsWith('D')) entries.push({ path, mode: '100644', type: 'blob', sha: null })
  else entries.push({ path, mode: modes.get(path) ?? '100644', type: 'blob' })
}
console.log('待上传文件数：' + entries.length)

const todo = entries.filter((entry) => entry.sha !== null)
const shas = new Map()
let done = 0
async function upload(entry) {
  const bytes = readFileSync(entry.path)
  const result = gh(['api', '--method', 'POST', `repos/${repo}/git/blobs`, '--input', '-'], {
    content: bytes.toString('base64'),
    encoding: 'base64',
  })
  shas.set(entry.path, result.sha)
  done += 1
  if (done % 50 === 0) console.log('  blob ' + done + '/' + todo.length)
}

let index = 0
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (index < todo.length) {
      const entry = todo[index]
      index += 1
      if (entry === undefined) return
      await upload(entry)
    }
  }),
)

const tree = entries.map((entry) => {
  const sha = entry.sha === null ? null : shas.get(entry.path)
  return { path: entry.path, mode: entry.mode, type: 'blob', sha }
})

const baseCommit = gh(['api', `repos/${repo}/git/commits/${parent}`])
const treeResult = gh(['api', '--method', 'POST', `repos/${repo}/git/trees`, '--input', '-'], {
  base_tree: baseCommit.tree.sha,
  tree,
})
console.log('tree: ' + treeResult.sha)

const commit = gh(['api', '--method', 'POST', `repos/${repo}/git/commits`, '--input', '-'], {
  message,
  tree: treeResult.sha,
  parents: [parent],
  author: { name: who('%an'), email: who('%ae'), date: who('%aI') },
  committer: { name: who('%cn'), email: who('%ce'), date: who('%cI') },
})
console.log('commit: ' + commit.sha + '（本地 ' + localCommit + '）')

gh(['api', '--method', 'PATCH', `repos/${repo}/git/refs/heads/main`, '--input', '-'], {
  sha: commit.sha,
  force: false,
})
console.log('main 已更新')

const tagObject = gh(['api', '--method', 'POST', `repos/${repo}/git/tags`, '--input', '-'], {
  tag: 'v0.4.0',
  message: 'v0.4.0',
  object: { type: 'commit', sha: commit.sha },
  type: 'commit',
})
try {
  gh(['api', '--method', 'POST', `repos/${repo}/git/refs`, '--input', '-'], {
    ref: 'refs/tags/v0.4.0',
    sha: tagObject.sha,
  })
} catch {
  gh(['api', '--method', 'PATCH', `repos/${repo}/git/refs/tags/v0.4.0`, '--input', '-'], {
    sha: tagObject.sha,
    force: true,
  })
}
console.log('tag v0.4.0 已建立')
