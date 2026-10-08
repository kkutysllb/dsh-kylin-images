/**
 * 极简 PNG 编码器（真彩色 8bit，filter 0），零依赖。
 *
 * 用途：mock provider 的零 key 全链路自检需要产出**真实可解码**的图片，
 * 而不是假文件——否则会话模型看不到图、后续工具也读不了。
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE: number[] = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table.push(c >>> 0)
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    const index = (crc ^ byte) & 0xff
    const entry = CRC_TABLE[index] ?? 0
    crc = entry ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface Rgb { r: number; g: number; b: number }

/** 逐像素取色的画布函数：返回 [r,g,b]，越界由调用方保证。 */
export type PixelShader = (x: number, y: number) => Rgb

/** 把着色函数渲染成 PNG 字节。 */
export function encodePng(width: number, height: number, shader: PixelShader): Buffer {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      const rgb = shader(x, y)
      const at = rowStart + 1 + x * 3
      raw[at] = rgb.r & 0xff
      raw[at + 1] = rgb.g & 0xff
      raw[at + 2] = rgb.b & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function mix(base: Rgb, delta: number): Rgb {
  return {
    r: Math.max(0, Math.min(255, Math.round(base.r + delta))),
    g: Math.max(0, Math.min(255, Math.round(base.g + delta))),
    b: Math.max(0, Math.min(255, Math.round(base.b + delta))),
  }
}

/** 确定性占位图：色相由 seed 决定，叠一层斜纹便于肉眼确认「确实出图了」。 */
export function placeholderPng(width: number, height: number, seed: number, label?: string): Buffer {
  const base: Rgb = {
    r: 40 + ((seed * 37) % 160),
    g: 40 + ((seed * 91) % 160),
    b: 40 + ((seed * 53) % 160),
  }
  const band = Math.max(8, Math.floor(Math.min(width, height) / 16))
  return encodePng(width, height, (x, y) => {
    const stripe = (Math.floor((x + y) / band) % 2) === 0 ? 12 : -12
    const border = x < 4 || y < 4 || x >= width - 4 || y >= height - 4 ? -30 : 0
    return mix(base, stripe + border)
  })
}

/** 读 PNG 的 IHDR 宽高（供测试与工具做轻量校验）。 */
export function readPngSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24) return undefined
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}
