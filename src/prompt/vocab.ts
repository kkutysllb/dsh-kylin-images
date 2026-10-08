/**
 * 视觉词汇表：艺术风格 / 色调 / 布局。
 *
 * 单一事实源，同时供提示词编译器（compose）与漫画选型（comic/select）使用，
 * 数据取自 KSkills knowledge-comic 技能 v1.1.0 的三张表。
 */

export interface VocabEntry {
  readonly id: string
  readonly zh: string
  /** 注入提示词时使用的英文描述（生成提示词恒为英文）。 */
  readonly phrase: string
}

export const ART_STYLES: readonly VocabEntry[] = [
  { id: 'ligne-claire', zh: '清线风格', phrase: 'ligne-claire comic style: clean uniform black outlines, flat color fills, flat perspective, no shading' },
  { id: 'manga', zh: '日式漫画', phrase: 'manga style: screentone and hatching shading, dynamic speed lines, exaggerated expressions, varied panel shapes' },
  { id: 'realistic', zh: '写实风格', phrase: 'realistic rendering: natural human proportions, natural light and shadow, detailed textures, cinematic composition' },
  { id: 'ink-brush', zh: '水墨风格', phrase: 'Chinese ink-brush style: varied brush strokes, dry and wet ink gradients, generous negative space, scattered perspective' },
  { id: 'chalk', zh: '粉笔黑板', phrase: 'chalkboard style: chalk strokes on dark board, handwritten lettering, simple sketchy figures, classroom feel' },
]

export const TONES: readonly VocabEntry[] = [
  { id: 'neutral', zh: '中性', phrase: 'neutral tone: natural greys with restrained soft primaries' },
  { id: 'warm', zh: '温暖', phrase: 'warm tone: warm yellow, orange and ochre dominance, human and welcoming' },
  { id: 'dramatic', zh: '戏剧', phrase: 'dramatic tone: high contrast, dark background with a focused light pool' },
  { id: 'romantic', zh: '浪漫', phrase: 'romantic tone: soft pink, lavender and pale blue with gentle gradients' },
  { id: 'energetic', zh: '活力', phrase: 'energetic tone: high-saturation red, yellow and blue, vivid and youthful' },
  { id: 'vintage', zh: '复古', phrase: 'vintage tone: yellowed paper base with faded print colours' },
  { id: 'action', zh: '动作', phrase: 'action tone: high contrast with motion blur and explosive orange, red and white accents' },
]

export const LAYOUTS: readonly VocabEntry[] = [
  { id: 'standard', zh: '标准', phrase: 'standard grid layout, 5-7 panels per page, steady reading rhythm' },
  { id: 'cinematic', zh: '电影', phrase: 'cinematic layout, 3-5 large panels with bleed, slow atmospheric pace' },
  { id: 'dense', zh: '密集', phrase: 'dense layout, 8-12 panels per page, information rich' },
  { id: 'splash', zh: '冲击', phrase: 'splash layout, 1-3 oversized panels highlighting a single decisive moment' },
  { id: 'mixed', zh: '混合', phrase: 'mixed layout, freely combined large and small panels, flexible rhythm' },
  { id: 'webtoon', zh: '条漫', phrase: 'vertical webtoon layout, continuous scrolling narrative' },
  { id: 'four-panel', zh: '四格', phrase: 'four-panel layout, setup-development-twist-conclusion structure' },
]

export const ASPECT_RATIOS = ['3:4', '4:3', '16:9', '9:16', '1:1', '2:3', '3:2'] as const
export type AspectRatio = (typeof ASPECT_RATIOS)[number]

export const RESOLUTIONS = ['1k', '2k', '4k'] as const
export type Resolution = (typeof RESOLUTIONS)[number]

const BY_ID = (entries: readonly VocabEntry[]): ReadonlyMap<string, VocabEntry> =>
  new Map(entries.map((entry) => [entry.id, entry]))

const ART_BY_ID = BY_ID(ART_STYLES)
const TONE_BY_ID = BY_ID(TONES)
const LAYOUT_BY_ID = BY_ID(LAYOUTS)

function lookup(table: ReadonlyMap<string, VocabEntry>, id: string | undefined): VocabEntry | undefined {
  if (typeof id !== 'string') return undefined
  return table.get(id.trim().toLowerCase())
}

/** 艺术风格 id -> 英文提示词片段；未知 id 原样回退为自由描述。 */
export function artStylePhrase(id: string | undefined): string {
  const entry = lookup(ART_BY_ID, id)
  if (entry !== undefined) return entry.phrase
  return typeof id === 'string' ? id.trim() : ''
}

/** 色调 id -> 英文提示词片段。 */
export function tonePhrase(id: string | undefined): string {
  const entry = lookup(TONE_BY_ID, id)
  if (entry !== undefined) return entry.phrase
  return typeof id === 'string' ? id.trim() : ''
}

/** 布局 id -> 英文提示词片段。 */
export function layoutPhrase(id: string | undefined): string {
  const entry = lookup(LAYOUT_BY_ID, id)
  if (entry !== undefined) return entry.phrase
  return typeof id === 'string' ? id.trim() : ''
}

export function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value)
}

export function isResolution(value: unknown): value is Resolution {
  return typeof value === 'string' && (RESOLUTIONS as readonly string[]).includes(value)
}
