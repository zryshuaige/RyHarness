// 一次性脚本：把工作区里剩下的小改动用 Git Data API 推上去（git 协议连不上时用）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const repo = 'zryshuaige/RyHarness'
const base = gh(['api', `repos/${repo}/git/refs/heads/main`]).object.sha
const message = execFileSync('git', ['log', '-1', '--pretty=%B', 'HEAD'], { encoding: 'utf8' }).trim()

function gh(args, input) {
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out)
}

const raw = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
const files = raw
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }))
console.log('要推的文件：' + JSON.stringify(files))

const tree = []
for (const file of files) {
  if (file.status === 'D') {
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null })
    continue
  }
  const bytes = readFileSync(file.path)
  const blob = gh(['api', '--method', 'POST', `repos/${repo}/git/blobs`, '--input', '-'], {
    content: bytes.toString('base64'),
    encoding: 'base64',
  })
  const mode = execFileSync('git', ['ls-files', '-s', '--', file.path], { encoding: 'utf8' })
    .split(' ')[0]
    .trim()
  tree.push({ path: file.path, mode: mode === '' ? '100644' : mode, type: 'blob', sha: blob.sha })
}

const baseCommit = gh(['api', `repos/${repo}/git/commits/${base}`])
const treeResult = gh(['api', '--method', 'POST', `repos/${repo}/git/trees`, '--input', '-'], {
  base_tree: baseCommit.tree.sha,
  tree,
})
const commit = gh(['api', '--method', 'POST', `repos/${repo}/git/commits`, '--input', '-'], {
  message,
  tree: treeResult.sha,
  parents: [base],
  author: {
    name: execFileSync('git', ['log', '-1', '--pretty=%an', 'HEAD'], { encoding: 'utf8' }).trim(),
    email: execFileSync('git', ['log', '-1', '--pretty=%ae', 'HEAD'], { encoding: 'utf8' }).trim(),
    date: execFileSync('git', ['log', '-1', '--pretty=%aI', 'HEAD'], { encoding: 'utf8' }).trim(),
  },
  committer: {
    name: execFileSync('git', ['log', '-1', '--pretty=%cn', 'HEAD'], { encoding: 'utf8' }).trim(),
    email: execFileSync('git', ['log', '-1', '--pretty=%ce', 'HEAD'], { encoding: 'utf8' }).trim(),
    date: execFileSync('git', ['log', '-1', '--pretty=%cI', 'HEAD'], { encoding: 'utf8' }).trim(),
  },
})
gh(['api', '--method', 'PATCH', `repos/${repo}/git/refs/heads/main`, '--input', '-'], {
  sha: commit.sha,
  force: false,
})
console.log('远端 main 已更新到 ' + commit.sha)
