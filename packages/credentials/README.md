# @ryharness/credentials

凭据引用与授权流程：配置里**不存明文密钥，只存引用**；要拿真密钥，得有人点头。

上游对照：dsh 的 `credentials/`（存与取）、`credentials-local/`（本机私有存储）、
`authorization/`（要人点头的流程）三个包。我们把后两件事收进一个包，但**不碰密钥
落盘**——密钥归宿主那个加密存储管（桌面端走系统密钥库，见
`apps/server/src/config.ts` 的 `SecretCodec`），本包只管「引用」与「授权」。

## 引用里没有密钥

```ts
import { CredentialRegistry } from '@ryharness/credentials'

const registry = new CredentialRegistry({
  requestApproval: async (request) => {
    // request.purpose 是「要干什么」，弹窗上展示的就是它
    return await askUser(request)
  },
  resolveSecret: async (ref) => {
    // 密钥由宿主自己的解码器取：这里只把「哪个引用」递过去
    return decodeSecret(ref.id)
  },
})

registry.register({ providerId: 'github', label: 'GitHub 主账号', hint: '...1234' })
// → { id: 'cred-…', providerId: 'github', label: 'GitHub 主账号', hint: '...1234', createdAt: 1_700_000_000_000 }
```

登记时硬塞密钥会被挡下（`SECRET_IN_REGISTRATION`）：`secret` / `value` / `apiKey` /
`token` / `password` / `key` 这些字段名一个都不许出现。引用里出现明文密钥，就等于把
「配置不存明文」这条规矩废了。

## 取号要走授权

```ts
const secret = await registry.use({
  credentialId: 'cred-…',
  purpose: '拉取私有仓库', // 要干什么：审批弹窗上展示的就是这句
  requester: 'plugin:web', // 谁要：审计要记
})
```

一步都不能省：

1. 引用得存在，也没被吊销；
2. **人要点头**：宿主给的 `requestApproval` 批了才往下走；
3. 批的范围：「这一次」还是「一段时间内都批」。后者记到期时间，过期要重批；
4. 留一条审计：谁、什么时候、为了什么、批没批。

### 失败要如实失败

| 情况 | 错误码 | 说明 |
|---|---|---|
| 人没点头 | `DENIED` | 带上不批的理由 |
| 审批函数抛错 | `APPROVAL_FAILED` | 带上原始原因 |
| 等人点头等太久 | `APPROVAL_TIMEOUT` | 注册表侧的 `approvalTimeoutMs`（不给 = 不限时） |
| 批了但密钥取不到 | `SECRET_UNAVAILABLE` | 空串也算取不到 |

最坏的一种是「假装成功」——调用方以为拿到密钥了，实际拿到一个空串，于是请求发出去
被服务端拒了，而日志里看不出是哪一步出的问题。所以这几种情况全都以异常结束。

### 授权范围与过期

```ts
requestApproval: async () => ({ approved: true, scope: 'until', expiresAt: Date.now() + 600_000 })
```

- `scope: 'once'`（缺省）：下一次还要再问。
- `scope: 'until'` + `expiresAt`：有效期内不再问人；过期了自动作废，要再批一次。
- `scope: 'until'` 但**没给**到期时间：按「这一次」处理——宁可多问一次，也不要一份
  说不出期限的长期授权。

吊销引用时，之前批的那段时间内授权也一并作废。

## 审计

```ts
registry.audit() // 全部记录
registry.auditFor('cred-…') // 某个引用的记录
```

每条记录带 `requester`（谁要）、`purpose`（为了什么）、`at`（什么时候）、`approved`
（批没批）、`outcome`（`granted` / `denied` / `failed`）。**没批的也要记**——「谁想要、
没让他要」正是事后最想看的那一条。

审计记录目前只在内存里（进程退出即丢）。要留档，宿主自己把它写到别处去。

## 落盘

引用（id、供应商、名字、末四位）落盘，**密钥不落盘**。引用要落盘，是因为配置里写着
`credentialId: "gh-main"`，重启之后这个 id 得还对得上那个引用。

`FileCredentialStore` 走「临时文件 + rename」，坏文件当没有——一份配置不该挡住启动。

## 导出

| 导出 | 一句话 |
|---|---|
| `CredentialRegistry` | 注册表（`register` / `list` / `get` / `revoke` / `use` / `audit`） |
| `CredentialRef` | 一个凭据的**引用**（不含密钥） |
| `CredentialRegistration` | 登记引用时给的东西 |
| `CredentialUseRequest` | 一次取用请求（用哪个、为了什么、谁要） |
| `ApprovalDecision` / `ApprovalRequest` / `ApprovalScope` | 审批的结果、请求与范围 |
| `RequestApproval` / `ResolveSecret` | 宿主给的两个回调（问人批、取真密钥） |
| `CredentialAuditEntry` | 一条审计记录 |
| `CredentialError` | 领域错误（`DENIED` / `APPROVAL_TIMEOUT` / …） |
| `MemoryCredentialStore` / `FileCredentialStore` | 引用的存取后端 |

## 边界

- 不存密钥、不懂加密：密钥的落盘与解密归宿主。
- 不管界面怎么问人：`requestApproval` 是宿主给的回调，怎么弹窗是宿主的事。
- 不管配置怎么引用凭据：配置里写哪个 id 是宿主的事。
