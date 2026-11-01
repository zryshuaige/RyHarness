/**
 * 重复工具调用提醒的判定口径。
 *
 * 判定只有三条：工具名相同、参数逐字节相同、连续。改一条，结论就变——所以这三条各自
 * 都要有单独的用例盯着。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_REMINDERS, RepeatToolReminder, repeatReminderText } from '../src/index.ts'

const CALL_A = { name: 'fs_read', arguments: '{"path":"README.md"}' }
const CALL_B = { name: 'fs_read', arguments: '{"path":"CHANGELOG.md"}' }

describe('重复调用的判定', () => {
  it('同参连续两次：第二次起提醒', () => {
    const reminder = new RepeatToolReminder()
    const first = reminder.note(CALL_A)
    const second = reminder.note(CALL_A)

    expect(first.remind).toBe(false)
    expect(first.repeatCount).toBe(1)
    expect(second.remind).toBe(true)
    expect(second.repeatCount).toBe(2)
    expect(second.reminder).toContain('fs_read')
  })

  it('参数不同：不算重复，不提醒', () => {
    const reminder = new RepeatToolReminder()
    reminder.note(CALL_A)
    const other = reminder.note(CALL_B)

    expect(other.remind).toBe(false)
    expect(other.repeatCount).toBe(1)
  })

  it('工具名不同：参数一样也不算重复', () => {
    const reminder = new RepeatToolReminder()
    reminder.note(CALL_A)
    const other = reminder.note({ name: 'fs_write', arguments: CALL_A.arguments })

    expect(other.remind).toBe(false)
    expect(other.repeatCount).toBe(1)
  })

  it('参数是逐字节比较：JSON 排版不同就不算同一个调用', () => {
    const reminder = new RepeatToolReminder()
    reminder.note({ name: 'fs_read', arguments: '{"path":"a.md"}' })
    const spaced = reminder.note({ name: 'fs_read', arguments: '{ "path": "a.md" }' })

    expect(spaced.remind).toBe(false)
  })

  it('中间插入别的调用：链断掉，回到同一个调用也不提醒', () => {
    const reminder = new RepeatToolReminder()
    reminder.note(CALL_A)
    reminder.note(CALL_B)
    const back = reminder.note(CALL_A)

    expect(back.remind).toBe(false)
    expect(back.repeatCount).toBe(1)
  })

  it('三连击：第二次提醒，第三次仍然提醒（同一个链）', () => {
    const reminder = new RepeatToolReminder()
    reminder.note(CALL_A)
    expect(reminder.note(CALL_A).remind).toBe(true)
    const third = reminder.note(CALL_A)

    expect(third.remind).toBe(true)
    expect(third.repeatCount).toBe(3)
    expect(third.reminder).toContain('第 3 次')
  })
})

describe('提醒次数上限', () => {
  it('默认提醒两次之后就不再提醒', () => {
    const reminder = new RepeatToolReminder()
    const verdicts = [reminder.note(CALL_A), reminder.note(CALL_A), reminder.note(CALL_A), reminder.note(CALL_A)]

    expect(verdicts.map((v) => v.remind)).toEqual([false, true, true, false])
    expect(verdicts[3]?.reminder).toBe('')
    expect(DEFAULT_MAX_REMINDERS).toBe(2)
  })

  it('上限可以调成 1：只提醒一次', () => {
    const reminder = new RepeatToolReminder({ maxReminders: 1 })
    expect(reminder.note(CALL_A).remind).toBe(false)
    expect(reminder.note(CALL_A).remind).toBe(true)
    expect(reminder.note(CALL_A).remind).toBe(false)
  })

  it('上限调成 0：一次都不提醒（提醒是建议，不拦人）', () => {
    const reminder = new RepeatToolReminder({ maxReminders: 0 })
    reminder.note(CALL_A)
    expect(reminder.note(CALL_A).remind).toBe(false)
  })

  it('上限写成非数：按缺省值兜住，否则提醒会停不下来', () => {
    const reminder = new RepeatToolReminder({ maxReminders: Number.NaN })
    reminder.note(CALL_A)
    expect(reminder.note(CALL_A).remind).toBe(true)
    expect(reminder.note(CALL_A).remind).toBe(true)
    expect(reminder.note(CALL_A).remind).toBe(false)
  })

  it('链断之后重复次数归零，但提醒额度是总的', () => {
    const reminder = new RepeatToolReminder({ maxReminders: 1 })
    reminder.note(CALL_A)
    expect(reminder.note(CALL_A).remind).toBe(true)
    // 换了做法 → 链断 → 重复次数从头算。
    reminder.note(CALL_B)
    const afterBreak = reminder.note(CALL_A)

    expect(afterBreak.remind).toBe(false)
    expect(afterBreak.repeatCount).toBe(1)
    expect(afterBreak.remindedCount).toBe(1)
  })
})

describe('提醒文案与生命周期', () => {
  it('文案说清重复了几次和该干什么', () => {
    const text = repeatReminderText({ name: 'shell_exec', repeatCount: 2 })

    expect(text).toContain('shell_exec')
    expect(text).toContain('第 2 次')
    expect(text).toContain('不要')
  })

  it('文案可以换掉', () => {
    const reminder = new RepeatToolReminder({ formatReminder: () => '换个说法' })
    reminder.note(CALL_A)

    expect(reminder.note(CALL_A).reminder).toBe('换个说法')
  })

  it('reset 之后从零开始，提醒额度也回来了', () => {
    const reminder = new RepeatToolReminder({ maxReminders: 1 })
    reminder.note(CALL_A)
    expect(reminder.note(CALL_A).remind).toBe(true)
    reminder.reset()
    const afterReset = reminder.note(CALL_A)

    expect(afterReset.remind).toBe(false)
    expect(afterReset.repeatCount).toBe(1)
    expect(afterReset.remindedCount).toBe(0)
    expect(reminder.note(CALL_A).remind).toBe(true)
  })
})
