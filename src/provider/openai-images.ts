/**
 * 同步图像通道适配器（OpenAI 兼容 images/generations）。
 *
 * 覆盖两种现实形态：
 *   - 官方/多数中转：请求 size 为像素串（1024x1536），响应 data[0].b64_json 或 data[0].url；
 *   - 聚合站：size 为比例串（1:1）+ resolution（1k/2k/4k），响应仍是 OpenAI 信封。
 * 两者由通道的 sizeStyle 决定，本适配器不感知具体站点。
 */
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { ImageProviderError } from './errors.ts'
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, asUrlList, downloadToFile, pickPath, requestJson, writeBase64Image } from './http.ts'
import type { HttpOptions } from './http.ts'
import { effectiveSizeStyle, resolveModelSpec } from './catalog.ts'
import type { ChannelRecord, GenerateRequest, GenerateResult, GeneratedImage, ImageProvider, ProbeResult, ProviderHealth } from './types.ts'

export const OPENAI_IMAGES_PATH = '/v1/images/generations'
export const OPENAI_MODELS_PATH = '/v1/models'

export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, '')
  const right = path.startsWith('/') ? path : '/' + path
  return left + right
}

/** 端点解析：显式 endpointPath 优先；否则用缺省路径，并避免与 baseUrl 里的 /v1 重复。 */
/**
 * 端点解析。
 *
 * baseUrl 与路径都可能带 /v1（用户填 https://host/v1 是常见写法），两端只保留一个，
 * 否则会拼出 /v1/v1/... —— 这是真机之外单测抓到过的实际缺陷。
 */
export function resolveEndpoint(baseUrl: string, endpointPath: string | undefined, fallback: string): string {
  const path = typeof endpointPath === 'string' && endpointPath.trim() !== '' ? endpointPath.trim() : fallback
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v1$/.test(base) && path.startsWith('/v1/')) return base + path.slice(3)
  return joinUrl(base, path)
}

function mimeOf(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return 'image/png'
}

/** 参考图 -> data URL（聚合站与官方改图接口都吃这一形态）。 */
export function referenceImagePayload(paths: readonly string[]): Array<Record<string, unknown>> {
  const payload: Array<Record<string, unknown>> = []
  for (const path of paths) {
    try {
      const data = readFileSync(path)
      payload.push({ type: 'input_image', image_url: 'data:' + mimeOf(path) + ';base64,' + data.toString('base64') })
    } catch {
      // 参考图缺失不应阻断生成：跳过并在 warnings 之外的地方由调用方感知
    }
  }
  return payload
}

/** 把负向清单折进提示词（当前主流图像 API 没有原生负向字段）。 */
export function foldNegative(prompt: string, negative: string | undefined): string {
  const trimmed = typeof negative === 'string' ? negative.trim() : ''
  if (trimmed === '') return prompt
  return prompt + String.fromCharCode(10, 10) + 'Strictly avoid: ' + trimmed + '.'
}

function timeoutOf(channel: ChannelRecord, http: HttpOptions | undefined): HttpOptions {
  return {
    timeoutMs: http?.timeoutMs ?? channel.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: http?.retries ?? channel.retries ?? DEFAULT_RETRIES,
    fetchImpl: http?.fetchImpl,
    sleepImpl: http?.sleepImpl,
  }
}

function describeModels(body: unknown): string[] {
  const data = pickPath(body, ['data'])
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const item of data) {
    if (typeof item === 'string') ids.push(item)
    else if (typeof item === 'object' && item !== null) {
      const id = (item as Record<string, unknown>)['id']
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

export class OpenAiImagesProvider implements ImageProvider {
  readonly kind = 'openai-images' as const

  async health(channel: ChannelRecord, http?: HttpOptions): Promise<ProviderHealth> {
    const sizeStyle = effectiveSizeStyle(channel.sizeStyle, channel.kind, channel.models[0])
    if (channel.baseUrl === '') {
      return { ok: false, detail: '通道未配置 Base URL', models: channel.models, sizeStyle }
    }
    try {
      const response = await requestJson(
        resolveEndpoint(channel.baseUrl, undefined, OPENAI_MODELS_PATH),
        { method: 'GET', headers: this.headers(channel) },
        timeoutOf(channel, http),
      )
      const models = describeModels(response.body)
      return {
        ok: true,
        detail: 'GET /v1/models 可达，返回 ' + String(models.length) + ' 个模型（该端点未必校验 token，鉴权结论请用「测试通道」探测）',
        models: models.length > 0 ? models : channel.models,
        sizeStyle,
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error), models: channel.models, sizeStyle }
    }
  }

  async probe(channel: ChannelRecord, options: { realRun?: boolean; http?: HttpOptions; outputDir?: string } = {}): Promise<ProbeResult> {
    const sizeStyle = effectiveSizeStyle(channel.sizeStyle, channel.kind, channel.models[0])
    const base: ProbeResult = {
      ok: false,
      auth: 'unknown',
      models: [],
      endpointStyle: 'sync-images',
      sizeStyle,
      detail: '',
    }
    if (channel.baseUrl === '') return { ...base, detail: '通道未配置 Base URL' }
    try {
      const response = await requestJson(
        resolveEndpoint(channel.baseUrl, undefined, OPENAI_MODELS_PATH),
        { method: 'GET', headers: this.headers(channel) },
        { ...timeoutOf(channel, options.http), retries: 0 },
      )
      const models = describeModels(response.body)
      base.ok = true
      base.models = models.length > 0 ? models : channel.models
      base.auth = 'ok'
      base.detail = 'GET /v1/models 可达并接受当前凭据，返回 ' + String(models.length) + ' 个模型'
    } catch (error) {
      const code = error instanceof ImageProviderError ? error.code : 'REQUEST_FAILED'
      base.auth = code === 'API_KEY_INVALID' || code === 'BALANCE_REQUIRED' ? 'invalid' : 'unknown'
      base.detail = 'GET /v1/models 失败：' + (error instanceof Error ? error.message : String(error))
    }
    if (options.realRun === true) {
      try {
        const probeDir = options.outputDir ?? join(process.cwd(), '.scratch', 'probe')
        const result = await this.generate(channel, {
          channelId: channel.id,
          model: channel.models[0] ?? '',
          prompt: 'probe: a small grey square on white background',
          count: 1,
          outputDir: probeDir,
          fileStem: 'probe-' + String(Date.now()),
          http: { ...options.http, retries: 0 },
        })
        base.ok = true
        base.realRun = { tried: true, ok: true, note: '小额实跑成功，落盘 ' + String(result.images.length) + ' 张（尺寸 ' + (result.actualSize ?? '未知') + '）' }
      } catch (error) {
        base.ok = false
        base.realRun = { tried: true, ok: false, note: error instanceof Error ? error.message : String(error) }
      }
    }
    return base
  }

  private headers(channel: ChannelRecord): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (channel.apiKey !== '') headers['authorization'] = 'Bearer ' + channel.apiKey
    return headers
  }

  async generate(channel: ChannelRecord, request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now()
    const spec = resolveModelSpec(request.model)
    const count = Math.max(1, Math.min(4, Math.floor(request.count ?? 1)))
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: spec.supportsNegative ? request.prompt : foldNegative(request.prompt, request.negative),
      n: count,
    }
    if (request.size !== undefined) body['size'] = request.size
    if (request.resolution !== undefined) body['resolution'] = request.resolution
    if (spec.supportsNegative && typeof request.negative === 'string' && request.negative !== '') {
      body['negative_prompt'] = request.negative
    }
    if (spec.supportsSeed && request.seed !== undefined) body['seed'] = request.seed
    const references = request.referenceImages ?? []
    if (references.length > 0 && spec.supportsReferenceImage) {
      body['input_images'] = referenceImagePayload(references)
    }

    const response = await requestJson(
      resolveEndpoint(channel.baseUrl, channel.endpointPath, OPENAI_IMAGES_PATH),
      { method: 'POST', headers: this.headers(channel), body: JSON.stringify(body) },
      timeoutOf(channel, request.http),
    )

    const data = pickPath(response.body, ['data'])
    if (!Array.isArray(data) || data.length === 0) {
      throw new ImageProviderError('BAD_RESPONSE', '响应里没有 data 数组（该通道可能是异步任务式，请改用 task-images 类型）', {
        detail: JSON.stringify(response.body ?? {}).slice(0, 400),
      })
    }

    const images: GeneratedImage[] = []
    let imageIndex = 0
    for (const item of data) {
      const entry = item as Record<string, unknown>
      const suffix = count === 1 ? '' : '-' + String(imageIndex + 1)
      const path = join(request.outputDir, request.fileStem + suffix + '.png')
      const base64 = entry['b64_json']
      if (typeof base64 === 'string' && base64 !== '') {
        const bytes = writeBase64Image(base64, path)
        images.push({ path, bytes })
      } else {
        const urls = asUrlList(entry['url'])
        const url = urls[0]
        if (url === undefined) continue
        const bytes = await downloadToFile(url, path, timeoutOf(channel, request.http))
        images.push({ path, bytes })
      }
      imageIndex += 1
    }
    if (images.length === 0) {
      throw new ImageProviderError('BAD_RESPONSE', '上游未返回任何可落盘的图片（既无 b64_json 也无 url）')
    }

    const actualSize = typeof (data[0] as Record<string, unknown>)['size'] === 'string'
      ? String((data[0] as Record<string, unknown>)['size'])
      : undefined
    return {
      images,
      quote: { amount: 0, currency: 'CNY', confidence: 'unknown' },
      channelId: channel.id,
      model: request.model,
      durationMs: Date.now() - started,
      actualSize,
      raw: response.body,
    }
  }
}
