/**
 * Responses API 图像通道适配器（GPT-Image 系在部分中转上的真实形态）。
 *
 * 背景（真机实测，2026-10-08，tianyuai.lol）：该部署把 `/v1/images/generations` 在 nginx 层
 * 直接 403 掉，图片模型只能走 Responses API：
 *
 *   POST {base}/v1/responses
 *   { "model": "gpt-image-2", "input": "<prompt>",
 *     "tools": [{ "type": "image_generation", "size": "1024x1536", "quality": "low" }] }
 *
 *   -> 200 { output: [ { type: 'image_generation_call', status: 'completed',
 *                       result: '<base64 PNG>', revised_prompt: '...' } ], usage: {...} }
 *
 * 与另两条适配器的区别：尺寸不是顶层字段而是**工具对象的参数**（因此 sizeStyle 固定为 pixels），
 * 产物是 base64 而非 URL（不发签名 URL，但同样立刻落盘）。
 */
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { ImageProviderError } from './errors.ts'
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, asUrlList, downloadToFile, pickPath, requestJson, writeBase64Image } from './http.ts'
import type { HttpOptions } from './http.ts'
import { effectiveSizeStyle, resolveModelSpec } from './catalog.ts'
import { OPENAI_MODELS_PATH, foldNegative, resolveEndpoint } from './openai-images.ts'
import type { ChannelRecord, GenerateRequest, GenerateResult, GeneratedImage, ImageProvider, ProbeResult, ProviderHealth } from './types.ts'

export const RESPONSES_PATH = '/v1/responses'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mimeOf(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return 'image/png'
}

export interface ResponsesImageCall {
  result?: string
  url?: string
  status: string
  revisedPrompt?: string
}

/** 从 Responses 响应里取出所有 image_generation_call 项。 */
export function extractImageCalls(body: unknown): ResponsesImageCall[] {
  const output = pickPath(body, ['output'])
  if (!Array.isArray(output)) return []
  const calls: ResponsesImageCall[] = []
  for (const item of output) {
    if (!isRecord(item)) continue
    if (item['type'] !== 'image_generation_call') continue
    const call: ResponsesImageCall = { status: typeof item['status'] === 'string' ? item['status'] : 'unknown' }
    if (typeof item['result'] === 'string' && item['result'] !== '') call.result = item['result']
    const urls = asUrlList(item['url'])
    if (urls[0] !== undefined) call.url = urls[0]
    if (typeof item['revised_prompt'] === 'string') call.revisedPrompt = item['revised_prompt']
    calls.push(call)
  }
  return calls
}

/** 响应里的图像 token 用量（成本按 token 计，实测约 0.74 额度/token）。 */
export function imageTokensOf(body: unknown): number | undefined {
  const value = pickPath(body, ['usage', 'completion_tokens_details', 'image_tokens'])
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 构造 image_generation 工具块：尺寸与质量是工具参数，不是顶层字段。 */
export function buildImageTool(request: GenerateRequest, supportsQuality: boolean, quality: string | undefined): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: 'image_generation' }
  if (typeof request.size === 'string' && request.size !== '') tool['size'] = request.size
  if (supportsQuality && typeof quality === 'string' && quality !== '' && quality !== 'auto') tool['quality'] = quality
  return tool
}

/** 构造请求体；有参考图时 input 用 parts 形态（Responses 文档形态）。 */
export function buildResponsesBody(
  request: GenerateRequest,
  options: { supportsNegative: boolean; supportsQuality: boolean; quality?: string | undefined; references?: readonly string[] | undefined },
): Record<string, unknown> {
  const text = options.supportsNegative ? request.prompt : foldNegative(request.prompt, request.negative)
  const references = options.references ?? []
  const body: Record<string, unknown> = {
    model: request.model,
    tools: [buildImageTool(request, options.supportsQuality, options.quality)],
  }
  if (references.length === 0) {
    body['input'] = text
    return body
  }
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text }]
  for (const path of references) {
    try {
      const data = readFileSync(path)
      content.push({ type: 'input_image', image_url: 'data:' + mimeOf(path) + ';base64,' + data.toString('base64') })
    } catch {
      // 参考图缺失不阻断生成
    }
  }
  body['input'] = [{ role: 'user', content }]
  return body
}

function timeoutOf(channel: ChannelRecord, http: HttpOptions | undefined): HttpOptions {
  return {
    timeoutMs: http?.timeoutMs ?? channel.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: http?.retries ?? channel.retries ?? DEFAULT_RETRIES,
    fetchImpl: http?.fetchImpl,
    sleepImpl: http?.sleepImpl,
  }
}

export class OpenAiResponsesProvider implements ImageProvider {
  readonly kind = 'openai-responses' as const

  private headers(channel: ChannelRecord): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (channel.apiKey !== '') headers['authorization'] = 'Bearer ' + channel.apiKey
    return headers
  }

  async health(channel: ChannelRecord, http?: HttpOptions): Promise<ProviderHealth> {
    const sizeStyle = effectiveSizeStyle(channel.sizeStyle, channel.kind, channel.models[0])
    if (channel.baseUrl === '') return { ok: false, detail: '通道未配置 Base URL', models: channel.models, sizeStyle }
    try {
      const response = await requestJson(
        resolveEndpoint(channel.baseUrl, undefined, OPENAI_MODELS_PATH),
        { method: 'GET', headers: this.headers(channel) },
        timeoutOf(channel, http),
      )
      const data = pickPath(response.body, ['data'])
      const models = Array.isArray(data)
        ? data.map((item) => (isRecord(item) ? String(item['id'] ?? '') : String(item))).filter((id) => id !== '')
        : []
      return {
        ok: true,
        detail: 'Responses 图像通道：/v1/models 可达（返回 ' + String(models.length) + ' 个模型）；生成走 ' + RESPONSES_PATH,
        models: models.length > 0 ? models : channel.models,
        sizeStyle,
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error), models: channel.models, sizeStyle }
    }
  }

  async probe(channel: ChannelRecord, options: { realRun?: boolean; http?: HttpOptions; outputDir?: string } = {}): Promise<ProbeResult> {
    const sizeStyle = effectiveSizeStyle(channel.sizeStyle, channel.kind, channel.models[0])
    const result: ProbeResult = { ok: false, auth: 'unknown', models: [], endpointStyle: 'responses-images', sizeStyle, detail: '' }
    if (channel.baseUrl === '') return { ...result, detail: '通道未配置 Base URL' }
    try {
      const response = await requestJson(
        resolveEndpoint(channel.baseUrl, undefined, OPENAI_MODELS_PATH),
        { method: 'GET', headers: this.headers(channel) },
        { ...timeoutOf(channel, options.http), retries: 0 },
      )
      const data = pickPath(response.body, ['data'])
      const models = Array.isArray(data)
        ? data.map((item) => (isRecord(item) ? String(item['id'] ?? '') : String(item))).filter((id) => id !== '')
        : []
      result.ok = true
      result.auth = 'ok'
      result.models = models.length > 0 ? models : channel.models
      result.detail = 'Responses 图像通道可用：/v1/models 返回 ' + String(models.length) + ' 个模型'
    } catch (error) {
      const code = error instanceof ImageProviderError ? error.code : 'REQUEST_FAILED'
      result.auth = code === 'API_KEY_INVALID' || code === 'BALANCE_REQUIRED' ? 'invalid' : 'unknown'
      result.detail = '探测失败：' + (error instanceof Error ? error.message : String(error))
    }
    if (options.realRun === true) {
      try {
        const generated = await this.generate(channel, {
          channelId: channel.id,
          model: channel.models[0] ?? '',
          prompt: 'A single small grey square centered on a pure white background, flat minimal.',
          size: '1024x1024',
          count: 1,
          outputDir: options.outputDir ?? join(process.cwd(), '.scratch', 'probe'),
          fileStem: 'probe-' + String(Date.now()),
          http: { ...options.http, retries: 0 },
        })
        result.ok = true
        result.realRun = { tried: true, ok: true, note: '小额实跑成功，落盘 ' + String(generated.images.length) + ' 张（' + String(generated.actualSize ?? '?') + '）' }
      } catch (error) {
        result.ok = false
        result.realRun = { tried: true, ok: false, note: error instanceof Error ? error.message : String(error) }
      }
    }
    return result
  }

  async generate(channel: ChannelRecord, request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now()
    const spec = resolveModelSpec(request.model)
    const count = Math.max(1, Math.min(4, Math.floor(request.count ?? 1)))
    const quality = typeof request.quality === 'string' ? request.quality : undefined
    const references = request.referenceImages ?? []
    const body = buildResponsesBody(request, {
      supportsNegative: spec.supportsNegative,
      supportsQuality: true,
      quality,
      references: spec.supportsReferenceImage ? references : [],
    })

    const response = await requestJson(
      resolveEndpoint(channel.baseUrl, channel.endpointPath, RESPONSES_PATH),
      { method: 'POST', headers: this.headers(channel), body: JSON.stringify(body) },
      timeoutOf(channel, request.http),
    )

    const calls = extractImageCalls(response.body)
    if (calls.length === 0) {
      const message = pickPath(response.body, ['error', 'message'])
      throw new ImageProviderError('BAD_RESPONSE', '响应里没有 image_generation_call 项', {
        detail: typeof message === 'string' ? message : JSON.stringify(response.body ?? {}).slice(0, 400),
      })
    }

    const images: GeneratedImage[] = []
    let index = 0
    for (const call of calls) {
      if (index >= count) break
      const suffix = calls.length === 1 ? '' : '-' + String(index + 1)
      const path = join(request.outputDir, request.fileStem + suffix + '.png')
      if (call.status === 'failed') {
        throw new ImageProviderError('TASK_FAILED', '图像生成调用失败（status=failed）')
      }
      if (call.result !== undefined) {
        images.push({ path, bytes: writeBase64Image(call.result, path) })
      } else if (call.url !== undefined) {
        images.push({ path, bytes: await downloadToFile(call.url, path, timeoutOf(channel, request.http)) })
      } else {
        continue
      }
      index += 1
    }
    if (images.length === 0) {
      throw new ImageProviderError('BAD_RESPONSE', 'image_generation_call 里既没有 result 也没有 url', {
        detail: JSON.stringify(response.body ?? {}).slice(0, 400),
      })
    }

    const tokens = imageTokensOf(response.body)
    return {
      images,
      quote: { amount: 0, currency: 'CNY', confidence: 'unknown' },
      channelId: channel.id,
      model: request.model,
      durationMs: Date.now() - started,
      actualSize: typeof request.size === 'string' ? request.size : undefined,
      raw: { imageTokens: tokens, revisedPrompt: calls[0]?.revisedPrompt },
    }
  }
}
