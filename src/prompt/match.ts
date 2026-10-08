/**
 * 选型：把用户需求映射到 2-3 个模板候选（对齐上游技能的交互约定）。
 *
 * 打分顺序（权重递减）：分类 -> 风格标签 -> 场景标签 -> 标签 -> 关键词。
 * 需求模糊时永不硬猜：返回多个候选 + 命中理由，由会话模型问用户。
 */
import { normalizeLocale } from '../library/i18n.ts'
import { searchLibrary } from '../library/store.ts'
import type { Library } from '../library/store.ts'

export interface TemplateNeed {
  query?: string | undefined
  category?: string | undefined
  styles?: readonly string[] | undefined
  scenes?: readonly string[] | undefined
  tags?: readonly string[] | undefined
}

export interface TemplateCandidate {
  id: string
  title: string
  category: string
  score: number
  /** 命中了哪些维度，如 ['category:UI & Interfaces', 'styles:UI']。 */
  matched: string[]
  useWhen: string
  pitfalls: string[]
}

/** 兜底候选：需求完全没有命中时，给出最通用的几套模板。 */
const FALLBACK_TEMPLATE_IDS: readonly string[] = [
  'infographic-engine',
  'illustration-art-style',
  'realistic-photography',
]

/**
 * 返回模板候选（按分数降序，最多 limit 个）。
 * 无命中时给通用兜底，并在 matched 里标注 'fallback'，调用方应据此追问用户。
 */
export function suggestTemplates(
  library: Library,
  need: TemplateNeed,
  localeInput: unknown = 'zh',
  limit = 3,
): TemplateCandidate[] {
  const locale = normalizeLocale(localeInput)
  const result = searchLibrary(
    library,
    {
      query: need.query,
      category: need.category,
      styles: need.styles,
      scenes: need.scenes,
      tags: need.tags,
      limit: 50,
    },
    locale,
  )

  if (result.templates.length > 0) {
    return result.templates.slice(0, Math.max(1, limit)).map((hit) => ({
      id: hit.id,
      title: hit.title,
      category: hit.category,
      score: hit.score,
      matched: hit.matched,
      useWhen: hit.useWhen,
      pitfalls: hit.pitfalls,
    }))
  }

  const candidates: TemplateCandidate[] = []
  for (const id of FALLBACK_TEMPLATE_IDS) {
    const template = library.templates.find((item) => item.id === id)
    if (template === undefined) continue
    candidates.push({
      id: template.id,
      title: locale === 'zh' ? (template.title.zh ?? template.title.en ?? '') : (template.title.en ?? template.title.zh ?? ''),
      category: template.category,
      score: 0,
      matched: ['fallback'],
      useWhen: locale === 'zh' ? (template.useWhen.zh ?? template.useWhen.en ?? '') : (template.useWhen.en ?? template.useWhen.zh ?? ''),
      pitfalls: locale === 'zh' ? (template.pitfalls.zh ?? template.pitfalls.en ?? []) : (template.pitfalls.en ?? template.pitfalls.zh ?? []),
    })
    if (candidates.length >= limit) break
  }
  return candidates
}

/** 是否应当先让用户做选择（候选分数接近或存在兜底）。 */
export function needsUserChoice(candidates: readonly TemplateCandidate[]): boolean {
  if (candidates.length === 0) return false
  if (candidates.some((candidate) => candidate.matched.includes('fallback'))) return true
  if (candidates.length < 2) return false
  const first = candidates[0]
  const second = candidates[1]
  if (first === undefined || second === undefined) return false
  return first.score - second.score <= 2
}
