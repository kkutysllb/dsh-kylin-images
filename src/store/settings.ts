/**
 * 「视觉模型」配置的非敏感字段（对应设计规格 §11.3 分区 1-5）。
 *
 * 凭据不在这里：API Key 只存在于 vault 的通道记录里。
 * 这些字段会被插件自己的 API 读写，并镜像到宿主设置命名空间（供 configForms 渲染）。
 */
import { ASPECT_RATIOS, RESOLUTIONS, isAspectRatio, isResolution } from '../prompt/vocab.ts'
import type { AspectRatio, Resolution } from '../prompt/vocab.ts'
import { IMAGE_FORMATS } from '../prompt/schema.ts'
import type { ImageFormat } from '../prompt/schema.ts'

export const QUALITIES = ['low', 'medium', 'high', 'auto'] as const
export type Quality = (typeof QUALITIES)[number]

export interface PluginSettings {
  /** 默认通道 id；空串表示未配置（工具会给出明确指引）。 */
  defaultChannelId: string
  defaultModel: string
  defaultAspectRatio: AspectRatio
  defaultResolution: Resolution
  defaultFormat: ImageFormat
  defaultQuality: Quality
  /** 单次生成张数上限（1-4）。 */
  defaultCount: number
  /** 批量并发（1-8）。 */
  concurrency: number
  /** 全局追加负面词。 */
  globalNegative: string[]
  /** 是否把所选模板的 pitfalls 自动并入提示词约束段。 */
  includeTemplatePitfalls: boolean
  /** 单次预估超过该金额（人民币）时先请求确认。 */
  budgetConfirmCny: number
  /** 未知价是否一律确认。 */
  confirmUnknownPrice: boolean
  cacheEnabled: boolean
  cacheDir: string
  cacheMaxEntries: number
}

export const DEFAULT_SETTINGS: PluginSettings = {
  defaultChannelId: '',
  defaultModel: '',
  defaultAspectRatio: '3:4',
  defaultResolution: '2k',
  defaultFormat: 'png',
  defaultQuality: 'auto',
  defaultCount: 1,
  concurrency: 2,
  globalNegative: [],
  includeTemplatePitfalls: true,
  budgetConfirmCny: 1,
  confirmUnknownPrice: true,
  cacheEnabled: true,
  cacheDir: '',
  cacheMaxEntries: 200,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function readString(value: unknown, fallback: string, maxLength = 200): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed.slice(0, maxLength)
}

function readStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed.slice(0, 200))
    if (out.length >= 64) break
  }
  return out
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 规范化任意输入为完整设置（容错：坏字段回落默认值，永不抛异常）。 */
export function normalizeSettings(input: unknown): PluginSettings {
  if (!isRecord(input)) return { ...DEFAULT_SETTINGS, globalNegative: [] }
  const ratio = input['defaultAspectRatio']
  const resolution = input['defaultResolution']
  const format = input['defaultFormat']
  const quality = input['defaultQuality']
  return {
    defaultChannelId: readString(input['defaultChannelId'], DEFAULT_SETTINGS.defaultChannelId, 32),
    defaultModel: readString(input['defaultModel'], DEFAULT_SETTINGS.defaultModel, 128),
    defaultAspectRatio: isAspectRatio(ratio) ? ratio : DEFAULT_SETTINGS.defaultAspectRatio,
    defaultResolution: isResolution(resolution) ? resolution : DEFAULT_SETTINGS.defaultResolution,
    defaultFormat: typeof format === 'string' && (IMAGE_FORMATS as readonly string[]).includes(format)
      ? (format as ImageFormat)
      : DEFAULT_SETTINGS.defaultFormat,
    defaultQuality: typeof quality === 'string' && (QUALITIES as readonly string[]).includes(quality)
      ? (quality as Quality)
      : DEFAULT_SETTINGS.defaultQuality,
    defaultCount: clampInt(input['defaultCount'], 1, 4, DEFAULT_SETTINGS.defaultCount),
    concurrency: clampInt(input['concurrency'], 1, 8, DEFAULT_SETTINGS.concurrency),
    globalNegative: readStringList(input['globalNegative'], []),
    includeTemplatePitfalls: readBoolean(input['includeTemplatePitfalls'], DEFAULT_SETTINGS.includeTemplatePitfalls),
    budgetConfirmCny: Math.max(0, Number.isFinite(Number(input['budgetConfirmCny'])) ? Number(input['budgetConfirmCny']) : DEFAULT_SETTINGS.budgetConfirmCny),
    confirmUnknownPrice: readBoolean(input['confirmUnknownPrice'], DEFAULT_SETTINGS.confirmUnknownPrice),
    cacheEnabled: readBoolean(input['cacheEnabled'], DEFAULT_SETTINGS.cacheEnabled),
    cacheDir: readString(input['cacheDir'], DEFAULT_SETTINGS.cacheDir, 400),
    cacheMaxEntries: clampInt(input['cacheMaxEntries'], 0, 5000, DEFAULT_SETTINGS.cacheMaxEntries),
  }
}

export const ASPECT_RATIO_CHOICES: readonly AspectRatio[] = ASPECT_RATIOS
export const RESOLUTION_CHOICES: readonly Resolution[] = RESOLUTIONS
export const FORMAT_CHOICES: readonly ImageFormat[] = IMAGE_FORMATS
