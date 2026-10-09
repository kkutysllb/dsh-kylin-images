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
import { OPENAI_IMAGES_PATH, OPENAI_MODELS_PATH, joinUrl, resolveEndpoint } from './endpoint.ts'
import { isRouted, probeRoutes, routeStateLabel } from './route-probe.ts'
import type { RouteReport } from './route-probe.ts'
import type { ChannelRecord, GenerateRequest, GenerateResult, GeneratedImage, ImageProvider, ProbeResult, ProviderHealth } from './types.ts'

export { OPENAI_IMAGES_PATH, OPENAI_MODELS_PATH, joinUrl, resolveEndpoint }

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
    let models = channel.models
    let catalogNote = ''
    try {
      const response = await requestJson(
        resolveEndpoint(channel.baseUrl, undefined, OPENAI_MODELS_PATH),
        { method: 'GET', headers: this.headers(channel) },
        timeoutOf(channel, http),
      )
      const found = describeModels(response.body)
      models = found.length > 0 ? found : channel.models
      catalogNote = 'GET /v1/models 可达，返回 ' + String(found.length) + ' 个模型（该端点未必校验 token）'
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error), models: channel.models, sizeStyle }
    }
    // /v1/models 通不代表能出图：很多站的生成路径被前置代理单独拦掉，必须另测路由。
    const route = await this.routeReport(channel, http)
    const blocked = !isRouted(route.images.state)
    const routeNote = blocked
      ? '；但生成端点 ' + route.images.path + ' 不可用（HTTP ' + String(route.images.status) + '，' + routeStateLabel(route.images.state) + '），实际出图会失败。' + (route.advice === '' ? '' : route.advice)
      : '；生成端点 ' + route.images.path + ' 可达（HTTP ' + String(route.images.status) + '）'
    return { ok: !blocked, detail: catalogNote + routeNote, models, sizeStyle, route }
  }

  /** 零成本端点可达性探测：绝不出图（哨兵模型）。 */
  private async routeReport(channel: ChannelRecord, http?: HttpOptions): Promise<RouteReport> {
    return await probeRoutes(channel, this.headers(channel), { ...timeoutOf(channel, http), retries: 0 })
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
    // 只看 /v1/models 会给出假绿灯：加上零成本路由探测，并据证据修正端点风格。
    const route = await this.routeReport(channel, options.http)
    base.route = route
    if (route.recommended !== 'unknown') base.endpointStyle = route.recommended
    if (route.advice !== '') {
      base.ok = false
      base.detail = (base.detail === '' ? '' : base.detail + '；') + route.advice
    } else if (!isRouted(route.images.state) && base.ok) {
      base.ok = false
      base.detail = base.detail + '；但生成端点 ' + route.images.path + ' 不可用（' + routeStateLabel(route.images.state) + '），实际出图会失败。'
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
