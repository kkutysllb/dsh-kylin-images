/**
 * 生成编排：工具面与 HTTP 路由共用的唯一入口。
 *
 * 顺序（每条都是设计规格里的硬约束）：
 *   解析通道 -> 编译提示词 -> 三层查价 -> 阈值确认 -> 缓存命中 -> 真生成 -> 落盘 -> 记账。
 * 抽出来是为了让「工具」「HTTP API」「批量」三条路走完全相同的语义，不会有第二条真相。
 */
import { join } from 'node:path'
import { composePrompt } from '../prompt/compose.ts'
import type { ComposedPrompt } from '../prompt/compose.ts'
import { defaultModelForKind } from '../provider/catalog.ts'
import { describeError } from '../provider/errors.ts'
import type { HttpOptions } from '../provider/http.ts'
import { describeQuote, needsConfirmation, quoteImages } from '../provider/pricing.ts'
import type { QuoteResult } from '../provider/pricing.ts'
import type { ChannelRecord, GeneratedImage } from '../provider/types.ts'
import { cacheKey } from '../store/cache.ts'
import { appendSpend } from '../store/spend.ts'
import type { PluginRuntime } from './registry.ts'

export interface GenerationInput {
  prompt: unknown
  channelId?: string | undefined
  model?: string | undefined
  outputDir?: string | undefined
  fileStem?: string | undefined
  count?: number | undefined
  seed?: number | undefined
  /** 用户已确认（超过阈值或未知价时的第二跳）。 */
  confirm?: boolean | undefined
  /** false 表示绕过缓存。 */
  useCache?: boolean | undefined
  /** 只算价不生成（批量预检用：避免预检就把钱花了）。 */
  dryRun?: boolean | undefined
  templatePitfalls?: readonly string[] | undefined
  referenceImages?: readonly string[] | undefined
  http?: HttpOptions | undefined
}

export interface GenerationOutcome {
  kind: 'generated' | 'cached' | 'confirm-required' | 'quoted' | 'error'
  message: string
  channelId: string
  model: string
  quote: QuoteResult
  images: GeneratedImage[]
  warnings: string[]
  composed: ComposedPrompt | undefined
  durationMs: number
}

function errorOutcome(message: string, channelId = '', model = ''): GenerationOutcome {
  return {
    kind: 'error',
    message,
    channelId,
    model,
    quote: { amount: 0, currency: 'CNY', confidence: 'unknown', source: 'unknown', note: '' },
    images: [],
    warnings: [],
    composed: undefined,
    durationMs: 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 简写：{ text: '自然语言' } -> ImagePrompt v1。 */
export function normalizePromptInput(raw: unknown): unknown {
  if (isRecord(raw) && typeof raw['text'] === 'string' && raw['schemaVersion'] === undefined) {
    const prompt: Record<string, unknown> = { schemaVersion: 1, intent: 'single-image', subject: raw['text'] }
    if (typeof raw['aspectRatio'] === 'string') prompt['technical'] = { aspectRatio: raw['aspectRatio'] }
    return prompt
  }
  return raw
}

export function resolveChannel(runtime: PluginRuntime, channelId?: string): ChannelRecord | undefined {
  const requested = typeof channelId === 'string' && channelId !== '' ? channelId : runtime.vault.settings().defaultChannelId
  if (requested === '') return undefined
  return runtime.vault.find(requested)
}

export async function runGeneration(runtime: PluginRuntime, input: GenerationInput): Promise<GenerationOutcome> {
  const settings = runtime.vault.settings()
  const channel = resolveChannel(runtime, input.channelId)
  if (channel === undefined) {
    return errorOutcome('尚未配置可用的图像通道。请在「视觉模型」设置里添加一个通道（mock 通道可零密钥先跑通全链路）。')
  }
  if (!channel.enabled) return errorOutcome('通道 ' + channel.id + ' 已被停用，请在「视觉模型」里启用或换一个通道。', channel.id)

  const model = (typeof input.model === 'string' && input.model !== '' ? input.model : '')
    || settings.defaultModel
    || channel.models[0]
    || defaultModelForKind(channel.kind)
  const count = Math.max(1, Math.min(4, Math.floor(input.count ?? settings.defaultCount)))
  const sizeStyle = runtime.sizeStyleFor(channel, model)

  const composed = composePrompt({
    prompt: normalizePromptInput(input.prompt),
    templatePitfalls: input.templatePitfalls,
    globalNegative: settings.globalNegative,
    sizeStyle,
  })
  const subjectMissing = composed.prompt.startsWith('SUBJECT: .')
    || composed.warnings.some((warning) => warning.includes('subject'))
  if (subjectMissing) {
    return errorOutcome('提示词缺少 subject（必填）。校验信息：' + composed.warnings.join('；'), channel.id, model)
  }

  const resolution = composed.size.resolution === undefined ? settings.defaultResolution : composed.size.resolution
  const quote = quoteImages({ channel, model, count, resolution: resolution as never })

  if (input.confirm !== true && needsConfirmation(quote, settings)) {
    return {
      kind: 'confirm-required',
      message: '本次生成需要先确认成本：' + describeQuote(quote) + '。确认后请带 confirm=true 重新调用。',
      channelId: channel.id,
      model,
      quote,
      images: [],
      warnings: composed.warnings,
      composed,
      durationMs: 0,
    }
  }

  if (input.dryRun === true) {
    return {
      kind: 'quoted',
      message: '仅报价未生成：' + describeQuote(quote) + '。',
      channelId: channel.id,
      model,
      quote,
      images: [],
      warnings: composed.warnings,
      composed,
      durationMs: 0,
    }
  }

  const outputDir = typeof input.outputDir === 'string' && input.outputDir !== '' ? input.outputDir : join(runtime.home, 'outputs')
  const fileStem = typeof input.fileStem === 'string' && input.fileStem !== '' ? input.fileStem : 'img-' + String(Date.now())
  const seed = input.seed
  const useCache = settings.cacheEnabled && input.useCache !== false
  const key = cacheKey({
    channelId: channel.id,
    model,
    prompt: composed.prompt,
    negative: composed.negative,
    size: composed.size.size ?? '',
    resolution: composed.size.resolution ?? '',
    count,
    seed,
  })

  if (useCache) {
    try {
      const cached = runtime.cache.materialize(key, outputDir, fileStem)
      if (cached !== undefined) {
        return {
          kind: 'cached',
          message: '缓存命中（同通道/模型/提示词/尺寸/张数/种子），未产生新成本。',
          channelId: channel.id,
          model,
          quote,
          images: cached.map((path) => ({ path, bytes: 0 })),
          warnings: composed.warnings,
          composed,
          durationMs: 0,
        }
      }
    } catch {
      // 缓存不可用不应阻断生成
    }
  }

  const started = Date.now()
  try {
    const result = await runtime.providerFor(channel).generate(channel, {
      channelId: channel.id,
      model,
      prompt: composed.prompt,
      negative: composed.negative,
      size: composed.size.size,
      resolution: composed.size.resolution,
      count,
      seed,
      quality: settings.defaultQuality,
      referenceImages: input.referenceImages === undefined ? undefined : [...input.referenceImages],
      outputDir,
      fileStem,
      http: input.http,
    })
    if (useCache) {
      try {
        runtime.cache.store(key, { channelId: channel.id, model, size: composed.size.size ?? '', resolution: composed.size.resolution ?? '', count, seed }, result.images.map((image) => image.path))
        runtime.cache.prune(settings.cacheMaxEntries)
      } catch {
        // 缓存写入失败不影响本次交付
      }
    }
    appendSpend(runtime.home, {
      at: new Date().toISOString(),
      channelId: channel.id,
      model: result.model,
      count: result.images.length,
      amount: quote.amount,
      currency: quote.currency,
      confidence: quote.confidence,
      promptChars: composed.prompt.length,
      durationMs: Date.now() - started,
    })
    return {
      kind: 'generated',
      message: '已通过通道 ' + channel.id + '（' + channel.kind + '）生成 ' + String(result.images.length) + ' 张图。',
      channelId: channel.id,
      model: result.model,
      quote,
      images: result.images,
      warnings: composed.warnings,
      composed,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      kind: 'error',
      message: describeError(error),
      channelId: channel.id,
      model,
      quote,
      images: [],
      warnings: composed.warnings,
      composed,
      durationMs: Date.now() - started,
    }
  }
}

/** 受限并发跑一批生成（保序返回结果）。 */
export async function runBatch(
  runtime: PluginRuntime,
  items: readonly GenerationInput[],
  concurrency: number,
): Promise<GenerationOutcome[]> {
  const results: GenerationOutcome[] = new Array(items.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(8, Math.floor(concurrency)))
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await runGeneration(runtime, item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker))
  return results
}
