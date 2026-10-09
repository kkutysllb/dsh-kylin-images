/**
 * 通道层契约。
 *
 * 零站点硬编码：所有连接信息来自设置页/API 写入的 vault。
 * M1 只实现 mock 通道；openai-images 与 task-images 适配器在 M2。
 */
import type { SizeStyle } from '../prompt/sizes.ts'
import type { HttpOptions } from './http.ts'
import type { RouteReport } from './route-probe.ts'

export const CHANNEL_KINDS = ['mock', 'openai-images', 'openai-responses', 'task-images'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export interface ChannelPricing {
  currency?: string
  '1k'?: number
  '2k'?: number
  '4k'?: number
  default?: number
}

export interface ChannelRecord {
  id: string
  label: string
  kind: ChannelKind
  baseUrl: string
  apiKey: string
  models: string[]
  /** 端点路径覆盖（聚合站路径千奇百怪，允许用户改）。 */
  endpointPath?: string
  /** 异步任务查询路径模板，{id} 为占位符；缺省 /v1/tasks/{id}。 */
  statusPath?: string
  /** 通道级价目覆盖（优先于内置目录）。 */
  pricing?: ChannelPricing
  /** 该通道的请求超时与重试次数。 */
  timeoutMs?: number
  retries?: number
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
  /** 质量档位（low/medium/high/auto）；按通道能力生效。 */
  quality?: string | undefined
  seed?: number | undefined
  /** 参考图本地路径（跨页一致性用；仅在通道能力允许时注入）。 */
  referenceImages?: string[] | undefined
  outputDir: string
  fileStem: string
  /** 测试注入点：替换 fetch / sleep / 轮询节奏。 */
  http?: HttpOptions | undefined
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
  /** 通道实际返回的尺寸（部分模型忽略请求尺寸）。 */
  actualSize?: string | undefined
  /** 上游原始响应（诊断用，不落盘）。 */
  raw?: unknown
}

export interface ProviderHealth {
  ok: boolean
  detail: string
  models: string[]
  sizeStyle: SizeStyle
  /** 端点可达性证据（零成本探测）；通道未配置 Base URL 时为 undefined。 */
  route?: RouteReport | undefined
}

export interface ProbeResult {
  ok: boolean
  /** 鉴权结论：ok / invalid / unknown（部分中转不校验 /models 的 token）。 */
  auth: 'ok' | 'invalid' | 'unknown'
  models: string[]
  endpointStyle: 'sync-images' | 'task-images' | 'responses-images'
  sizeStyle: SizeStyle
  /** 小额实跑结论（未跑时为 undefined）。 */
  realRun?: { tried: boolean; ok: boolean; note: string } | undefined
  /** 端点可达性证据（零成本探测），避免只看 /v1/models 的假绿灯。 */
  route?: RouteReport | undefined
  detail: string
}

export interface ImageProvider {
  readonly kind: ChannelKind
  health(channel: ChannelRecord, http?: HttpOptions): Promise<ProviderHealth>
  generate(channel: ChannelRecord, request: GenerateRequest): Promise<GenerateResult>
  /** 通道探测：模型枚举 + 鉴权 + 端点风格 + 可选小额实跑。 */
  probe?(channel: ChannelRecord, options?: { realRun?: boolean; http?: HttpOptions; outputDir?: string }): Promise<ProbeResult>
}