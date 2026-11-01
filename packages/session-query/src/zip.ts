/**
 * 自己拼 ZIP：不引外部依赖。
 *
 * 为什么不用现成的库：会话导出要在桌面端跑，引入一个压缩库就多一份要跟着
 * 应用打包、要跟着升级的依赖；而 ZIP 这件事本身不复杂——本地文件头 + 数据 +
 * 中央目录 + 结尾记录，四个部分，写出来两百行。
 *
 * 压缩用 `node:zlib` 的 raw deflate（ZIP 的方法 8 要的是裸 deflate 数据，
 * 不是 zlib 头尾那层）。CRC32 按 IEEE 算——解压工具拿它校验，错了就报「文件
 * 损坏」，所以这 32 位不能糊弄。
 * @module @ryharness/session-query/zip
 */

import { deflateRawSync } from 'node:zlib'

/** 一个待打包的文件。 */
export interface ZipEntry {
  /** 包内的路径（用 `/` 分隔）。 */
  path: string
  /** 文件内容。 */
  data: Buffer
}

/** 打包参数。 */
export interface ZipOptions {
  /** 文件时间戳（写进 ZIP 记录）；缺省用当前时间。 */
  modifiedAt?: Date
}

/** ZIP 里各部分的签名。 */
const LOCAL_HEADER_SIGNATURE = 0x04_03_4b_50
const CENTRAL_HEADER_SIGNATURE = 0x02_01_4b_50
const END_OF_CENTRAL_SIGNATURE = 0x06_05_4b_50

/** 压缩方法 8 = deflate。 */
const METHOD_DEFLATE = 8

/** 通用标志位第 11 位 = 文件名是 UTF-8。 */
const FLAG_UTF8 = 0x08_00

/** CRC32 表（IEEE 多项式 0xEDB88320）。 */
const CRC_TABLE = buildCrcTable()

/**
 * 把若干文件打成一个 ZIP。
 *
 * @param entries - 待打包的文件（顺序即包内顺序）。
 * @param options - 打包参数。
 * @returns ZIP 字节。
 */
export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Buffer {
  const modifiedAt = options.modifiedAt ?? new Date()
  const { dosTime, dosDate } = toDosTimestamp(modifiedAt)
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8')
    const raw = entry.data
    const compressed = deflateRawSync(raw, { level: 9 })
    const crc = crc32(raw)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(METHOD_DEFLATE, 8)
    header.writeUInt16LE(dosTime, 10)
    header.writeUInt16LE(dosDate, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
    centralHeader.writeUInt16LE(0x03_14, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(FLAG_UTF8, 8)
    centralHeader.writeUInt16LE(METHOD_DEFLATE, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)

    offset += header.length + name.length + compressed.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuffer, end])
}

/** CRC32（IEEE）：算一个缓冲区的校验值。 */
export function crc32(data: Buffer): number {
  let crc = 0xff_ff_ff_ff
  for (const byte of data) {
    const index = (crc ^ byte) & 0xff
    crc = (CRC_TABLE[index] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}

/** 建 CRC32 查表。 */
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

/** 时间戳转 DOS 格式（ZIP 记录用的那套两位数年份）。 */
function toDosTimestamp(date: Date): { dosTime: number; dosDate: number } {
  const year = date.getFullYear()
  // DOS 格式最早只到 1980；早于它的时间一律记成 1980-01-01。
  const safeYear = Math.max(1980, year)
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const dosDate = ((safeYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosTime: dosTime & 0xff_ff, dosDate: dosDate & 0xff_ff }
}
