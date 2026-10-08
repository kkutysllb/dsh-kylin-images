/**
 * 知识漫画视觉方案选型（P0-P10）。
 *
 * 规则表来自 KSkills knowledge-comic v1.1.0 的自动选择表，这里实现为
 * 确定性纯函数：同样信号恒返回同样方案，且永远把命中规则与理由回传，
 * 便于会话模型解释或覆盖（P0 用户指定优先级最高）。
 */
import type { AspectRatio } from '../prompt/vocab.ts'

export interface VisualPlan {
  artStyle: string
  tone: string
  layout: string
  aspectRatio: AspectRatio
}

export interface ComicSignals {
  /** 内容信号（主题、关键词、摘要均可；大小写不敏感）。 */
  keywords?: readonly string[] | undefined
  /** 用户显式指定；任意字段一经给出即视为 P0，覆盖自动匹配。 */
  userSpecified?: Partial<VisualPlan> | undefined
}

export interface SelectionResult {
  plan: VisualPlan
  /** 0 = 用户指定，1-10 = 自动规则优先级，99 = 兜底默认。 */
  priority: number
  matchedRule: string
  reason: string
  matchedKeywords: string[]
}

const DEFAULT_PLAN: VisualPlan = { artStyle: 'ligne-claire', tone: 'neutral', layout: 'standard', aspectRatio: '3:4' }

interface Rule {
  priority: number
  id: string
  label: string
  keywords: readonly string[]
  plan: Omit<VisualPlan, 'aspectRatio'>
}

/** 顺序即优先级；从上到下第一个命中者生效。 */
export const RULES: readonly Rule[] = [
  { priority: 1, id: 'wuxia-history', label: '武侠 / 仙侠 / 中国历史', keywords: ['武侠', '仙侠', '中国历史', '古风', 'wuxia', 'xianxia'], plan: { artStyle: 'ink-brush', tone: 'dramatic', layout: 'splash' } },
  { priority: 2, id: 'computing', label: '计算机 / AI / 编程', keywords: ['计算机', '编程', '人工智能', '算法', '代码', 'programming', 'software', 'computer', 'algorithm', 'ai'], plan: { artStyle: 'ligne-claire', tone: 'neutral', layout: 'dense' } },
  { priority: 3, id: 'pre-1950-history', label: '1950 年前历史事件', keywords: ['1950', '二战', '清朝', '明朝', '民国', '近代史', '历史事件'], plan: { artStyle: 'ink-brush', tone: 'vintage', layout: 'cinematic' } },
  { priority: 4, id: 'conflict-breakthrough', label: '冲突 / 突破 / 革命', keywords: ['冲突', '突破', '革命', '变革', '斗争', 'revolution', 'breakthrough', 'conflict'], plan: { artStyle: 'realistic', tone: 'dramatic', layout: 'splash' } },
  { priority: 5, id: 'food-business', label: '美食 / 商业 / 生活方式', keywords: ['美食', '商业', '创业', '品牌', '生活方式', 'food', 'business', 'lifestyle', 'brand'], plan: { artStyle: 'realistic', tone: 'warm', layout: 'cinematic' } },
  { priority: 6, id: 'campus-romance', label: '校园 / 青春 / 情感', keywords: ['校园', '青春', '情感', '恋爱', 'campus', 'youth', 'romance'], plan: { artStyle: 'manga', tone: 'romantic', layout: 'standard' } },
  { priority: 7, id: 'personal-story', label: '个人故事 / 导师叙事', keywords: ['个人故事', '导师', '成长', '回忆', 'mentor', 'personal story', 'memoir'], plan: { artStyle: 'manga', tone: 'warm', layout: 'standard' } },
  { priority: 8, id: 'tutorial', label: '教程 / 入门 / 操作指南', keywords: ['教程', '入门', '操作指南', '指南', 'tutorial', 'how to', 'getting started', 'guide'], plan: { artStyle: 'chalk', tone: 'neutral', layout: 'dense' } },
  { priority: 9, id: 'biography', label: '传记（均衡型）', keywords: ['传记', 'biography'], plan: { artStyle: 'ligne-claire', tone: 'neutral', layout: 'mixed' } },
  { priority: 10, id: 'popular-science', label: '科普 / 百科', keywords: ['科普', '百科', '知识', 'science', 'encyclopedia'], plan: { artStyle: 'ligne-claire', tone: 'warm', layout: 'webtoon' } },
]

function matchedKeywords(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword.toLowerCase()))
}

/** 依据内容信号选择视觉方案。纯函数。 */
export function selectVisualPlan(signals: ComicSignals): SelectionResult {
  const haystack = (signals.keywords ?? []).join(' ').toLowerCase()
  const userSpecified = signals.userSpecified ?? {}
  const hasUserSpec = Object.values(userSpecified).some((value) => value !== undefined)

  let base: VisualPlan = { ...DEFAULT_PLAN }
  let priority = 99
  let matchedRule = 'default'
  let reason = '没有任何内容信号命中，使用中性兜底方案'
  let hits: string[] = []

  for (const rule of RULES) {
    const found = matchedKeywords(haystack, rule.keywords)
    if (found.length === 0) continue
    base = { ...rule.plan, aspectRatio: DEFAULT_PLAN.aspectRatio }
    priority = rule.priority
    matchedRule = 'P' + String(rule.priority) + '-' + rule.id
    reason = '命中「' + rule.label + '」：' + found.join('、')
    hits = found
    break
  }

  const plan: VisualPlan = {
    artStyle: userSpecified.artStyle ?? base.artStyle,
    tone: userSpecified.tone ?? base.tone,
    layout: userSpecified.layout ?? base.layout,
    aspectRatio: userSpecified.aspectRatio ?? base.aspectRatio,
  }

  if (hasUserSpec) {
    return {
      plan,
      priority: 0,
      matchedRule: 'P0-user',
      reason: '用户显式指定，覆盖自动匹配（原自动结论：' + matchedRule + '）',
      matchedKeywords: hits,
    }
  }

  return { plan, priority, matchedRule, reason, matchedKeywords: hits }
}
