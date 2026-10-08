/**
 * ImagePrompt v1 —— 本插件对外的唯一提示词契约。
 *
 * 上游 22 套模板、知识漫画的分页 JSON、用户自然语言，最终都收敛到这里。
 * 零依赖手写校验器：返回规范化后的值 + 全部错误（不抛异常，便于工具面聚合）。
 */
import { ASPECT_RATIOS, RESOLUTIONS, isAspectRatio, isResolution } from './vocab.ts'
import type { AspectRatio, Resolution } from './vocab.ts'

export const IMAGE_INTENTS = ['single-image', 'comic-page', 'variant-set', 'edit'] as const
export type ImageIntent = (typeof IMAGE_INTENTS)[number]

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const
export type ImageFormat = (typeof IMAGE_FORMATS)[number]

export interface ImagePromptTextBlock {
  content: string
  kind?: string
  speaker?: string
  mustRenderExactly?: boolean
}

export interface ImagePromptCharacter {
  name: string
  sheet: string
  refImage?: string
}

export interface ImagePromptComposition {
  layout?: string
  shot?: string
  panels?: string[]
  hierarchy?: string[]
}

export interface ImagePromptStyle {
  artStyle?: string
  tone?: string
  tags?: string[]
  materials?: string[]
}

export interface ImagePromptTechnical {
  aspectRatio?: AspectRatio
  resolution?: Resolution
  format?: ImageFormat
  seed?: number
}

export interface ImagePromptConstraints {
  must?: string[]
  avoid?: string[]
}

export interface ImagePrompt {
  schemaVersion: 1
  id?: string
  intent: ImageIntent
  templateId?: string
  subject: string
  composition?: ImagePromptComposition
  style?: ImagePromptStyle
  text?: ImagePromptTextBlock[]
  characters?: ImagePromptCharacter[]
  technical?: ImagePromptTechnical
  constraints?: ImagePromptConstraints
  language?: string
  meta?: { source?: string; notes?: string }
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  value: ImagePrompt
}

const EMPTY_PROMPT: ImagePrompt = { schemaVersion: 1, intent: 'single-image', subject: '' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, path: string, errors: string[]): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    errors.push(path + ' 必须是字符串')
    return undefined
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function stringList(value: unknown, path: string, errors: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    errors.push(path + ' 必须是字符串数组')
    return undefined
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(path + ' 含非字符串项')
      return undefined
    }
    const trimmed = item.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out.length === 0 ? undefined : out
}

/** 校验并规范化一个 ImagePrompt。永不抛异常。 */
export function validateImagePrompt(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!isRecord(input)) {
    return { ok: false, errors: ['ImagePrompt 必须是对象'], value: { ...EMPTY_PROMPT } }
  }

  if (input['schemaVersion'] !== 1) errors.push('schemaVersion 必须为 1')

  const rawIntent = input['intent']
  let intent: ImageIntent = 'single-image'
  if (typeof rawIntent === 'string' && (IMAGE_INTENTS as readonly string[]).includes(rawIntent)) {
    intent = rawIntent as ImageIntent
  } else {
    errors.push('intent 必须是以下之一：' + IMAGE_INTENTS.join(' | '))
  }

  const subject = optionalString(input['subject'], 'subject', errors)
  if (subject === undefined) errors.push('subject 必填且非空')

  const value: ImagePrompt = { schemaVersion: 1, intent, subject: subject ?? '' }

  const id = optionalString(input['id'], 'id', errors)
  if (id !== undefined) value.id = id
  const templateId = optionalString(input['templateId'], 'templateId', errors)
  if (templateId !== undefined) value.templateId = templateId
  const language = optionalString(input['language'], 'language', errors)
  if (language !== undefined) value.language = language

  const compositionRaw = input['composition']
  if (compositionRaw !== undefined) {
    if (!isRecord(compositionRaw)) errors.push('composition 必须是对象')
    else {
      const composition: ImagePromptComposition = {}
      const layout = optionalString(compositionRaw['layout'], 'composition.layout', errors)
      if (layout !== undefined) composition.layout = layout
      const shot = optionalString(compositionRaw['shot'], 'composition.shot', errors)
      if (shot !== undefined) composition.shot = shot
      const panels = stringList(compositionRaw['panels'], 'composition.panels', errors)
      if (panels !== undefined) composition.panels = panels
      const hierarchy = stringList(compositionRaw['hierarchy'], 'composition.hierarchy', errors)
      if (hierarchy !== undefined) composition.hierarchy = hierarchy
      value.composition = composition
    }
  }

  const styleRaw = input['style']
  if (styleRaw !== undefined) {
    if (!isRecord(styleRaw)) errors.push('style 必须是对象')
    else {
      const style: ImagePromptStyle = {}
      const artStyle = optionalString(styleRaw['artStyle'], 'style.artStyle', errors)
      if (artStyle !== undefined) style.artStyle = artStyle
      const tone = optionalString(styleRaw['tone'], 'style.tone', errors)
      if (tone !== undefined) style.tone = tone
      const tags = stringList(styleRaw['tags'], 'style.tags', errors)
      if (tags !== undefined) style.tags = tags
      const materials = stringList(styleRaw['materials'], 'style.materials', errors)
      if (materials !== undefined) style.materials = materials
      value.style = style
    }
  }

  const textRaw = input['text']
  if (textRaw !== undefined) {
    if (!Array.isArray(textRaw)) errors.push('text 必须是数组')
    else {
      const blocks: ImagePromptTextBlock[] = []
      textRaw.forEach((item, index) => {
        const path = 'text[' + String(index) + ']'
        if (!isRecord(item)) { errors.push(path + ' 必须是对象'); return }
        const content = optionalString(item['content'], path + '.content', errors)
        if (content === undefined) { errors.push(path + '.content 必填且非空'); return }
        const block: ImagePromptTextBlock = { content }
        const kind = optionalString(item['kind'], path + '.kind', errors)
        if (kind !== undefined) block.kind = kind
        const speaker = optionalString(item['speaker'], path + '.speaker', errors)
        if (speaker !== undefined) block.speaker = speaker
        if (item['mustRenderExactly'] !== undefined) {
          if (typeof item['mustRenderExactly'] !== 'boolean') errors.push(path + '.mustRenderExactly 必须是布尔')
          else block.mustRenderExactly = item['mustRenderExactly']
        }
        blocks.push(block)
      })
      if (blocks.length > 0) value.text = blocks
    }
  }

  const charactersRaw = input['characters']
  if (charactersRaw !== undefined) {
    if (!Array.isArray(charactersRaw)) errors.push('characters 必须是数组')
    else {
      const characters: ImagePromptCharacter[] = []
      charactersRaw.forEach((item, index) => {
        const path = 'characters[' + String(index) + ']'
        if (!isRecord(item)) { errors.push(path + ' 必须是对象'); return }
        const name = optionalString(item['name'], path + '.name', errors)
        const sheet = optionalString(item['sheet'], path + '.sheet', errors)
        if (name === undefined) { errors.push(path + '.name 必填且非空'); return }
        if (sheet === undefined) { errors.push(path + '.sheet 必填且非空（跨页一致性依赖它）'); return }
        const character: ImagePromptCharacter = { name, sheet }
        const refImage = optionalString(item['refImage'], path + '.refImage', errors)
        if (refImage !== undefined) character.refImage = refImage
        characters.push(character)
      })
      if (characters.length > 0) value.characters = characters
    }
  }

  const technicalRaw = input['technical']
  if (technicalRaw !== undefined) {
    if (!isRecord(technicalRaw)) errors.push('technical 必须是对象')
    else {
      const technical: ImagePromptTechnical = {}
      const aspectRatio = technicalRaw['aspectRatio']
      if (aspectRatio !== undefined) {
        if (isAspectRatio(aspectRatio)) technical.aspectRatio = aspectRatio
        else errors.push('technical.aspectRatio 必须是 ' + ASPECT_RATIOS.join(' | '))
      }
      const resolution = technicalRaw['resolution']
      if (resolution !== undefined) {
        if (isResolution(resolution)) technical.resolution = resolution
        else errors.push('technical.resolution 必须是 ' + RESOLUTIONS.join(' | '))
      }
      const format = optionalString(technicalRaw['format'], 'technical.format', errors)
      if (format !== undefined) {
        if ((IMAGE_FORMATS as readonly string[]).includes(format)) technical.format = format as ImageFormat
        else errors.push('technical.format 必须是 ' + IMAGE_FORMATS.join(' | '))
      }
      const seed = technicalRaw['seed']
      if (seed !== undefined) {
        if (typeof seed === 'number' && Number.isFinite(seed)) technical.seed = seed
        else errors.push('technical.seed 必须是有限数字')
      }
      value.technical = technical
    }
  }

  const constraintsRaw = input['constraints']
  if (constraintsRaw !== undefined) {
    if (!isRecord(constraintsRaw)) errors.push('constraints 必须是对象')
    else {
      const constraints: ImagePromptConstraints = {}
      const must = stringList(constraintsRaw['must'], 'constraints.must', errors)
      if (must !== undefined) constraints.must = must
      const avoid = stringList(constraintsRaw['avoid'], 'constraints.avoid', errors)
      if (avoid !== undefined) constraints.avoid = avoid
      value.constraints = constraints
    }
  }

  const metaRaw = input['meta']
  if (metaRaw !== undefined) {
    if (!isRecord(metaRaw)) errors.push('meta 必须是对象')
    else {
      const meta: { source?: string; notes?: string } = {}
      const source = optionalString(metaRaw['source'], 'meta.source', errors)
      if (source !== undefined) meta.source = source
      const notes = optionalString(metaRaw['notes'], 'meta.notes', errors)
      if (notes !== undefined) meta.notes = notes
      value.meta = meta
    }
  }

  return { ok: errors.length === 0, errors, value }
}
