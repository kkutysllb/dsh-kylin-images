/**
 * 通道层契约。
 *
 * 零站点硬编码：所有连接信息来自设置页/API 写入的 vault。
 * M1 只实现 mock 通道；openai-images 与 task-images 适配器在 M2。
 */
import type { SizeStyle } from '../prompt/sizes.ts'

export const CHANNEL_KINDS = ['mock', 'openai-images', 'task-images'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export interface ChannelRecord {
  id: string
  label: string
  kind: ChannelKind
  baseUrl: string
  apiKey: string
  models: string[]
  /** 端点路径覆盖（聚合站路径千奇百怪，允许用户改）。 */
  endpointPath?: string
  sizeStyle?: SizeStyle
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 出口形态：apiKey 一律为脱敏串。 */
export interface PublicChannel extends Omit<ChannelRecord, 'apiKey'> {
  apiKey: string
  hasKey: boolean
}

export interface GenerateRequest {
  channelId: string
  model: string
  prompt: string
  negative?: string | undefined
  size?: string | undefined
  resolution?: string | undefined
  /** 单次生成的图片数量（MVP 上限 4）。 */
  count?: number | undefined
  seed?: number | undefined
  outputDir: string
  fileStem: string
}

export interface GeneratedImage {
  path: string
  bytes: number
  width?: number | undefined
  height?: number | undefined
}

export interface Quote {
  amount: number
  currency: string
  confidence: 'exact' | 'estimated' | 'unknown'
}

export interface GenerateResult {
  images: GeneratedImage[]
  quote: Quote
  channelId: string
  model: string
  durationMs: number
}

export interface ProviderHealth {
  ok: boolean
  detail: string
  models: string[]
  sizeStyle: SizeStyle
}

export interface ImageProvider {
  readonly kind: ChannelKind
  health(channel: ChannelRecord): Promise<ProviderHealth>
  generate(channel: ChannelRecord, request: GenerateRequest): Promise<GenerateResult>
}
