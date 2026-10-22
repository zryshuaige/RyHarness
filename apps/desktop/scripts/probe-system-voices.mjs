/**
 * 查本机 speechSynthesis 真实返回的音色名（验证"前缀匹配"修的是不是真问题）。
 *
 * 用法：electron scripts/probe-system-voices.mjs
 */
import { app, BrowserWindow } from 'electron'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 200 })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const voices = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const read = () => window.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
      const first = read();
      if (first.length > 0) return resolve(first);
      window.speechSynthesis.addEventListener('voiceschanged', () => resolve(read()), { once: true });
      setTimeout(() => resolve(read()), 2000);
    })`,
  )
  console.log(`[voices] 本机 ${voices.length} 条：`)
  for (const voice of voices) {
    console.log(`  ${voice.lang.padEnd(12)} ${voice.name}`)
  }
  const wanted = [
    'Microsoft Huihui Desktop',
    'Microsoft Yaoyao Desktop',
    'Microsoft Kangkang Desktop',
    'Microsoft Yunxi Desktop',
  ]
  console.log('[voices] 目录里的四条能不能对上：')
  for (const name of wanted) {
    const exact = voices.find((v) => v.name === name)
    const prefixed = voices.find((v) => v.name.startsWith(name))
    console.log(`  ${name} → 精确 ${exact === undefined ? '无' : '有'} / 前缀 ${prefixed === undefined ? '无' : '有'}`)
  }
  app.quit()
})
