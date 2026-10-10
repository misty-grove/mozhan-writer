/**
 * zip 读写（零依赖）
 *
 * 为什么自己写：整个应用只有两处需要 zip —— EPUB 导出与整库备份，
 * 加起来不到 200 行，为它引一个压缩库不划算，也和「离线即装即用、体积小」的取向冲突。
 *
 * 写：一律 store（不压缩）。EPUB 要求 mimetype 不压缩，备份也宁可快一点、笨一点。
 * 读：支持 store 与 deflate —— 别人（或系统资源管理器）重新打包过的 zip 也要能读回来，
 *     解压用浏览器/Node 都自带的 DecompressionStream('deflate-raw')。
 */

/* ------------------------------------------------------------------ 公共工具 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
}
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
function readU16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}
function readU32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

export const textBytes = (s: string) => new TextEncoder().encode(s)
export const bytesText = (b: Uint8Array) => new TextDecoder('utf-8').decode(b)

/* ------------------------------------------------------------------ 写 */

export interface ZipEntry {
  name: string
  data: Uint8Array
  /** mimetype 这类文件必须不压缩且排第一 */
  raw?: boolean
}

interface Prepared {
  name: string
  comp: Uint8Array
  size: number
  crc: number
  method: number
}

/**
 * 通用位标记：bit 11 = 文件名/注释是 UTF-8。
 * 必须置上 —— 我们的条目名里有「正文/第001章 启程.md」这种中文，
 * 不声明 UTF-8 的话，Windows 资源管理器 / 7-Zip 会按 CP437 解，解出来是乱码目录名。
 */
const FLAG_UTF8 = 0x0800

function assemble(prepared: Prepared[], mime: string): Blob {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const e of prepared) {
    const nameBytes = textBytes(e.name)
    const localHeader = concat([
      u32(0x04034b50),
      u16(20),
      u16(FLAG_UTF8),
      u16(e.method),
      u16(0),
      u16(0),
      u32(e.crc),
      u32(e.comp.length),
      u32(e.size),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    ])
    locals.push(localHeader, e.comp)

    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(FLAG_UTF8),
        u16(e.method),
        u16(0),
        u16(0),
        u32(e.crc),
        u32(e.comp.length),
        u32(e.size),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes
      ])
    )

    offset += localHeader.length + e.comp.length
  }

  const central = concat(centrals)
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(prepared.length),
    u16(prepared.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ])

  // TS 5.7 起 Uint8Array 带 buffer 泛型，统一断言成 BlobPart 免得各版本吵
  return new Blob([concat(locals), central, end] as unknown as BlobPart[], { type: mime })
}

/** 生成 zip（全部 store，不压缩）。EPUB 走这条，mimetype 必须不压缩。 */
export function makeZip(entries: ZipEntry[], mime = 'application/zip'): Blob {
  return assemble(
    entries.map((e) => ({ name: e.name, comp: e.data, size: e.data.length, crc: crc32(e.data), method: 0 })),
    mime
  )
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw')
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 生成 zip，文本条目用 deflate 压缩。
 * 备份走这条：正文是纯文本，能压掉一大半；压不动（反而变大）的条目自动退回 store。
 */
export async function makeZipCompressed(entries: ZipEntry[], mime = 'application/zip'): Promise<Blob> {
  const prepared: Prepared[] = []
  for (const e of entries) {
    const crc = crc32(e.data)
    let comp = e.data
    let method = 0
    if (!e.raw && e.data.length > 256) {
      try {
        const z = await deflateRaw(e.data)
        if (z.length < e.data.length) {
          comp = z
          method = 8
        }
      } catch {
        /* 环境不支持压缩流就退回 store，不影响正确性 */
      }
    }
    prepared.push({ name: e.name, comp, size: e.data.length, crc, method })
  }
  return assemble(prepared, mime)
}

/* ------------------------------------------------------------------ 读 */

export interface UnzipEntry {
  name: string
  data: Uint8Array
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 找到中央目录结束记录（EOCD），从后往前扫 */
function findEocd(b: Uint8Array): number {
  const min = Math.max(0, b.length - 66000)
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i
  }
  return -1
}

/**
 * 解 zip。支持 store(0) 与 deflate(8)；遇到不支持的压缩方式直接跳过并在 skipped 里报出来，
 * 不静默丢文件。
 */
export async function readZip(bytes: Uint8Array): Promise<{ entries: UnzipEntry[]; skipped: string[] }> {
  const eocd = findEocd(bytes)
  if (eocd < 0) throw new Error('不是有效的 zip 文件（没找到中央目录）')

  const count = readU16(bytes, eocd + 10)
  let p = readU32(bytes, eocd + 16)
  const entries: UnzipEntry[] = []
  const skipped: string[] = []

  for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
    if (readU32(bytes, p) !== 0x02014b50) break
    const method = readU16(bytes, p + 10)
    const compSize = readU32(bytes, p + 20)
    const nameLen = readU16(bytes, p + 28)
    const extraLen = readU16(bytes, p + 30)
    const commentLen = readU16(bytes, p + 32)
    const localOffset = readU32(bytes, p + 42)
    const name = bytesText(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // 目录项

    // 本地头里的 name/extra 长度可能和中央目录不同（有 data descriptor 时），以本地头为准算数据起点
    if (readU32(bytes, localOffset) !== 0x04034b50) {
      skipped.push(name)
      continue
    }
    const lNameLen = readU16(bytes, localOffset + 26)
    const lExtraLen = readU16(bytes, localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    const rawData = bytes.subarray(start, start + compSize)

    if (method === 0) {
      entries.push({ name, data: rawData })
    } else if (method === 8) {
      try {
        entries.push({ name, data: await inflateRaw(rawData) })
      } catch {
        skipped.push(name)
      }
    } else {
      skipped.push(name) // 不认识的压缩方式：说清楚，别装作成功
    }
  }

  if (!entries.length && !skipped.length) throw new Error('压缩包里没有可读文件')
  return { entries, skipped }
}
