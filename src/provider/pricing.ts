/**
 * 成本护栏：三层查价（通道覆盖 > 内置目录 > unknown）+ 确认判定。
 *
 * 教训来自上游与本地实测：静默烧钱是这类插件最容易犯的错（20 页漫画 × 2k 图）。
 * 因此：未知价一律确认；超过阈值一律确认；每次记账。
 */
import type { Resolution } from '../prompt/vocab.ts'
import type { ChannelRecord } from './types.ts'
import { resolveModelSpec } from './catalog.ts'
import type { PluginSettings } from '../store/settings.ts'

export interface QuoteResult {
  amount: number
  currency: string
  confidence: 'exact' | 'estimated' | 'unknown'
  source: 'channel-override' | 'builtin' | 'unknown'
  note: string
}

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function perImageFromTable(table: { byResolution?: Record<string, number>; default?: number } | undefined, resolution: Resolution): number | null {
  if (table === undefined) return null
  const byResolution = table.byResolution
  if (byResolution !== undefined) {
    const exact = finiteOrNull(byResolution[resolution])
    if (exact !== null) return exact
    const fallback = finiteOrNull(byResolution['default'])
    if (fallback !== null) return fallback
  }
  return finiteOrNull(table.default)
}

/** 单张价（人民币）。通道覆盖优先，其次内置目录。 */
export function pricePerImage(channel: ChannelRecord, model: string, resolution: Resolution): {
  amount: number | null
  currency: string
  source: QuoteResult['source']
  note: string
} {
  const override = channel.pricing
  if (override !== undefined) {
    const amount = perImageFromTable(override, resolution)
    if (amount !== null) {
      return { amount, currency: override.currency ?? 'CNY', source: 'channel-override', note: '通道自定义价目' }
    }
  }
  const spec = resolveModelSpec(model)
  if (spec.price !== null) {
    const amount = perImageFromTable(spec.price, resolution)
    if (amount !== null) {
      return { amount, currency: spec.price.currency, source: 'builtin', note: '内置目录（' + spec.match[0] + '）' }
    }
  }
  return { amount: null, currency: override?.currency ?? 'CNY', source: 'unknown', note: '未收录该模型价目，也无法从通道覆盖读到' }
}

export function quoteImages(input: {
  channel: ChannelRecord
  model: string
  count: number
  resolution: Resolution
}): QuoteResult {
  const count = Math.max(1, Math.floor(input.count))
  const unit = pricePerImage(input.channel, input.model, input.resolution)
  if (unit.amount === null) {
    return {
      amount: 0,
      currency: unit.currency,
      confidence: 'unknown',
      source: 'unknown',
      note: unit.note + '（未知价：先确认再生成）',
    }
  }
  return {
    amount: Math.round(unit.amount * count * 10000) / 10000,
    currency: unit.currency,
    confidence: unit.source === 'channel-override' ? 'exact' : 'estimated',
    source: unit.source,
    note: unit.note + ' × ' + String(count) + ' 张',
  }
}

/** 是否需要先向用户确认。 */
export function needsConfirmation(quote: QuoteResult, settings: PluginSettings): boolean {
  if (quote.confidence === 'unknown') return settings.confirmUnknownPrice
  return quote.amount > settings.budgetConfirmCny
}

export function describeQuote(quote: QuoteResult): string {
  if (quote.confidence === 'unknown') return '预估成本未知（' + quote.note + '）'
  const label = quote.confidence === 'exact' ? '精确' : '预估'
  return label + '成本 ' + String(quote.amount) + ' ' + quote.currency + '（' + quote.note + '）'
}
