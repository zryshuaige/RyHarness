/**
 * 契约里跨域共用的小构造子。
 *
 * schemastery 的容器工厂带**隐式默认**（vendor index.ts 的工厂循环：object/dict→{}、
 * array/tuple→[]、bitset→0）——那是给配置面设计的语义，落到 REST 契约会把「没传
 * 这个字段」变成「传了个空值」，PATCH 这类「只在传了才改」的端点直接被破坏。这里
 * 绕开工厂、直接字面量构造（`Schema` 构造器就是 Object.assign），把缺省语义要回来：
 * 缺省 = 字段缺失（undefined），传了才参与校验。
 * @module @ryharness/server/contract/util
 */

import z from '@ryharness/schemastery'

/**
 * 可缺省的列表：缺省 = undefined（不是 []）。
 * @param inner - 元素 schema（z.string()、union 等任意已构造的 schema 值）。
 */
export function optionalArrayOf<X extends z>(inner: X): z<Schemastery.TypeS<X>[] | undefined> {
  return z<Schemastery.TypeS<X>[] | undefined>({
    type: 'array',
    inner,
    meta: { default: undefined },
  })
}

/** 可缺省的字符串列表：缺省 = undefined（不是 []）。 */
export function optionalStringArray(): z<string[] | undefined> {
  return optionalArrayOf(z.string())
}
