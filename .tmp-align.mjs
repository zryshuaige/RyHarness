import { execFileSync } from 'node:child_process'

const remote = '69c0e86ac7715b098c68445c2c400196c347843e'
const raw = execFileSync('gh', ['api', `repos/zryshuaige/RyHarness/git/commits/${remote}`], { encoding: 'utf8' })
const commit = JSON.parse(raw)
const local = execFileSync('git', ['cat-file', '-p', 'HEAD'], { encoding: 'utf8' })

const localLines = local.split('\n')
const tree = localLines[0].slice('tree '.length)
const parent = localLines[1].slice('parent '.length)
const authorLine = localLines[2]
const committerLine = localLines[3]
const authorName = authorLine.replace(/^author (.*) \d+ [+-]\d{4}$/, '$1')
const committerName = committerLine.replace(/^committer (.*) \d+ [+-]\d{4}$/, '$1')
const epoch = authorLine.match(/ (\d+) [+-]\d{4}$/)[1]
const apiEpoch = Math.floor(Date.parse(commit.author.date) / 1000).toString()
const message = localLines.slice(5).join('\n')

const dates = [apiEpoch + ' +0000', apiEpoch + ' +0800', epoch + ' +0000', epoch + ' +0800']
const messages = [message, message + '\n', message.trimEnd(), message.trimEnd() + '\n']

let hit = ''
for (const a of dates) {
  for (const c of dates) {
    for (const m of messages) {
      const text = `tree ${tree}\nparent ${parent}\nauthor ${authorName} ${a}\ncommitter ${committerName} ${c}\n\n${m}`
      const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
        encoding: 'utf8',
        input: text,
      }).trim()
      if (sha === remote) hit = text
    }
  }
}

if (hit.length === 0) {
  console.log('32 种组合都没对上。')
  console.log('远端作者：' + commit.author.name + ' <' + commit.author.email + '> ' + commit.author.date)
  console.log('远端提交者：' + commit.committer.name + ' <' + commit.committer.email + '> ' + commit.committer.date)
  console.log('远端消息长度：' + commit.message.length)
  console.log('本地消息长度：' + message.length)
  process.exit(1)
}

execFileSync('git', ['update-ref', 'refs/heads/main', remote])
execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remote])
execFileSync('git', ['tag', '-f', 'v0.4.0', remote])
const status = execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim()
console.log('本地 HEAD：' + execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
console.log('工作区：' + (status.length === 0 ? '干净' : status))
