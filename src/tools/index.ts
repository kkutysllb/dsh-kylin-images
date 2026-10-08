/**
 * 工具面（img_*）。
 *
 * M1 交付三个：img_channels（通道健康与配置总览）、img_library（样式库检索）、
 * img_generate（结构化提示词 -> 编译 -> 生成 -> 落盘 -> 记账）。
 * img_compose / img_batch / img_comic 在 M2/M3 补齐。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { composePrompt } from '../prompt/compose.ts'
import { suggestTemplates } from '../prompt/match.ts'
import { loadLibrary, searchLibrary } from '../library/store.ts'
import type { Library } from '../library/store.ts'
import { appendSpend, readSpend, summarizeSpend } from '../store/spend.ts'
import type { PluginRuntime } from '../host/registry.ts'

export interface ToolOutput {
  schema: Record<string, unknown>
  render: (args: unknown, value: string) => Array<{ type: string; text: string }>
  presentationMeta: () => { title: string }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** DSH 工具契约强制要求：缺 output 会让整条插件行激活失败（真机 boot 实测）。 */
  output: ToolOutput
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** 纯文本工具输出契约。 */
function stringOutput(title: string): ToolOutput {
  return {
    schema: { type: 'string' },
    render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    presentationMeta: () => ({ title }),
  }
}

let cachedLibrary: Library | undefined

function library(): Library {
  if (cachedLibrary === undefined) cachedLibrary = loadLibrary()
  return cachedLibrary
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length === 0 ? undefined : out
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function channelsTool(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'img_channels',
    description: '查看图像生成通道的配置与健康状态（密钥一律脱敏），或对某个通道做连通性自检。',
    output: stringOutput('图像通道'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'test'], description: 'list=总览（默认）；test=自检指定通道' },
        id: { type: 'string', description: 'test 时的通道 id；缺省用默认通道' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const action = typeof args['action'] === 'string' ? args['action'] : 'list'
      if (action === 'test') {
        const id = typeof args['id'] === 'string' && args['id'] !== '' ? args['id'] : runtime.vault.settings().defaultChannelId
        const channel = runtime.vault.find(id)
        if (channel === undefined) return '找不到通道 ' + id + '。先用 img_channels action=list 查看已配置的通道。'
        const health = await runtime.providerFor(channel).health(channel)
        return [
          '通道 ' + channel.id + '（' + channel.label + '）自检' + (health.ok ? '通过' : '失败'),
          '类型：' + channel.kind + '，尺寸风格：' + health.sizeStyle,
          '可用模型：' + health.models.join(', '),
          '结论：' + health.detail,
        ].join('\n')
      }
      const settings = runtime.vault.settings()
      const channels = runtime.vault.publicList()
      const summary = summarizeSpend(readSpend(runtime.home))
      const lines = [
        '通道数：' + String(channels.length) + '（默认：' + (settings.defaultChannelId === '' ? '未设置' : settings.defaultChannelId) + '）',
      ]
      for (const channel of channels) {
        lines.push(
          '- ' + channel.id + ' | ' + channel.label + ' | ' + channel.kind + ' | key=' + (channel.apiKey === '' ? '（未配置）' : channel.apiKey) + ' | 模型=' + (channel.models.join(', ') || '（未声明）') + ' | ' + (channel.enabled ? '启用' : '停用'),
        )
      }
      lines.push('默认模型：' + (settings.defaultModel === '' ? '（未设置）' : settings.defaultModel))
      lines.push('默认尺寸：' + settings.defaultAspectRatio + ' / ' + settings.defaultResolution + ' / ' + settings.defaultFormat)
      lines.push('累计消耗：' + String(summary.total) + ' ' + summary.currency + '（' + String(summary.images) + ' 张 / ' + String(summary.entries) + ' 次）')
      return lines.join('\n')
    },
  }
}

function libraryTool(): ToolDefinition {
  return {
    name: 'img_library',
    output: stringOutput('图像样式库'),
    description: '检索图像提示词样式库（22 套工业模板 / 19 风格 / 10 场景 / 541 条社区案例），返回摘要与可选模板候选；不返回全文提示词，除非 include=prompt。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（中英均可）' },
        category: { type: 'string', description: '分类 id，如 cat-infographic' },
        styles: { type: 'array', items: { type: 'string' }, description: '风格标签，如 UI / Poster / Realistic' },
        scenes: { type: 'array', items: { type: 'string' }, description: '场景标签，如 Tech / Education' },
        tags: { type: 'array', items: { type: 'string' }, description: '细标签，如 Infographic / Dashboard' },
        limit: { type: 'number', description: '每类返回条数，1-20，默认 5' },
        include: { type: 'string', enum: ['summary', 'prompt'], description: 'prompt 才返回案例全文（token 开销大）' },
        locale: { type: 'string', enum: ['zh', 'en'], description: '文案语言，默认 zh' },
        suggest: { type: 'boolean', description: 'true 时额外返回 2-3 个模板候选与推荐理由' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const locale = typeof args['locale'] === 'string' ? args['locale'] : 'zh'
      const need = {
        query: typeof args['query'] === 'string' ? args['query'] : undefined,
        category: typeof args['category'] === 'string' ? args['category'] : undefined,
        styles: stringList(args['styles']),
        scenes: stringList(args['scenes']),
        tags: stringList(args['tags']),
      }
      const result = searchLibrary(library(), {
        ...need,
        limit: num(args['limit']) ?? 5,
        include: args['include'] === 'prompt' ? 'prompt' : 'summary',
      }, locale)
      const lines: string[] = [
        '模板命中 ' + String(result.totalTemplates) + ' 套，案例命中 ' + String(result.totalCases) + ' 条' + (result.nextCursor === undefined ? '' : '（下一页 cursor=' + String(result.nextCursor) + '）'),
      ]
      for (const hit of result.templates) {
        lines.push('')
        lines.push('[' + hit.id + '] ' + hit.title + ' — ' + hit.category + '（命中：' + hit.matched.join('; ') + '）')
        if (hit.useWhen !== '') lines.push('  适用：' + hit.useWhen)
        for (const pitfall of hit.pitfalls.slice(0, 3)) lines.push('  避坑：' + pitfall)
      }
      for (const hit of result.cases) {
        lines.push('')
        lines.push('案例 ' + String(hit.id) + '：' + hit.title + '（' + hit.category + '）')
        if (hit.prompt !== undefined) lines.push('  提示词：' + hit.prompt.slice(0, 600))
      }
      if (args['suggest'] === true) {
        lines.push('')
        lines.push('候选模板：')
        for (const candidate of suggestTemplates(library(), need, locale, 3)) {
          lines.push('  - ' + candidate.id + '：' + candidate.title + '（分数 ' + String(candidate.score) + '，' + candidate.matched.join('; ') + '）')
        }
      }
      return lines.join('\n')
    },
  }
}

function generateTool(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'img_generate',
    output: stringOutput('图像生成'),
    description: '按 ImagePrompt v1 契约生成图像：编译提示词与负面清单 -> 走已配置通道 -> 落盘 -> 记账，返回产物路径。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'object',
          description: 'ImagePrompt v1 对象（schemaVersion/intent/subject/...），或 { text: "自然语言" } 的简写',
        },
        channelId: { type: 'string', description: '通道 id；缺省用默认通道' },
        model: { type: 'string', description: '模型名；缺省用默认模型' },
        outputDir: { type: 'string', description: '产物目录；缺省 <插件数据目录>/outputs' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = runtime.vault.settings()
      const channelId = typeof args['channelId'] === 'string' && args['channelId'] !== ''
        ? args['channelId']
        : settings.defaultChannelId
      const channel = runtime.vault.find(channelId)
      if (channel === undefined) {
        return '尚未配置可用的图像通道。请在插件设置页的「视觉模型」里添加一个通道（mock 通道可零密钥先跑通全链路）。'
      }
      const raw = args['prompt']
      const promptInput = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && typeof (raw as Record<string, unknown>)['text'] === 'string'
        ? { schemaVersion: 1, intent: 'single-image', subject: String((raw as Record<string, unknown>)['text']) }
        : raw
      const composed = composePrompt({
        prompt: promptInput,
        globalNegative: settings.globalNegative,
        sizeStyle: channel.sizeStyle,
      })
      const subjectMissing = composed.prompt.startsWith('SUBJECT: .')
        || composed.warnings.some((warning) => warning.includes('subject'))
      if (subjectMissing) {
        return '提示词缺少 subject（必填）。校验信息：' + composed.warnings.join('；')
      }
      const outputDir = typeof args['outputDir'] === 'string' && args['outputDir'] !== ''
        ? args['outputDir']
        : join(runtime.home, 'outputs')
      mkdirSync(outputDir, { recursive: true, mode: 0o700 })
      const started = Date.now()
      const result = await runtime.providerFor(channel).generate(channel, {
        channelId: channel.id,
        model: typeof args['model'] === 'string' && args['model'] !== '' ? args['model'] : settings.defaultModel,
        prompt: composed.prompt,
        negative: composed.negative,
        size: composed.size.size,
        resolution: composed.size.resolution,
        count: settings.defaultCount,
        outputDir,
        fileStem: 'img-' + String(started),
      })
      appendSpend(runtime.home, {
        at: new Date().toISOString(),
        channelId: channel.id,
        model: result.model,
        count: result.images.length,
        amount: result.quote.amount,
        currency: result.quote.currency,
        confidence: result.quote.confidence,
        promptChars: composed.prompt.length,
        durationMs: Date.now() - started,
      })
      const lines = [
        '已通过通道 ' + channel.id + '（' + channel.kind + '）生成 ' + String(result.images.length) + ' 张图，耗时 ' + String(result.durationMs) + 'ms',
      ]
      for (const image of result.images) {
        lines.push('- ' + image.path + '（' + String(image.width ?? 0) + 'x' + String(image.height ?? 0) + '，' + String(image.bytes) + ' 字节）')
      }
      if (composed.negative !== '') lines.push('负面清单：' + composed.negative)
      for (const warning of composed.warnings) lines.push('提示：' + warning)
      lines.push('用 read_image 工具查看产物即可自评效果。')
      return lines.join('\n')
    },
  }
}

export function createTools(runtime: PluginRuntime): ToolDefinition[] {
  return [channelsTool(runtime), libraryTool(), generateTool(runtime)]
}
