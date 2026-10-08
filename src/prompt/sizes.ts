/**
 * 尺寸映射：把中性的「比例 + 分辨率」翻译成具体通道的请求字段。
 *
 * 上游与本地实测确认存在三种模型行为，必须分别覆盖：
 *   pixels            —— OpenAI 原生：size 是像素串（1024x1536）
 *   ratio-resolution  —— 聚合站（Apimart 形态）：size 是比例串 + 独立 resolution
 *   ignore            —— 模型自己决定（如 seedream 忽略 size）
 */
import type { AspectRatio, Resolution } from './vocab.ts'

export type SizeStyle = 'pixels' | 'ratio-resolution' | 'ignore'

export const SIZE_STYLES: readonly SizeStyle[] = ['pixels', 'ratio-resolution', 'ignore']

export interface SizeRequest {
  aspectRatio: AspectRatio
  resolution: Resolution
  sizeStyle: SizeStyle
}

export interface ProviderSize {
  size?: string
  resolution?: string
  width?: number
  height?: number
}

/** 像素形态的比例表（与 KSkills image-generation 脚本的映射保持一致并补全）。 */
const PIXEL_TABLE: Record<AspectRatio, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1536, height: 1024 },
  '3:2': { width: 1536, height: 1024 },
  '4:3': { width: 1536, height: 1024 },
  '9:16': { width: 1024, height: 1536 },
  '2:3': { width: 1024, height: 1536 },
  '3:4': { width: 1024, height: 1536 },
}

export function pixelSize(aspectRatio: AspectRatio): { width: number; height: number } {
  return PIXEL_TABLE[aspectRatio]
}

export function isSizeStyle(value: unknown): value is SizeStyle {
  return typeof value === 'string' && (SIZE_STYLES as readonly string[]).includes(value)
}

/** 中性尺寸请求 -> 通道请求字段。纯函数，同输入恒同输出。 */
export function toProviderSize(request: SizeRequest): ProviderSize {
  if (request.sizeStyle === 'ignore') return {}
  if (request.sizeStyle === 'ratio-resolution') {
    return { size: request.aspectRatio, resolution: request.resolution }
  }
  const px = pixelSize(request.aspectRatio)
  return { size: px.width + 'x' + px.height, width: px.width, height: px.height }
}
