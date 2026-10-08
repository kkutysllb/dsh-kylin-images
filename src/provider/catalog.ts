/**
 * 内置模型目录：按模型名推断能力与价目。
 *
 * 定位（对齐 dsh-video-generator §4.2 的两层查表）：**用户覆盖 > 内置缺省 > unknown**。
 * 这里只提供缺省值，任何一项都能被通道级配置覆盖；不内置任何站点信息。
 *
 * 价目快照：2026-08 / 2026-10 上游与实测公开数据，人民币口径，仅作预估；
 * 真实计费以通道方为准（confidence 因此标 estimated）。
 */
import type { SizeStyle } from '../prompt/sizes.ts'

export interface ModelPriceTable {
  currency: string
  /** 按分辨率档位；缺失时回落 default。 */
  byResolution?: Record<string, number>
  default?: number
}

export interface ModelSpec {
  /** 小写子串匹配；按目录顺序首个命中生效。 */
  match: readonly string[]
  /** 建议的尺寸风格（通道显式配置优先）。 */
  sizeStyle: SizeStyle
  /** 是否有原生负向字段（当前主流图像 API 都没有，负向要折进提示词）。 */
  supportsNegative: boolean
  supportsReferenceImage: boolean
  supportsSeed: boolean
  price: ModelPriceTable | null
  note: string
}

const USD_TO_CNY = 7.2

function usdToCny(value: number): number {
  return Math.round(value * USD_TO_CNY * 1000) / 1000
}

/** 顺序敏感：越具体的家族越靠前。 */
export const BUILTIN_MODELS: readonly ModelSpec[] = [
  {
    match: ['mock-image', 'mock'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: true, supportsReferenceImage: false, supportsSeed: true,
    price: { currency: 'CNY', default: 0 },
    note: '本地 mock：零密钥占位图，不发起网络请求',
  },
  {
    match: ['gpt-image-2'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: false,
    price: { currency: 'CNY', byResolution: { '1k': usdToCny(0.010625), '2k': usdToCny(0.0175), '4k': usdToCny(0.02625) } },
    note: '聚合站比例+分辨率契约（size=1:1, resolution=1k）；产物为带 expires_at 的签名 URL，必须立刻落盘',
  },
  {
    match: ['gpt-image-2.5', 'gpt-image-2-4k'],
    sizeStyle: 'pixels',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: false,
    price: null,
    note: '中转站命名的新一代图像模型（实测走 Responses API 的 image_generation 工具）；价目随站点差异大，未内置',
  },
  {
    match: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image', 'dall-e'],
    sizeStyle: 'pixels',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: false,
    price: { currency: 'CNY', byResolution: { '1k': usdToCny(0.011), '2k': usdToCny(0.042), '4k': usdToCny(0.167) } },
    note: 'OpenAI 原生像素尺寸（1024x1536 等）',
  },
  {
    match: ['seedream-5', 'seedream-4-5', 'seedream-4', 'seedream-3', 'seedream'],
    sizeStyle: 'ignore',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: true,
    price: { currency: 'CNY', default: 0.22 },
    note: '实测忽略 size 并返回 2k；交付为签名 URL',
  },
  {
    match: ['qwen-image-max'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: true,
    price: { currency: 'CNY', default: 0.5 },
    note: '价目偏高，批量前先确认预算',
  },
  {
    match: ['qwen-image'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: true,
    price: { currency: 'CNY', default: 0.2 },
    note: '通义千问图像系',
  },
  {
    match: ['z-image'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: true,
    price: { currency: 'CNY', default: 0.10 },
    note: '低价快速档',
  },
  {
    match: ['wan2.7-image', 'wanx', 'wan2.5-image', 'wan-image'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: true,
    price: null,
    note: '万相图像系；注意与万相视频系（i2v/t2v）区分',
  },
  {
    match: ['grok-imagine-image', 'grok-imagine'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: false, supportsSeed: false,
    price: { currency: 'CNY', default: 0.07 },
    note: '低价档，上游易饱和（429）',
  },
  {
    match: ['nano-banana', 'gemini', 'imagen'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: false,
    price: null,
    note: 'Gemini 系图像模型；价目随中转站差异大，未内置',
  },
  {
    match: ['flux'],
    sizeStyle: 'pixels',
    supportsNegative: true, supportsReferenceImage: true, supportsSeed: true,
    price: null,
    note: '部分自建/中转端点支持 negative_prompt 与 seed',
  },
  {
    match: ['midjourney', 'mj-'],
    sizeStyle: 'ratio-resolution',
    supportsNegative: false, supportsReferenceImage: true, supportsSeed: false,
    price: null,
    note: '多为第三方代理实现，端点风格差异大，务必先探测',
  },
]

export const UNKNOWN_MODEL_SPEC: ModelSpec = {
  match: [],
  sizeStyle: 'ratio-resolution',
  supportsNegative: false,
  supportsReferenceImage: false,
  supportsSeed: false,
  price: null,
  note: '未收录的模型：尺寸风格与能力按通道配置为准，价目未知（未知价一律先确认）',
}

export function inferModel(model: string | undefined): ModelSpec | undefined {
  if (typeof model !== 'string') return undefined
  const name = model.trim().toLowerCase()
  if (name === '') return undefined
  for (const spec of BUILTIN_MODELS) {
    if (spec.match.some((token) => name.includes(token))) return spec
  }
  return undefined
}

export function resolveModelSpec(model: string | undefined): ModelSpec {
  return inferModel(model) ?? UNKNOWN_MODEL_SPEC
}

/**
 * 通道未声明模型、用户也没选默认模型时的兜底模型名。
 *
 * 没有这层兜底，mock 通道会因为 model='' 查不到价目而每次都要用户确认——
 * 这是 M2 联调时抓到的真实体验缺陷。
 */
export function defaultModelForKind(kind: string): string {
  if (kind === 'mock') return 'mock-image-v1'
  return ''
}

/** 通道类型给出的尺寸风格缺省（优先于模型建议）。 */
export function defaultSizeStyleForKind(kind: string): SizeStyle {
  if (kind === 'openai-images' || kind === 'openai-responses') return 'pixels'
  return 'ratio-resolution'
}

export function effectiveSizeStyle(channelSizeStyle: SizeStyle | undefined, kind: string, model: string | undefined): SizeStyle {
  if (channelSizeStyle !== undefined) return channelSizeStyle
  if (kind === 'openai-images' || kind === 'openai-responses') return 'pixels'
  const spec = inferModel(model)
  if (spec !== undefined) return spec.sizeStyle
  return defaultSizeStyleForKind(kind)
}

/** 给设置页/文档用的一行摘要。 */
export function modelCatalogText(): string {
  return BUILTIN_MODELS.map((spec) => spec.match[0] + ' -> ' + spec.sizeStyle + (spec.price?.default === undefined ? '' : ' / ' + String(spec.price.default) + ' ' + spec.price.currency)).join('\n')
}
