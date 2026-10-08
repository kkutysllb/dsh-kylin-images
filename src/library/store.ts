/**
 * 知识层：载入 vendored 上游数据（style-library.json + cases.json）并建索引。
 *
 * 数据来源与对账见 data/upstream.lock.json 与 scripts/sync-upstream.mjs。
 * 解析一律容错：上游字段可能缺失或变形，绝不因单条坏数据整体失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeLocale, pick, pickList, toLocalizedText } from './i18n.ts'
import type { Locale, LocalizedText } from './i18n.ts'

export interface LibraryTemplate {
  id: string
  anchor?: string
  cover?: string
  category: string
  styles: string[]
  scenes: string[]
  tags: string[]
  title: LocalizedText
  description: LocalizedText
  useWhen: LocalizedText
  guidance: { en?: string[]; zh?: string[] }
  pitfalls: { en?: string[]; zh?: string[] }
  exampleCases: number[]
}

export interface LibraryCase {
  id: number
  title: string
  image: string
  prompt: string
  promptPreview: string
  category: string
  styles: string[]
  scenes: string[]
  featured: boolean
}

export interface Library {
  repository: string
  version: number
  categories: string[]
  styles: string[]
  scenes: string[]
  tagLabels: Record<string, LocalizedText>
  templates: LibraryTemplate[]
  cases: LibraryCase[]
}

export interface SearchQuery {
  query?: string | undefined
  category?: string | undefined
  styles?: readonly string[] | undefined
  scenes?: readonly string[] | undefined
  tags?: readonly string[] | undefined
  limit?: number | undefined
  cursor?: number | undefined
  /** summary 只回摘要（默认）；prompt 才回全文提示词（token 预算由调用方显式打开）。 */
  include?: 'summary' | 'prompt' | undefined
}

export interface TemplateHit {
  id: string
  title: string
  category: string
  score: number
  matched: string[]
  useWhen: string
  guidance: string[]
  pitfalls: string[]
  exampleCases: number[]
}

export interface CaseHit {
  id: number
  title: string
  category: string
  image: string
  score: number
  promptPreview: string
  prompt?: string
}

export interface SearchResult {
  totalTemplates: number
  totalCases: number
  nextCursor?: number
  templates: TemplateHit[]
  cases: CaseHit[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item : isRecord(item) ? String(item['id'] ?? '') : '')).filter((id) => id !== '')
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
}

function asLocalizedLists(value: unknown): { en?: string[]; zh?: string[] } {
  if (Array.isArray(value)) {
    const list = asStringArray(value)
    return list.length === 0 ? {} : { en: list }
  }
  if (!isRecord(value)) return {}
  const en = asStringArray(value['en'])
  const zh = asStringArray(value['zh'])
  const out: { en?: string[]; zh?: string[] } = {}
  if (en.length > 0) out.en = en
  if (zh.length > 0) out.zh = zh
  return out
}

/** 纯函数：把两份上游原始数据解析成库结构。 */
export function buildLibrary(styleLibraryRaw: unknown, casesRaw: unknown): Library {
  const style = isRecord(styleLibraryRaw) ? styleLibraryRaw : {}
  const casesRoot = isRecord(casesRaw) ? casesRaw : {}

  const tagLabels: Record<string, LocalizedText> = {}
  const rawTagLabels = isRecord(style['tagLabels']) ? style['tagLabels'] : {}
  for (const [key, value] of Object.entries(rawTagLabels)) tagLabels[key] = toLocalizedText(value)

  const templates: LibraryTemplate[] = []
  for (const raw of Array.isArray(style['templates']) ? style['templates'] : []) {
    if (!isRecord(raw)) continue
    const id = typeof raw['id'] === 'string' ? raw['id'] : ''
    if (id === '') continue
    const template: LibraryTemplate = {
      id,
      category: typeof raw['category'] === 'string' ? raw['category'] : '',
      styles: asStringArray(raw['styles']),
      scenes: asStringArray(raw['scenes']),
      tags: asStringArray(raw['tags']),
      title: toLocalizedText(raw['title']),
      description: toLocalizedText(raw['description']),
      useWhen: toLocalizedText(raw['useWhen']),
      guidance: asLocalizedLists(raw['guidance']),
      pitfalls: asLocalizedLists(raw['pitfalls']),
      exampleCases: asNumberArray(raw['exampleCases']),
    }
    if (typeof raw['anchor'] === 'string') template.anchor = raw['anchor']
    if (typeof raw['cover'] === 'string') template.cover = raw['cover']
    templates.push(template)
  }

  const cases: LibraryCase[] = []
  for (const raw of Array.isArray(casesRoot['cases']) ? casesRoot['cases'] : []) {
    if (!isRecord(raw)) continue
    const id = typeof raw['id'] === 'number' ? raw['id'] : Number(raw['id'])
    if (!Number.isFinite(id)) continue
    cases.push({
      id,
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
      image: typeof raw['image'] === 'string' ? raw['image'] : '',
      prompt: typeof raw['prompt'] === 'string' ? raw['prompt'] : '',
      promptPreview: typeof raw['promptPreview'] === 'string' ? raw['promptPreview'] : '',
      category: typeof raw['category'] === 'string' ? raw['category'] : '',
      styles: asStringArray(raw['styles']),
      scenes: asStringArray(raw['scenes']),
      featured: raw['featured'] === true,
    })
  }

  return {
    repository: typeof style['repository'] === 'string' ? style['repository'] : '',
    version: typeof style['version'] === 'number' ? style['version'] : 0,
    categories: asIdArray(style['categories']),
    styles: asIdArray(style['styles']),
    scenes: asIdArray(style['scenes']),
    tagLabels,
    templates,
    cases,
  }
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 从 data/ 目录载入库（默认插件自带快照）。 */
export function loadLibrary(dataDir: string = DATA_DIR): Library {
  return buildLibrary(
    readJson(join(dataDir, 'style-library.json')),
    readJson(join(dataDir, 'cases.json')),
  )
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
}

function overlaps(need: readonly string[] | undefined, have: readonly string[]): string[] {
  if (need === undefined || need.length === 0) return []
  const haystack = new Set(have.map((value) => value.toLowerCase()))
  return need.filter((value) => haystack.has(value.toLowerCase()))
}

function templateHaystack(template: LibraryTemplate): string {
  return [
    template.id,
    template.title.en ?? '',
    template.title.zh ?? '',
    template.description.en ?? '',
    template.description.zh ?? '',
    template.useWhen.en ?? '',
    template.useWhen.zh ?? '',
    template.tags.join(' '),
  ].join(' ').toLowerCase()
}

function caseHaystack(record: LibraryCase): string {
  return [record.title, record.category, record.styles.join(' '), record.scenes.join(' '), record.promptPreview]
    .join(' ')
    .toLowerCase()
}

/** 结构化检索：摘要优先，prompt 全文需显式 include:'prompt'。 */
export function searchLibrary(library: Library, query: SearchQuery, localeInput: unknown = 'zh'): SearchResult {
  const locale: Locale = normalizeLocale(localeInput)
  const tokens = query.query === undefined ? [] : tokenize(query.query)
  const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 5)))
  const cursor = Math.max(0, Math.floor(query.cursor ?? 0))
  // 浏览模式（无任何筛选）：返回全部；有筛选：只返回真正命中的条目
  const hasFilters = query.query !== undefined
    || query.category !== undefined
    || (query.styles?.length ?? 0) > 0
    || (query.scenes?.length ?? 0) > 0
    || (query.tags?.length ?? 0) > 0

  const templateHits: TemplateHit[] = []
  for (const template of library.templates) {
    const matched: string[] = []
    let score = 0
    if (query.category !== undefined && template.category === query.category) { score += 5; matched.push('category:' + template.category) }
    const styleHits = overlaps(query.styles, template.styles)
    if (styleHits.length > 0) { score += 3 * styleHits.length; matched.push('styles:' + styleHits.join('|')) }
    const sceneHits = overlaps(query.scenes, template.scenes)
    if (sceneHits.length > 0) { score += 2 * sceneHits.length; matched.push('scenes:' + sceneHits.join('|')) }
    const tagHits = overlaps(query.tags, template.tags)
    if (tagHits.length > 0) { score += 2 * tagHits.length; matched.push('tags:' + tagHits.join('|')) }
    const haystack = templateHaystack(template)
    const textHits = tokens.filter((token) => haystack.includes(token))
    if (textHits.length > 0) { score += textHits.length; matched.push('text:' + textHits.join('|')) }
    if (score === 0 && hasFilters) continue
    templateHits.push({
      id: template.id,
      title: pick(template.title, locale),
      category: template.category,
      score,
      matched,
      useWhen: pick(template.useWhen, locale),
      guidance: pickList(template.guidance, locale),
      pitfalls: pickList(template.pitfalls, locale),
      exampleCases: template.exampleCases,
    })
  }
  templateHits.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))

  const caseHits: CaseHit[] = []
  for (const record of library.cases) {
    let score = 0
    if (query.category !== undefined && record.category === query.category) score += 5
    score += 3 * overlaps(query.styles, record.styles).length
    score += 2 * overlaps(query.scenes, record.scenes).length
    if (tokens.length > 0) {
      const haystack = caseHaystack(record)
      score += tokens.filter((token) => haystack.includes(token)).length
    }
    if (score > 0 && record.featured) score += 1
    if (score === 0 && hasFilters) continue
    const hit: CaseHit = {
      id: record.id,
      title: record.title,
      category: record.category,
      image: record.image,
      score,
      promptPreview: record.promptPreview,
    }
    if (query.include === 'prompt') hit.prompt = record.prompt
    caseHits.push(hit)
  }
  caseHits.sort((a, b) => (b.score - a.score) || (a.id - b.id))

  const pageTemplates = templateHits.slice(cursor, cursor + limit)
  const pageCases = caseHits.slice(cursor, cursor + limit)
  const result: SearchResult = {
    totalTemplates: templateHits.length,
    totalCases: caseHits.length,
    templates: pageTemplates,
    cases: pageCases,
  }
  const moreTemplates = cursor + limit < templateHits.length
  const moreCases = cursor + limit < caseHits.length
  if (moreTemplates || moreCases) result.nextCursor = cursor + limit
  return result
}
