/**
 * 个人资料路由：用户在「我的」页给自己起的名字与头像。
 *
 * 落 `settings` 表而不是 localStorage——本机偏好（主题、自动朗读）存在浏览器侧
 * 没关系，但「我是谁」必须服务端也读得到：内核注入身份那一行（{@link identityLine}）
 * 与界面显示的是同一份数据。两边各存一份必然漂移，而漂移的表现是「界面上写着
 * 一个名字，agent 还在叫您」。
 * @module @ryharness/server/routes/profile
 */

import type { SessionStore } from '@ryharness/session'
import type { Router } from '../router.ts'
import { HttpRequestError, json } from '../router.ts'

/** 资料在 settings 表里的键。前缀留出空间给以后的本机偏好。 */
const PROFILE_PREFIX = 'profile.'

/** 名字长度上限：再长就不是名字而是段自述了。 */
const MAX_NAME_LENGTH = 32

/**
 * 换行、制表与 DEL 等控制符一律拒掉。名字会进系统提示，放行等于让用户自己往
 * 提示词里插一段指令——这既是注入面，也让注入块本身变得不可预测。
 *
 * 用码点判断而不是正则：这里要挡的是 C0 区整段，写成正则在各语言正则方言里
 * 的转义写法并不统一，漏一个字符就是漏一个控制符。
 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** 头像风格键的上限长度，与 DiceBear 风格 key 的量级对齐。 */
const MAX_AVATAR_LENGTH = 32

/** 一份资料。avatar 为空串表示「还没挑过」，界面据此显示占位。 */
export interface UserProfile {
  name: string
  avatar: string
}

/** 没存过资料时的缺省值。 */
export const DEFAULT_PROFILE: UserProfile = { name: '你', avatar: '' }

/** 从 settings 里读资料；没存过就给缺省，不在存储层编造。 */
export function readProfile(store: SessionStore): UserProfile {
  return {
    name: store.getSetting(`${PROFILE_PREFIX}name`) ?? DEFAULT_PROFILE.name,
    avatar: store.getSetting(`${PROFILE_PREFIX}avatar`) ?? DEFAULT_PROFILE.avatar,
  }
}

/**
 * 校验并写盘。没给某个字段就是「这个字段不改」，不是「改成缺省」。
 *
 * 空名字直接拒掉而不是落成空串：名字被清空后界面上会出现一个没有主语的用户，
 * 比缺省的「你」更糟。
 */
export function writeProfile(store: SessionStore, body: unknown): UserProfile {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const current = readProfile(store)
  const next: UserProfile = {
    name: profileName(record.name === undefined ? current.name : record.name),
    avatar: profileAvatar(record.avatar === undefined ? current.avatar : record.avatar),
  }
  store.setSetting(`${PROFILE_PREFIX}name`, next.name)
  store.setSetting(`${PROFILE_PREFIX}avatar`, next.avatar)
  return next
}

function profileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpRequestError(400, 'field "name" must be a string', 'PROFILE_BAD_REQUEST')
  }
  const name = value.trim()
  if (name.length === 0) {
    throw new HttpRequestError(400, '名字不能为空', 'PROFILE_BAD_REQUEST')
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpRequestError(400, `名字最长 ${MAX_NAME_LENGTH} 个字符`, 'PROFILE_BAD_REQUEST')
  }
  if (hasControlChars(name)) {
    throw new HttpRequestError(400, '名字里不能有换行或控制字符', 'PROFILE_BAD_REQUEST')
  }
  return name
}

function profileAvatar(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpRequestError(400, 'field "avatar" must be a string', 'PROFILE_BAD_REQUEST')
  }
  const avatar = value.trim()
  if (avatar.length > MAX_AVATAR_LENGTH) {
    throw new HttpRequestError(400, '头像标识太长', 'PROFILE_BAD_REQUEST')
  }
  if (hasControlChars(avatar)) {
    throw new HttpRequestError(400, '头像标识里不能有换行或控制字符', 'PROFILE_BAD_REQUEST')
  }
  return avatar
}

/**
 * 注入系统提示的身份句。
 *
 * 缺省名（「你」）不注入：把「与你对话的人叫「你」」塞进上下文只会让模型在每句话
 * 里别扭地重复一个代词。单独导出是为了能被测试直接断言，也让循环那侧不必知道
 * 这句话怎么拼的。
 */
export function identityLine(profile: UserProfile): string | undefined {
  if (profile.name === DEFAULT_PROFILE.name) return undefined
  return `与你对话的人叫「${profile.name}」。`
}

/** 注册两条路由。 */
export function registerProfileRoutes(router: Router, deps: { store: SessionStore }): void {
  router.get('/api/profile', async (_req, res) => {
    json(res, 200, { profile: readProfile(deps.store) })
  })

  router.patch('/api/profile', async (req, res) => {
    json(res, 200, { profile: writeProfile(deps.store, await req.body()) })
  })
}
