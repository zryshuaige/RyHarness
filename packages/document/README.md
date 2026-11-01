# @ryharness/document

把**授权过的** Office 文件转成可复用的 PDF。分三块：

- **转换器契约**（`DocumentConverter`）：真正把字节变成 PDF 的那一层，宿主提供实现。
- **服务**（`DocumentConversionService`）：授权、类型白名单、大小与页数上限、时限、按内容 hash
  的缓存、产物落盘。
- **降级说法**（`engineUnavailableError`）：本机没装引擎时报一条能照着做的说明，而不是一句
  「转换失败」。

上游对照：dsh 的 `office-to-pdf`（授权过的 Office 字节 → 完整 PDF，带有界队列与缓存，底层是
LibreOffice kit，有原生引擎的机器用原生、没有的用 Node WASM）。本轮**不引 LibreOffice**，
转换器由宿主给；边界那部分（授权、白名单、上限、缓存、落盘）我们自己做齐。

## 怎么用

```ts
import { DocumentConversionService, unavailableConverter } from '@ryharness/document'

const service = new DocumentConversionService({
  // 宿主自己的转换器；本机没装引擎时用 unavailableConverter()
  converter: myConverter,
  outputDir: 'D:/RyHarness/data/documents', // PDF 落盘目录，宿主给
  policy: { maxInputBytes: 32 * 1024 * 1024, maxPages: 200, timeoutMs: 60_000 },
})

const outcome = await service.convert({
  source: { bytes: fileBytes, mediaType: 'application/octet-stream', name: '季度汇报.docx' },
  authorized: true, // 必须显式授权
})

outcome.pdf // PDF 字节
outcome.fromCache // 是不是命中了缓存
outcome.path // PDF 在盘上的路径
```

一次转换按固定顺序过一遍，顺序本身就是边界：

1. **授权**：没显式授权就不做——连文件大小都不量。
2. **类型白名单**：不在白名单里的类型直接拒，不猜。
3. **大小上限**：超了直接拒，不给引擎「试试看」的机会。
4. **缓存**：同样的内容转过一次就直接给缓存里的 PDF，不重复转。
5. **转换**：调宿主的转换器，带时限与取消。
6. **页数上限**：转换器报得出页数就判，超了这份产物不落盘。
7. **落盘**：PDF 写进宿主给的目录，并按内容 hash 记进缓存。

## 白名单

`docx` / `xlsx` / `pptx` / `odt` / `ods` / `odp` / `rtf` / `doc` / `xls` / `ppt`。

MIME 类型认不出来（`application/octet-stream`）时退回按文件名后缀判断；**MIME 明确是别的东西
就不再看后缀**（不猜）。`application/pdf`、`image/*`、可执行文件一律拒。

## 缓存

- 键是**内容 hash**：`sha256(转换器 id + MIME 类型 + 字节)`。内容一样就该命中；换了转换器或
  换了类型就不该命中（旧引擎的产物不保证新引擎也认）。
- 缓存文件落在**宿主给的目录**里（`cacheDir`，缺省与 `outputDir` 同一个），不落临时目录——
  临时目录会被清掉，缓存放那儿等于没有。
- 缓存文件坏了（不像 PDF）就当没命中，重新转一遍。

## 产物目录

`outputDir` 是**必填**的，而且默认**拒绝指向系统临时目录的路径**：临时目录会被清掉，PDF 放那儿
等于没放。真要那样（比如跑测试），显式声明 `allowTemporaryOutputDir: true`。

## 失败分类（机器码）

| 码 | 什么时候 |
|---|---|
| `NOT_AUTHORIZED` | 调用方没有显式授权——这一步什么都不做 |
| `UNSUPPORTED_TYPE` | 类型不在白名单里 |
| `INPUT_TOO_LARGE` | 超过字节上限 |
| `PAGE_LIMIT_EXCEEDED` | 超过页数上限（这份产物不落盘） |
| `ENGINE_UNAVAILABLE` | 本机没装转换引擎（文案里说清装什么） |
| `TIMEOUT` / `CANCELLED` | 到了时限 / 被取消 |
| `CONVERSION_FAILED` | 转换器自己报的错，或返回的不是一个 PDF |
| `OUTPUT_DIR_INVALID` | 产物目录没给，或指向系统临时目录 |
| `CACHE_FAILED` | 缓存写入失败 |
| `INVALID_INPUT` | 入参不合法（空内容之类） |

## 明确不做

| 不做 | 为什么 |
|---|---|
| 引 LibreOffice / LibreOffice kit / Node WASM | 几百 MB，装机与分发都不成比例。转换器由宿主给 |
| OCR | 扫描件转可搜索 PDF 是另一件事（要 OCR 引擎） |
| 图片转 PDF | 同上 |
| 有界队列 / 并发闸门 | 上游 `office-to-pdf` 有「有界队列」；本轮没有并发控制，宿主自己排队 |

## 导出

| 导出 | 一句话 |
|---|---|
| `DocumentConversionService` | 转换服务（授权 → 白名单 → 上限 → 缓存 → 转换 → 落盘） |
| `DocumentConverter` | 转换器契约（宿主实现） |
| `DocumentSource` / `DocumentConvertInput` / `DocumentConvertResult` | 输入与产出的形状 |
| `DocumentPolicy` / `resolvePolicy` / `DEFAULT_DOCUMENT_POLICY` | 边界参数（字节 / 页数 / 时限） |
| `checkAuthorized` / `checkInputSize` / `checkPageCount` | 三条边界判定 |
| `SUPPORTED_MEDIA_TYPES` / `isSupportedMediaType` / `resolveMediaType` / `mediaTypeForName` | 类型白名单与判定 |
| `DocumentPdfCache` | 按内容 hash 索引的 PDF 缓存 |
| `engineUnavailableError` / `unavailableConverter` / `ENGINE_INSTALL_HINT` | 没装引擎时怎么报 |
| `DocumentError` / `isDocumentError` / `DocumentErrorCode` | 带机器码的错误与判定 |

## 测试

```sh
npx vitest run packages/document
```

测试用一个**假转换器**（真的被调用，记录调用次数与入参）与临时目录：所以能断言「没授权时转换器
一次都没被调」「同样的输入第二次不再调」「页数超限时不落盘」这类具体行为，而不是只断言「没抛错」。
