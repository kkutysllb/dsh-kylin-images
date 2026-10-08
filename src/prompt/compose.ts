/**
 * 编译器：ImagePrompt v1 -> 通道请求（prompt / negative / size）。
 *
 * 这是本插件的核心资产：上游的 pitfalls、漫画的角色表、模板的约束，
 * 全部在这里确定性地落进最终提示词。纯函数，同输入恒同输出。
 */
import { GENERIC_NEGATIVE, buildConstraintLines, negativeString } from './negatives.ts'
import { validateImagePrompt } from './schema.ts'
import type { ImagePrompt } from './schema.ts'
import { toProviderSize } from './sizes.ts'
import type { ProviderSize, SizeStyle } from './sizes.ts'
import { artStylePhrase, layoutPhrase, tonePhrase } from './vocab.ts'

export interface ComposeOptions {
  /** 待编译的 ImagePrompt（未知输入，内部走校验器）。 */
  prompt: unknown
  /** 所选模板的避坑指南（已按语言取出；进 CONSTRAINTS 段，不进 negative）。 */
  templatePitfalls?: readonly string[] | undefined
  /** 用户全局追加的负面词（来自「视觉模型」配置菜单）。 */
  globalNegative?: readonly string[] | undefined
  /** 通道尺寸风格；缺省 ratio-resolution（聚合站最常见）。 */
  sizeStyle?: SizeStyle | undefined
  /** 是否并入通用负面词，默认并入。 */
  includeGenericNegative?: boolean | undefined
}

export interface ComposedPrompt {
  /** 最终发给通道的提示词正文。 */
  prompt: string
  /** 最终负面清单（逗号分隔，可为空串）。 */
  negative: string
  /** 按通道尺寸风格翻译出的请求字段。 */
  size: ProviderSize
  /** 分段结果，顺序即注入顺序（便于测试与人工预览）。 */
  sections: string[]
  /** 校验与降级提示；非致命，不阻断生成。 */
  warnings: string[]
}

function joinList(values: readonly string[] | undefined): string {
  return values === undefined ? '' : values.join(', ')
}

/** 编译一个 ImagePrompt。永不抛异常：校验错误降级为 warnings。 */
export function composePrompt(options: ComposeOptions): ComposedPrompt {
  const warnings: string[] = []
  const validated = validateImagePrompt(options.prompt)
  for (const error of validated.errors) warnings.push('校验：' + error)
  const prompt: ImagePrompt = validated.value

  const sections: string[] = []

  // 1 风格序言（跨页风格锁定的锚点：同样输入必须产出同样的这段文本）
  const styleBits: string[] = []
  const art = artStylePhrase(prompt.style?.artStyle)
  if (art !== '') styleBits.push(art)
  const tone = tonePhrase(prompt.style?.tone)
  if (tone !== '') styleBits.push(tone)
  if (prompt.style?.tags !== undefined && prompt.style.tags.length > 0) {
    styleBits.push('style tags: ' + joinList(prompt.style.tags))
  }
  if (prompt.style?.materials !== undefined && prompt.style.materials.length > 0) {
    styleBits.push('materials: ' + joinList(prompt.style.materials))
  }
  if (styleBits.length > 0) sections.push('STYLE: ' + styleBits.join('; ') + '.')

  // 2 主体
  sections.push('SUBJECT: ' + prompt.subject + '.')

  // 3 构图
  const compositionBits: string[] = []
  const layout = layoutPhrase(prompt.composition?.layout)
  if (layout !== '') compositionBits.push(layout)
  if (prompt.composition?.shot !== undefined) compositionBits.push('shot: ' + prompt.composition.shot)
  if (prompt.composition?.hierarchy !== undefined && prompt.composition.hierarchy.length > 0) {
    compositionBits.push('visual hierarchy: ' + joinList(prompt.composition.hierarchy))
  }
  if (prompt.composition?.panels !== undefined && prompt.composition.panels.length > 0) {
    compositionBits.push('panels in order: ' + prompt.composition.panels.join(' | '))
  }
  if (compositionBits.length > 0) sections.push('COMPOSITION: ' + compositionBits.join('; ') + '.')

  // 4 角色表（逐字注入：跨页一致性的文字锁）
  const characters = prompt.characters ?? []
  if (characters.length > 0) {
    const lines = characters.map((character, index) => {
      const ref = character.refImage === undefined ? '' : ' [reference image: ' + character.refImage + ']'
      return String(index + 1) + '. ' + character.name + ': ' + character.sheet + ref
    })
    sections.push('CHARACTERS (keep identical in every page):' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)))
  }

  // 5 画面内文字（逐字锁定）
  const textBlocks = prompt.text ?? []
  if (textBlocks.length > 0) {
    const lines = textBlocks.map((block, index) => {
      const bits: string[] = [String.fromCharCode(34) + block.content + String.fromCharCode(34)]
      if (block.kind !== undefined) bits.push('as ' + block.kind)
      if (block.speaker !== undefined) bits.push('spoken by ' + block.speaker)
      bits.push(block.mustRenderExactly === true
        ? 'render this text exactly, character for character, no substitutions and no gibberish'
        : 'render this text clearly')
      return String(index + 1) + '. ' + bits.join(', ')
    })
    sections.push('TEXT IN IMAGE (verbatim):' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)))
    if (textBlocks.some((block) => block.mustRenderExactly !== true)) {
      warnings.push('有画面内文字未标记 mustRenderExactly，出字准确率可能下降')
    }
  }

  // 6 技术参数
  const technicalBits: string[] = []
  if (prompt.technical?.aspectRatio !== undefined) technicalBits.push('aspect ratio ' + prompt.technical.aspectRatio)
  if (prompt.technical?.resolution !== undefined) technicalBits.push('resolution ' + prompt.technical.resolution)
  if (prompt.technical?.format !== undefined) technicalBits.push('format ' + prompt.technical.format)
  if (prompt.technical?.seed !== undefined) technicalBits.push('seed ' + String(prompt.technical.seed))
  if (prompt.intent === 'comic-page') technicalBits.push('single comic page, page layout fully inside the frame')
  if (technicalBits.length > 0) sections.push('TECHNICAL: ' + technicalBits.join('; ') + '.')

  // 7 约束（must + 模板 pitfalls）
  const constraintLines = buildConstraintLines({
    must: prompt.constraints?.must,
    pitfalls: options.templatePitfalls,
  })
  if (constraintLines.length > 0) {
    sections.push('CONSTRAINTS:' + String.fromCharCode(10) + '- ' + constraintLines.join(String.fromCharCode(10) + '- '))
  }
  if (prompt.templateId !== undefined && options.templatePitfalls === undefined) {
    warnings.push('prompt 指定了模板 ' + prompt.templateId + '，但未提供该模板的 pitfalls，约束段缺少上游避坑知识')
  }

  const size = toProviderSize({
    aspectRatio: prompt.technical?.aspectRatio ?? '1:1',
    resolution: prompt.technical?.resolution ?? '1k',
    sizeStyle: options.sizeStyle ?? 'ratio-resolution',
  })

  const negative = negativeString([
    options.includeGenericNegative === false ? undefined : GENERIC_NEGATIVE,
    prompt.constraints?.avoid,
    options.globalNegative,
  ])

  return { prompt: sections.join(String.fromCharCode(10)), negative, size, sections, warnings }
}
