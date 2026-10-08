/**
 * 双语取值：上游数据里所有面向人的字段都是 { en, zh } 结构。
 * 取值必须容错（字段可能缺失、可能是纯字符串、可能是纯数组）。
 */

export type Locale = 'zh' | 'en'

export interface LocalizedText { en?: string; zh?: string }

/** 语言标识归一：zh / zh-CN / zh-Hans 等一律归到 zh，其余归到 en。 */
export function normalizeLocale(value: unknown): Locale {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw.startsWith('zh') ? 'zh' : 'en'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** {en,zh} -> 指定语言的字符串；缺失时回退另一语言，再回退空串。 */
export function pick(value: unknown, locale: Locale): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  const preferred = value[locale]
  if (typeof preferred === 'string') return preferred
  const fallback = value[locale === 'zh' ? 'en' : 'zh']
  if (typeof fallback === 'string') return fallback
  return ''
}

/** {en:[],zh:[]} -> 指定语言的字符串数组；容忍纯数组。 */
export function pickList(value: unknown, locale: Locale): string[] {
  const toList = (candidate: unknown): string[] | undefined => {
    if (!Array.isArray(candidate)) return undefined
    return candidate.filter((item): item is string => typeof item === 'string')
  }
  const direct = toList(value)
  if (direct !== undefined) return direct
  if (!isRecord(value)) return []
  return toList(value[locale]) ?? toList(value[locale === 'zh' ? 'en' : 'zh']) ?? []
}

/** 把 {en,zh} 或纯字符串统一成 {en,zh}，便于统一存取。 */
export function toLocalizedText(value: unknown): LocalizedText {
  if (typeof value === 'string') return { en: value, zh: value }
  if (!isRecord(value)) return {}
  const en = typeof value['en'] === 'string' ? value['en'] : undefined
  const zh = typeof value['zh'] === 'string' ? value['zh'] : undefined
  return { en, zh }
}
