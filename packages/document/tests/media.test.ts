/**
 * 输入类型的白名单：认得出来的收，认不出来的拒。
 */
import { describe, expect, it } from 'vitest'
import { isSupportedMediaType, mediaTypeForName, resolveMediaType, supportedMediaTypeList } from '../src/index.ts'

describe('类型白名单', () => {
  it('Office 与 OpenDocument 的类型都在白名单里', () => {
    expect(isSupportedMediaType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    expect(isSupportedMediaType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true)
    expect(isSupportedMediaType('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true)
    expect(isSupportedMediaType('application/vnd.oasis.opendocument.text')).toBe(true)
    expect(isSupportedMediaType('application/rtf')).toBe(true)
  })

  it('PDF、图片、可执行文件一律不在白名单里', () => {
    expect(isSupportedMediaType('application/pdf')).toBe(false)
    expect(isSupportedMediaType('image/png')).toBe(false)
    expect(isSupportedMediaType('application/x-msdownload')).toBe(false)
  })

  it('按后缀认类型', () => {
    expect(mediaTypeForName('季度汇报.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(mediaTypeForName('报表.XLSX')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(mediaTypeForName('没有后缀')).toBeUndefined()
    expect(mediaTypeForName('trailing.')).toBeUndefined()
  })

  it('MIME 认不出来时退回按后缀判断', () => {
    expect(resolveMediaType('application/octet-stream', 'a.odt')).toBe('application/vnd.oasis.opendocument.text')
    expect(resolveMediaType('', 'a.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
  })

  it('MIME 明确不支持时不再看后缀（不猜）', () => {
    expect(resolveMediaType('image/png', 'a.docx')).toBeUndefined()
  })

  it('两处都认不出来 → undefined', () => {
    expect(resolveMediaType('application/octet-stream', 'a.bin')).toBeUndefined()
    expect(resolveMediaType('application/octet-stream')).toBeUndefined()
  })

  it('白名单清单能给人看', () => {
    expect(supportedMediaTypeList()).toContain('opendocument.text')
  })
})
