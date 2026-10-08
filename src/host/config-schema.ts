/**
 * 宿主配置 schema（cordis 的 Config 导出）。
 *
 * cordis 的 resolveConfig 走 Standard Schema v1：`Config['~standard'].validate(raw)`，
 * 返回值直接成为 apply(ctx, config) 的第二个参数。**导出普通 JSON Schema 会让整条
 * 插件行激活失败**（TypeError: Cannot read properties of undefined (reading 'validate')）
 * ——这是真机 boot 抓到的实测结论。
 *
 * 本插件零依赖，因此手写一个最小 Standard Schema：
 *   - 容错优先：坏值一律回落默认值，**绝不产生 issues**（不因配置问题让插件不激活）；
 *   - 保留未知键：宿主 patch 里的额外字段原样传给 apply；
 *   - 归一化复用 store/settings 的 normalizeSettings，与运行时读值同一套规则。
 */
import { DEFAULT_SETTINGS, normalizeSettings } from '../store/settings.ts'
import { ASPECT_RATIOS, RESOLUTIONS } from '../prompt/vocab.ts'
import { IMAGE_FORMATS } from '../prompt/schema.ts'
import { QUALITIES } from '../store/settings.ts'

export interface ConfigFieldSpec {
  type: 'string' | 'number' | 'boolean' | 'string[]'
  description: string
  enum?: readonly string[]
  minimum?: number
  maximum?: number
}

/** 字段元数据：供文档、客户端卡片与设置命名空间注册使用。 */
export const CONFIG_FIELDS: Record<string, ConfigFieldSpec> = {
  defaultChannelId: { type: 'string', description: '默认通道 id（在「视觉模型」里选择）' },
  defaultModel: { type: 'string', description: '默认视觉模型名；留空表示用通道声明的第一个模型' },
  defaultAspectRatio: { type: 'string', enum: ASPECT_RATIOS, description: '默认宽高比' },
  defaultResolution: { type: 'string', enum: RESOLUTIONS, description: '默认分辨率档位' },
  defaultFormat: { type: 'string', enum: IMAGE_FORMATS, description: '默认输出格式' },
  defaultQuality: { type: 'string', enum: QUALITIES, description: '默认质量档位' },
  defaultCount: { type: 'number', minimum: 1, maximum: 4, description: '单次生成张数' },
  concurrency: { type: 'number', minimum: 1, maximum: 8, description: '批量并发' },
  globalNegative: { type: 'string[]', description: '全局追加负面词' },
  includeTemplatePitfalls: { type: 'boolean', description: '是否把模板避坑指南并入提示词约束段' },
  budgetConfirmCny: { type: 'number', minimum: 0, description: '超过该预估金额（元）先确认' },
  confirmUnknownPrice: { type: 'boolean', description: '未知价一律确认' },
  cacheEnabled: { type: 'boolean', description: '结果缓存开关' },
  cacheDir: { type: 'string', description: '缓存目录；留空用插件数据目录' },
  cacheMaxEntries: { type: 'number', minimum: 0, maximum: 5000, description: '缓存条目上限' },
}

export const CONFIG_FIELD_NAMES: readonly string[] = Object.keys(CONFIG_FIELDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析后的配置：归一化字段 + 原样保留的未知键。 */
export function resolvePluginConfig(raw: unknown): Record<string, unknown> {
  const base = isRecord(raw) ? raw : {}
  return { ...base, ...normalizeSettings(base) }
}

export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-kylin-images',
    validate(raw: unknown): { value: Record<string, unknown> } {
      return { value: resolvePluginConfig(raw) }
    },
  },
  /** 非标准扩展字段：cordis 会忽略，供本插件文档与客户端读取。 */
  fields: CONFIG_FIELDS,
  defaults: DEFAULT_SETTINGS,
}

/** 从宿主配置里取出我们关心的字段（用于首次激活时播种 vault）。 */
export function pickConfigFields(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {}
  const picked: Record<string, unknown> = {}
  for (const field of CONFIG_FIELD_NAMES) {
    if (raw[field] !== undefined) picked[field] = raw[field]
  }
  return picked
}
