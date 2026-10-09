/**
 * 工具面（img_*）。
 *
 * 分工：技能负责流程与判断，工具负责编译与执行。
 * 全部工具共用 host/generate.ts 的编排，保证工具、HTTP API、批量三条路语义一致。
 */
import { join } from 'node:path'
import { composePrompt } from '../prompt/compose.ts'
import { suggestTemplates } from '../prompt/match.ts'
import { loadLibrary, searchLibrary } from '../library/store.ts'
import type { Library } from '../library/store.ts'
import { describeError } from '../provider/errors.ts'
import { describeQuote } from '../provider/pricing.ts'
import { describeRoute } from '../provider/route-probe.ts'
import { readSpend, summarizeSpend } from '../store/spend.ts'
import { runBatch, runGeneration } from '../host/generate.ts'
import { listProjects, runComicAction } from '../comic/service.ts'
import type { ComicActionInput } from '../comic/service.ts'
import { describePlan } from '../comic/plan.ts'
import type { GenerationInput, GenerationOutcome } from '../host/generate.ts'
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function describeOutcome(outcome: GenerationOutcome): string {
  const lines: string[] = [outcome.message]
  for (const image of outcome.images) {
    const size = image.width === undefined ? '' : '（' + String(image.width) + 'x' + String(image.height) + '）'
    lines.push('- ' + image.path + size)
  }
  if (outcome.kind === 'generated') lines.push('成本：' + describeQuote(outcome.quote))
  if (outcome.composed !== undefined && outcome.composed.negative !== '') {
    lines.push('负面清单：' + outcome.composed.negative)
  }
  for (const warning of outcome.warnings) lines.push('提示：' + warning)
  if (outcome.images.length > 0) lines.push('用 read_image 查看产物即可自评效果。')
  return lines.join(String.fromCharCode(10))
}

function channelsTool(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'img_channels',
    output: stringOutput('图像通道'),
    description: '查看图像生成通道的配置与健康状态（密钥一律脱敏）；test=连通性自检，probe=完整探测（模型枚举 + 鉴权 + 端点可达性 + 端点风格，可选小额实跑）。两者的端点可达性探测均为零成本：用不存在的哨兵模型发必然失败的请求，不会出图、不产生费用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'test', 'probe'], description: 'list=总览（默认）；test=健康；probe=探测' },
        id: { type: 'string', description: '通道 id；缺省用默认通道' },
        realRun: { type: 'boolean', description: 'probe 时是否做一次小额真实生成（会产生费用）' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const action = typeof args['action'] === 'string' ? args['action'] : 'list'
      const id = typeof args['id'] === 'string' && args['id'] !== '' ? args['id'] : runtime.vault.settings().defaultChannelId
      if (action === 'test' || action === 'probe') {
        const channel = runtime.vault.find(id)
        if (channel === undefined) return '找不到通道 ' + id + '。先用 img_channels action=list 查看已配置的通道。'
        const provider = runtime.providerFor(channel)
        if (action === 'probe' && provider.probe !== undefined) {
          const result = await provider.probe(channel, { realRun: args['realRun'] === true })
          const lines = [
            '通道 ' + channel.id + '（' + channel.label + '）探测' + (result.ok ? '通过' : '未通过'),
            '鉴权：' + result.auth + '，端点风格：' + result.endpointStyle + '，尺寸风格：' + result.sizeStyle,
            '模型数：' + String(result.models.length) + (result.models.length === 0 ? '' : '（' + result.models.slice(0, 12).join(', ') + '）'),
            '结论：' + result.detail,
          ]
          if (result.route !== undefined) lines.push(describeRoute(result.route))
          lines.push(result.realRun === undefined ? '小额实跑：未执行' : '小额实跑：' + (result.realRun.ok ? '成功' : '失败') + ' — ' + result.realRun.note)
          return lines.join(String.fromCharCode(10))
        }
        const health = await provider.health(channel)
        const lines = [
          '通道 ' + channel.id + '（' + channel.label + '）自检' + (health.ok ? '通过' : '失败'),
          '类型：' + channel.kind + '，尺寸风格：' + health.sizeStyle,
          '可用模型：' + health.models.join(', '),
          '结论：' + health.detail,
        ]
        if (health.route !== undefined) lines.push(describeRoute(health.route))
        return lines.join(String.fromCharCode(10))
      }
      const settings = runtime.vault.settings()
      const channels = runtime.vault.publicList()
      const summary = summarizeSpend(readSpend(runtime.home))
      const cacheStats = runtime.cache.stats()
      const lines = [
        '通道数：' + String(channels.length) + '（默认：' + (settings.defaultChannelId === '' ? '未设置' : settings.defaultChannelId) + '）',
      ]
      for (const channel of channels) {
        lines.push(
          '- ' + channel.id + ' | ' + channel.kind + ' | key=' + (channel.apiKey === '' ? '（未配置）' : channel.apiKey) + ' | 模型=' + (channel.models.join(', ') || '（未声明）') + ' | 尺寸风格=' + runtime.sizeStyleFor(channel) + ' | ' + (channel.enabled ? '启用' : '停用'),
        )
      }
      lines.push('默认模型：' + (settings.defaultModel === '' ? '（未设置）' : settings.defaultModel))
      lines.push('默认尺寸：' + settings.defaultAspectRatio + ' / ' + settings.defaultResolution + ' / ' + settings.defaultFormat)
      lines.push('累计消耗：' + String(summary.total) + ' ' + summary.currency + '（' + String(summary.images) + ' 张 / ' + String(summary.entries) + ' 次）')
      lines.push('缓存：' + String(cacheStats.entries) + ' 条，命中 ' + String(cacheStats.hits) + ' 次')
      return lines.join(String.fromCharCode(10))
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
        query: str(args['query']),
        category: str(args['category']),
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
      return lines.join(String.fromCharCode(10))
    },
  }
}

function promptParam(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'ImagePrompt v1 对象（schemaVersion/intent/subject/...），或 { text: "自然语言" } 的简写',
  }
}

function composeTool(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'img_compose',
    output: stringOutput('提示词编译预览'),
    description: '只编译不生成：把 ImagePrompt v1 编译成最终提示词 + 负面清单 + 通道尺寸字段，供人工或模型先审阅（零成本）。可在生成前用它校验契约、发现缺字段。',
    parameters: {
      type: 'object',
      properties: {
        prompt: promptParam(),
        templateId: { type: 'string', description: '套用某个样式库模板：自动并入该模板的避坑指南' },
        channelId: { type: 'string', description: '按该通道的尺寸风格编译；缺省用默认通道' },
        locale: { type: 'string', enum: ['zh', 'en'], description: '模板文案语言，默认 zh' },
        sizeStyle: { type: 'string', enum: ['pixels', 'ratio-resolution', 'ignore'], description: '显式指定尺寸风格（覆盖通道推断）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const settings = runtime.vault.settings()
      const channel = runtime.vault.find(str(args['channelId']) ?? settings.defaultChannelId)
      const sizeStyle = args['sizeStyle'] === 'pixels' || args['sizeStyle'] === 'ratio-resolution' || args['sizeStyle'] === 'ignore'
        ? args['sizeStyle']
        : channel === undefined ? 'ratio-resolution' : runtime.sizeStyleFor(channel)
      const templateId = str(args['templateId'])
      const locale = typeof args['locale'] === 'string' ? args['locale'] : 'zh'
      let pitfalls: string[] | undefined
      if (templateId !== undefined) {
        const template = library().templates.find((item) => item.id === templateId)
        if (template === undefined) return '样式库里没有模板 ' + templateId + '。用 img_library 检索可用模板。'
        pitfalls = locale === 'en' ? (template.pitfalls.en ?? template.pitfalls.zh ?? []) : (template.pitfalls.zh ?? template.pitfalls.en ?? [])
      }
      const composed = composePrompt({
        prompt: args['prompt'],
        templatePitfalls: pitfalls,
        globalNegative: settings.globalNegative,
        sizeStyle,
      })
      const lines: string[] = []
      if (templateId !== undefined) lines.push('模板：' + templateId)
      lines.push('尺寸风格：' + sizeStyle + '，请求字段：' + JSON.stringify(composed.size))
      lines.push('')
      lines.push('=== 最终提示词 ===')
      lines.push(composed.prompt)
      lines.push('')
      lines.push('=== 负面清单 ===')
      lines.push(composed.negative === '' ? '（空）' : composed.negative)
      lines.push('')
      lines.push('分段顺序：' + composed.sections.map((section) => section.split(':')[0]).join(' -> '))
      for (const warning of composed.warnings) lines.push('提示：' + warning)
      return lines.join(String.fromCharCode(10))
    },
  }
}

function generateTool(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'img_generate',
    output: stringOutput('图像生成'),
    description: '按 ImagePrompt v1 契约生成图像：编译提示词与负面清单 -> 成本护栏 -> 缓存 -> 走已配置通道 -> 落盘 -> 记账。超预算或未知价时会先返回确认请求，带 confirm=true 重调即可。',
    parameters: {
      type: 'object',
      properties: {
        prompt: promptParam(),
        templateId: { type: 'string', description: '套用样式库模板（自动并入避坑指南）' },
        channelId: { type: 'string', description: '通道 id；缺省用默认通道' },
        model: { type: 'string', description: '模型名；缺省用默认模型或通道声明的第一个' },
        count: { type: 'number', description: '张数 1-4，缺省用设置里的默认值' },
        seed: { type: 'number', description: '随机种子（通道/模型支持时生效）' },
        outputDir: { type: 'string', description: '产物目录；缺省 <插件数据目录>/outputs' },
        confirm: { type: 'boolean', description: '已确认成本时置 true' },
        useCache: { type: 'boolean', description: 'false 强制重新生成' },
        referenceImages: { type: 'array', items: { type: 'string' }, description: '参考图本地路径（跨页一致性）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const templateId = str(args['templateId'])
      let pitfalls: string[] | undefined
      if (templateId !== undefined) {
        const template = library().templates.find((item) => item.id === templateId)
        pitfalls = template === undefined ? undefined : (template.pitfalls.zh ?? template.pitfalls.en ?? [])
      }
      const input: GenerationInput = {
        prompt: args['prompt'],
        channelId: str(args['channelId']),
        model: str(args['model']),
        outputDir: str(args['outputDir']),
        count: num(args['count']),
        seed: num(args['seed']),
        confirm: args['confirm'] === true,
        useCache: args['useCache'] === false ? false : undefined,
        templatePitfalls: pitfalls,
        referenceImages: stringList(args['referenceImages']),
      }
      return describeOutcome(await runGeneration(runtime, input))
    },
  }
}

function batchTool(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'img_batch',
    output: stringOutput('批量生成'),
    description: '批量生成（漫画逐页 / 多变体）：逐项独立编译与记账，受限并发、失败不拖垮整批、缓存命中即跳过。整批预估超预算或存在未知价时，先返回确认请求。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '每项 = { prompt, templateId?, channelId?, model?, count?, seed?, outputDir?, fileStem? }',
          items: { type: 'object' },
        },
        concurrency: { type: 'number', description: '并发 1-8，缺省用设置值' },
        confirm: { type: 'boolean', description: '已确认总成本时置 true' },
        onlyPending: { type: 'boolean', description: 'true 时跳过已存在产物的项（断点续跑）' },
      },
      required: ['items'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const rawItems = Array.isArray(args['items']) ? args['items'] : []
      if (rawItems.length === 0) return 'items 为空：每项至少要有 prompt。'
      if (rawItems.length > 40) return '单次批量最多 40 项（当前 ' + String(rawItems.length) + '）：请分批以保证可恢复。'
      const settings = runtime.vault.settings()
      const cacheDir = join(runtime.home, 'outputs')
      const items: GenerationInput[] = []
      for (const raw of rawItems) {
        const item = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
        if (item['prompt'] === undefined) return 'items 里存在缺少 prompt 的项。'
        items.push({
          prompt: item['prompt'],
          channelId: str(item['channelId']),
          model: str(item['model']),
          outputDir: str(item['outputDir']) ?? cacheDir,
          fileStem: str(item['fileStem']),
          count: num(item['count']),
          seed: num(item['seed']),
          confirm: args['confirm'] === true,
          templatePitfalls: undefined,
        })
      }

      // 先做一遍成本预检：整批里任何一项需要确认就整体先确认（避免跑一半停下）
      if (args['confirm'] !== true) {
        // dryRun：预检绝不能真的生成（否则预检就把钱花了，这是联调时抓到的真实缺陷）
        const probes = await runBatch(runtime, items.map((item) => ({ ...item, confirm: false, dryRun: true })), 1)
        const blocked = probes.filter((outcome) => outcome.kind === 'confirm-required')
        const failed = probes.filter((outcome) => outcome.kind === 'error')
        if (failed.length === probes.length) {
          return '整批均无法执行：' + (failed[0]?.message ?? '未知错误')
        }
        if (blocked.length > 0) {
          const total = probes.reduce((sum, outcome) => sum + outcome.quote.amount, 0)
          return [
            '整批需要先确认成本：' + String(blocked.length) + ' / ' + String(probes.length) + ' 项超阈值或未知价，合计约 ' + String(Math.round(total * 10000) / 10000) + ' CNY。',
            '确认后请带 confirm=true 重新调用（已确认的项会自动命中缓存，不会重复计费）。',
          ].join(String.fromCharCode(10))
        }
      }

      const results = await runBatch(runtime, items, num(args['concurrency']) ?? settings.concurrency)
      const generated = results.filter((outcome) => outcome.kind === 'generated').length
      const cached = results.filter((outcome) => outcome.kind === 'cached').length
      const errors = results.filter((outcome) => outcome.kind === 'error')
      const lines = [
        '批量完成：新生成 ' + String(generated) + '，缓存命中 ' + String(cached) + '，失败 ' + String(errors.length) + '（共 ' + String(results.length) + '）',
      ]
      results.forEach((outcome, index) => {
        const paths = outcome.images.map((image) => image.path).join(', ')
        lines.push(String(index + 1) + '. [' + outcome.kind + '] ' + (paths === '' ? outcome.message : paths))
      })
      if (errors.length > 0) {
        lines.push('失败项可用同样的 items 重跑（成功的项会命中缓存，不会重复付费）。')
      }
      return lines.join(String.fromCharCode(10))
    },
  }
}

function comicTool(runtime: PluginRuntime): ToolDefinition {
  return {
    name: 'img_comic',
    output: stringOutput('知识漫画'),
    description: [
      '知识漫画项目全生命周期：open（开项目 + 按内容信号自动选型）/ plan（落盘角色表与分镜，并编译每页 ImagePrompt v1）',
      '/ sheet（角色三视图，图像锁）/ render（逐页出图，文字锁 + 图像锁 + 风格锁）/ status / assemble（零依赖联系表）。',
      '插件不做 LLM 调用：分析与分镜由你产出，本工具负责校验、编译、执行与组装。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'plan', 'sheet', 'render', 'status', 'assemble'] },
        id: { type: 'string', description: '项目标识（open 之后返回）' },
        topic: { type: 'string', description: 'open：主题或标题' },
        source: { type: 'string', description: 'open：源内容（长文/资料整理稿）' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'open：内容信号关键词（用于自动选型），缺省用 topic' },
        plan: { type: 'object', description: 'open：显式覆盖视觉方案 { artStyle, tone, layout, aspectRatio }' },
        channelId: { type: 'string', description: 'open：指定通道；缺省用默认通道' },
        model: { type: 'string', description: 'open：指定模型' },
        imageLock: { type: 'boolean', description: 'open：是否启用图像锁（角色三视图做参考图），默认开' },
        dir: { type: 'string', description: '项目根目录；缺省 <插件数据目录>/comics' },
        analysis: { type: 'string', description: 'plan：分析文本（写入 analysis.md）' },
        characters: { type: 'array', description: 'plan：角色表 [{ name, sheet }]，sheet 是给模型的外观描述（越细越一致）', items: { type: 'object' } },
        storyboard: { type: 'object', description: 'plan：分镜 { pages: [{ title, core?, scene?, characters?, layout?, shot?, panels?, focus?, dialogue?: [{speaker?,text}], narration? }] }' },
        pages: { type: 'array', items: { type: 'number' }, description: 'render：只渲染这些页号；缺省渲染所有未完成的页' },
        concurrency: { type: 'number', description: 'render：并发 1-8' },
        confirm: { type: 'boolean', description: 'render/sheet：已确认成本时置 true' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const action = String(args['action'] ?? '')
      const id = str(args['id'])
      if (action === 'status' && id === undefined) {
        const projects = listProjects(runtime)
        if (projects.length === 0) return '还没有漫画项目。用 img_comic action=open topic="..." 开一个。'
        return ['共 ' + String(projects.length) + ' 个项目：'].concat(projects.map((project) => {
          const done = project.pages.filter((page) => page.status === 'rendered').length
          return '- ' + project.id + ' | ' + project.topic + ' | ' + project.stage + ' | ' + String(done) + '/' + String(project.pages.length) + ' 页 | ' + describePlan(project.plan)
        })).join(String.fromCharCode(10))
      }
      const planInput = args['plan']
      const input: ComicActionInput = {
        action,
        id,
        topic: str(args['topic']),
        source: str(args['source']),
        analysis: str(args['analysis']),
        keywords: stringList(args['keywords']),
        plan: typeof planInput === 'object' && planInput !== null && !Array.isArray(planInput)
          ? (planInput as ComicActionInput['plan'])
          : undefined,
        channelId: str(args['channelId']),
        model: str(args['model']),
        dir: str(args['dir']),
        imageLock: args['imageLock'] === false ? false : undefined,
        characters: args['characters'],
        storyboard: args['storyboard'],
        pages: Array.isArray(args['pages']) ? args['pages'].filter((item): item is number => typeof item === 'number') : undefined,
        concurrency: num(args['concurrency']),
        confirm: args['confirm'] === true,
      }
      const outcome = await runComicAction(runtime, input)
      const lines = [outcome.message]
      for (const artifact of outcome.artifacts) lines.push('- ' + artifact)
      if (outcome.project !== undefined && outcome.artifacts.length > 0) {
        const images = outcome.artifacts.filter((path) => path.endsWith('.png'))
        if (images.length > 0) lines.push('用 read_image 查看产物即可自评。')
      }
      return lines.join(String.fromCharCode(10))
    },
  }
}

export function createTools(runtime: PluginRuntime): ToolDefinition[] {
  return [
    channelsTool(runtime),
    libraryTool(),
    composeTool(runtime),
    generateTool(runtime),
    batchTool(runtime),
    comicTool(runtime),
  ]
}

void describeError
