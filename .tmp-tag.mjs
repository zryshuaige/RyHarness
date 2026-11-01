import { execFileSync } from 'node:child_process'

const sha = '69c0e86ac7715b098c68445c2c400196c347843e'

function gh(args, input) {
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(out)
}

const tag = gh(['api', '--method', 'POST', 'repos/zryshuaige/RyHarness/git/tags', '--input', '-'], {
  tag: 'v0.4.0',
  message: 'v0.4.0',
  object: sha,
  type: 'commit',
})
console.log('tag 对象：' + tag.sha)

const ref = gh(['api', '--method', 'POST', 'repos/zryshuaige/RyHarness/git/refs', '--input', '-'], {
  ref: 'refs/tags/v0.4.0',
  sha: tag.sha,
})
console.log('tag 引用：' + ref.ref + ' -> ' + ref.object.sha)
