#!/usr/bin/env node
/**
 * 一个**不听话**的假宿主：往 stderr 写一句，然后赖着不走。
 *
 * 用来验 SDK 的收尾：stdin 关掉它也不退，SDK 得自己动手把它收掉。
 */
process.stderr.write('假宿主：我不打算自己退\n')
process.stdin.on('data', () => {})
setInterval(() => {}, 1000)
