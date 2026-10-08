/**
 * 分镜 → ImagePrompt v1 编译。
 *
 * 这是知识漫画管线的核心交接点：会话模型产出「分镜」（结构化 JSON 或 Markdown 表格），
 * 插件把它翻译成每页可执行的 ImagePrompt 契约，并在这里落实三锁的两条：
 *   - 文字锁：出场角色的角色表逐字注入 characters[].sheet；
 *   - 风格锁：项目级 artStyle/tone/layout/宽高比 + 全篇同一句风格前言（进 constraints.must）。
 * 第三条图像锁（角色三视图作参考图）由 render 阶段注入。
 */
import type { ImagePrompt, ImagePromptTextBlock } from '../prompt/schema.ts'
import type { AspectRatio } from '../prompt/vocab.ts'
import type { VisualPlan } from './select.ts'
import type { ComicCharacter } from './project.ts'

export interface StoryboardDialogue { speaker?: string; text: string }

export interface StoryboardPage {
  title: string
  /** 该页核心信息（一句话）。 */
  core?: string
  /** 场景描述（地点/时间/氛围）。 */
  scene?: string
  /** 出场角色名，需能在项目 characters 里找到。 */
  characters?: string[]
  /** 覆盖项目布局。 */
  layout?: string
  shot?: string
  panels?: string[]
  focus?: string
  dialogue?: StoryboardDialogue[]
  narration?: string
}

export interface Storyboard { pages: StoryboardPage[] }

export interface StoryboardParseResult {
  ok: boolean
  errors: string[]
  value: Storyboard
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return out.length === 0 ? undefined : out
}

/** 解析分镜：容错但严格校验必填项（页码顺序由数组顺序决定）。 */
export function parseStoryboard(raw: unknown): StoryboardParseResult {
  const errors: string[] = []
  const root = isRecord(raw) ? raw : undefined
  const rawPages = root === undefined ? undefined : root['pages']
  if (rawPages === undefined && Array.isArray(raw)) {
    return parseStoryboard({ pages: raw })
  }
  if (!Array.isArray(rawPages)) {
    return { ok: false, errors: ['storyboard.pages 必须是数组'], value: { pages: [] } }
  }
  if (rawPages.length === 0) errors.push('storyboard.pages 不能为空')
  if (rawPages.length > 40) errors.push('单篇漫画最多 40 页（当前 ' + String(rawPages.length) + '）')

  const pages: StoryboardPage[] = []
  rawPages.forEach((item, index) => {
    const path = 'pages[' + String(index) + ']'
    if (!isRecord(item)) {
      errors.push(path + ' 必须是对象')
      return
    }
    const title = str(item['title'])
    if (title === undefined) {
      errors.push(path + '.title 必填')
      return
    }
    const page: StoryboardPage = { title }
    const core = str(item['core'])
    if (core !== undefined) page.core = core
    const scene = str(item['scene'])
    if (scene !== undefined) page.scene = scene
    const characters = strList(item['characters'])
    if (characters !== undefined) page.characters = characters
    const layout = str(item['layout'])
    if (layout !== undefined) page.layout = layout
    const shot = str(item['shot'])
    if (shot !== undefined) page.shot = shot
    const panels = strList(item['panels'])
    if (panels !== undefined) page.panels = panels
    const focus = str(item['focus'])
    if (focus !== undefined) page.focus = focus
    const narration = str(item['narration'])
    if (narration !== undefined) page.narration = narration
    const dialogueRaw = item['dialogue']
    if (Array.isArray(dialogueRaw)) {
      const dialogue: StoryboardDialogue[] = []
      for (const entry of dialogueRaw) {
        if (!isRecord(entry)) continue
        const text = str(entry['text'])
        if (text === undefined) continue
        const line: StoryboardDialogue = { text }
        const speaker = str(entry['speaker'])
        if (speaker !== undefined) line.speaker = speaker
        dialogue.push(line)
      }
      if (dialogue.length > 0) page.dialogue = dialogue
    } else if (dialogueRaw !== undefined) {
      errors.push(path + '.dialogue 必须是数组')
    }
    pages.push(page)
  })

  return { ok: errors.length === 0, errors, value: { pages } }
}

export function parseCharacters(raw: unknown): { ok: boolean; errors: string[]; value: ComicCharacter[] } {
  const errors: string[] = []
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['characters']) ? raw['characters'] : undefined
  if (list === undefined) return { ok: false, errors: ['characters 必须是数组或 { characters: [...] }'], value: [] }
  const characters: ComicCharacter[] = []
  list.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push('characters[' + String(index) + '] 必须是对象')
      return
    }
    const name = str(item['name'])
    const sheet = str(item['sheet'])
    if (name === undefined) { errors.push('characters[' + String(index) + '].name 必填'); return }
    if (sheet === undefined) { errors.push('characters[' + String(index) + '].sheet 必填（跨页一致性靠它）'); return }
    characters.push({ name, sheet })
  })
  if (characters.length > 8) errors.push('主要角色最多 8 个（当前 ' + String(characters.length) + '）')
  return { ok: errors.length === 0, errors, value: characters }
}

/** 全篇同一句风格前言：风格锁的可测锚点。 */
export function stylePreambleOf(plan: VisualPlan): string {
  return 'Keep one consistent art style, palette and line weight across every page of this comic: '
    + plan.artStyle + ' art style with a ' + plan.tone + ' tone; never switch to another visual style.'
}

export interface BuildPageInput {
  page: StoryboardPage
  index: number
  projectId: string
  plan: VisualPlan
  characters: readonly ComicCharacter[]
  aspectRatio?: AspectRatio | undefined
  resolution?: string | undefined
  /** 语言提示：画面内文字必须与源语言一致，这里只标注。 */
  language?: string | undefined
}

/** 把一页分镜编译成 ImagePrompt v1。纯函数，可 golden 测试。 */
export function buildPagePrompt(input: BuildPageInput): ImagePrompt {
  const { page, index, plan } = input
  const isCover = index === 0
  const subjectParts: string[] = []
  if (isCover) subjectParts.push('封面：' + page.title)
  else if (page.core !== undefined) subjectParts.push(page.core)
  if (page.scene !== undefined) subjectParts.push('场景：' + page.scene)
  if (subjectParts.length === 0) subjectParts.push(page.title)

  const text: ImagePromptTextBlock[] = []
  if (page.narration !== undefined) {
    text.push({ content: page.narration, kind: 'narration', mustRenderExactly: true })
  }
  for (const line of page.dialogue ?? []) {
    const block: ImagePromptTextBlock = { content: line.text, kind: 'speech-bubble', mustRenderExactly: true }
    if (line.speaker !== undefined) block.speaker = line.speaker
    text.push(block)
  }

  // 只注入本页显式列出的角色：不列就不注入（避免把整个卡司硬塞进每一格）。
  // 跨页观感一致由「图像锁」（角色三视图作参考图）与逐字一致的 sheet 描述共同保证。
  const inPage = new Set(page.characters ?? [])
  const characters = input.characters
    .filter((character) => inPage.has(character.name))
    .map((character) => ({ name: character.name, sheet: character.sheet }))

  const prompt: ImagePrompt = {
    schemaVersion: 1,
    id: input.projectId + '/page-' + String(index).padStart(2, '0'),
    intent: isCover ? 'single-image' : 'comic-page',
    subject: subjectParts.join('；'),
    composition: {
      layout: page.layout ?? plan.layout,
      ...(page.shot === undefined ? {} : { shot: page.shot }),
      ...(page.panels === undefined ? {} : { panels: page.panels }),
      ...(page.focus === undefined ? {} : { hierarchy: [page.focus] }),
    },
    style: { artStyle: plan.artStyle, tone: plan.tone, tags: ['Illustration'] },
    technical: {
      aspectRatio: input.aspectRatio ?? plan.aspectRatio,
      resolution: '2k',
      format: 'png',
    },
    constraints: {
      must: [stylePreambleOf(plan)],
      avoid: ['photorealistic photo', '3D render', 'inconsistent character design', 'garbled text'],
    },
    meta: { source: 'comic:' + input.projectId + '#' + String(index) },
  }
  if (characters.length > 0) prompt.characters = characters
  if (text.length > 0) prompt.text = text
  if (input.language !== undefined) prompt.language = input.language
  return prompt
}

/** 项目视觉方案 → 一句话说明（给 status / 卡片用）。 */
export function describePlan(plan: VisualPlan): string {
  return plan.artStyle + ' / ' + plan.tone + ' / ' + plan.layout + ' / ' + plan.aspectRatio
}
