/**
 * 异步任务式图像通道适配器（聚合站常见：提交 -> 轮询 -> 取签名 URL）。
 *
 * 契约来自上游 Apimart 的生产实现（分析 §5）：
 *   提交 POST {base}/v1/images/generations {model,prompt,n,size,resolution}
 *   任务 id  data[0].task_id / data.task_id / id       形如 task_xxx
 *   状态     data.status: in_progress -> processing，终态 completed | failed
 *   产物     data.result.images[0].url（可能是数组）+ expires_at（必须立刻下载）
 */
import { join } from 'node:path'
import { ImageProviderError } from './errors.ts'
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, asUrlList, downloadToFile, pickPath, requestJson } from './http.ts'
import type { HttpOptions } from './http.ts'
import { effectiveSizeStyle, resolveModelSpec } from './catalog.ts'
import { OPENAI_MODELS_PATH, foldNegative, referenceImagePayload, resolveEndpoint } from './openai-images.ts'
import type { ChannelRecord, GenerateRequest, GenerateResult, GeneratedImage, ImageProvider, ProbeResult, ProviderHealth } from './types.ts'

export const TASK_SUBMIT_PATH = '/v1/images/generations'
export const TASK_STATUS_PATH = '/v1/tasks/{id}'
export const DEFAULT_POLL_INTERVAL_MS = 2_000
export const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'unknown'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 任务查询地址：statusPath 支持 {id} 占位符。 */
export function taskStatusUrl(baseUrl: string, statusPath: string | undefined, taskId: string): string {
  const template = typeof statusPath === 'string' && statusPath.trim() !== '' ? statusPath.trim() : TASK_STATUS_PATH
  const path = template.split('{id}').join(encodeURIComponent(taskId))
  return resolveEndpoint(baseUrl, path, path)
}

export function extractTaskId(body: unknown): string {
  const candidates: unknown[] = [
    pickPath(body, ['data', '0', 'task_id']),
    pickPath(body, ['data', 'task_id']),
    pickPath(body, ['data', '0', 'id']),
    pickPath(body, ['data', 'id']),
    pickPath(body, ['task_id']),
    pickPath(body, ['id']),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/** 状态归一：in_progress -> processing；未知状态保持 unknown（轮询继续，由超时兜底）。 */
export function normalizeTaskStatus(body: unknown): TaskStatus {
  const data = pickPath(body, ['data'])
  const holder = isRecord(data) ? data : isRecord(body) ? body : undefined
  const raw = holder === undefined ? undefined : holder['status']
  const status = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (status === 'in_progress') return 'processing'
  if (status === 'pending' || status === 'queued' || status === 'submitted') return 'pending'
  if (status === 'processing' || status === 'running') return 'processing'
  if (status === 'completed' || status === 'succeeded' || status === 'success') return 'completed'
  if (status === 'failed' || status === 'error' || status === 'cancelled') return 'failed'
  return 'unknown'
}

/** 从任务响应里取产物 URL（容忍 url 为数组、images 为对象数组两种形态）。 */
export function extractImageUrls(body: unknown): string[] {
  const arrayCandidates: unknown[] = [
    pickPath(body, ['data', 'result', 'images']),
    pickPath(body, ['result', 'images']),
    pickPath(body, ['data', 'images']),
    pickPath(body, ['images']),
  ]
  for (const candidate of arrayCandidates) {
    if (!Array.isArray(candidate)) continue
    const collected: string[] = []
    for (const item of candidate) {
      if (typeof item === 'string') collected.push(item)
      else if (isRecord(item)) collected.push(...asUrlList(item['url']))
    }
    if (collected.length > 0) return collected
  }
  const singleCandidates: unknown[] = [
    pickPath(body, ['data', 'result', 'images', '0', 'url']),
    pickPath(body, ['data', 'result', 'url']),
    pickPath(body, ['data', 'url']),
    pickPath(body, ['url']),
  ]
  for (const candidate of singleCandidates) {
    const urls = asUrlList(candidate)
    if (urls.length > 0) return urls
  }
  return []
}

export function extractTaskError(body: unknown): string {
  const candidates: unknown[] = [
    pickPath(body, ['data', 'error', 'message']),
    pickPath(body, ['data', 'error_message']),
    pickPath(body, ['error', 'message']),
    pickPath(body, ['message']),
    pickPath(body, ['data', 'error', 'code']),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return '上游未给出失败原因'
}

function timeoutOf(channel: ChannelRecord, http: HttpOptions | undefined): HttpOptions {
  return {
    timeoutMs: http?.timeoutMs ?? channel.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: http?.retries ?? channel.retries ?? DEFAULT_RETRIES,
    fetchImpl: http?.fetchImpl,
    sleepImpl: http?.sleepImpl,
    pollIntervalMs: http?.pollIntervalMs,
    pollTimeoutMs: http?.pollTimeoutMs,
  }
}

export class TaskImagesProvider implements ImageProvider {
  readonly kind = 'task-images' as const

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
        detail: '异步任务通道：/v1/models 可达（返回 ' + String(models.length) + ' 个模型）',
        models: models.length > 0 ? models : channel.models,
        sizeStyle,
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error), models: channel.models, sizeStyle }
    }
  }

  async probe(channel: ChannelRecord, options: { realRun?: boolean; http?: HttpOptions; outputDir?: string } = {}): Promise<ProbeResult> {
    const sizeStyle = effectiveSizeStyle(channel.sizeStyle, channel.kind, channel.models[0])
    const result: ProbeResult = { ok: false, auth: 'unknown', models: [], endpointStyle: 'task-images', sizeStyle, detail: '' }
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
      result.detail = '异步任务通道可用：/v1/models 返回 ' + String(models.length) + ' 个模型；产物为带 expires_at 的签名 URL'
    } catch (error) {
      const code = error instanceof ImageProviderError ? error.code : 'REQUEST_FAILED'
      result.auth = code === 'API_KEY_INVALID' || code === 'BALANCE_REQUIRED' ? 'invalid' : 'unknown'
      result.detail = '探测失败：' + (error instanceof Error ? error.message : String(error))
    }
    if (options.realRun === true) {
      try {
        const probeDir = options.outputDir ?? join(process.cwd(), '.scratch', 'probe')
        const generated = await this.generate(channel, {
          channelId: channel.id,
          model: channel.models[0] ?? '',
          prompt: 'probe: a small grey square on white background',
          count: 1,
          outputDir: probeDir,
          fileStem: 'probe-' + String(Date.now()),
          http: { ...options.http, retries: 0 },
        })
        result.ok = true
        result.realRun = { tried: true, ok: true, note: '小额实跑成功，落盘 ' + String(generated.images.length) + ' 张' }
      } catch (error) {
        result.ok = false
        result.realRun = { tried: true, ok: false, note: error instanceof Error ? error.message : String(error) }
      }
    }
    return result
  }

  async generate(channel: ChannelRecord, request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now()
    const http = timeoutOf(channel, request.http)
    const sleep = request.http?.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
    const pollInterval = request.http?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const pollTimeout = request.http?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const spec = resolveModelSpec(request.model)
    const count = Math.max(1, Math.min(4, Math.floor(request.count ?? 1)))

    const body: Record<string, unknown> = {
      model: request.model,
      prompt: spec.supportsNegative ? request.prompt : foldNegative(request.prompt, request.negative),
      n: count,
    }
    if (request.size !== undefined) body['size'] = request.size
    if (request.resolution !== undefined) body['resolution'] = request.resolution
    if (spec.supportsSeed && request.seed !== undefined) body['seed'] = request.seed
    const references = request.referenceImages ?? []
    if (references.length > 0 && spec.supportsReferenceImage) body['input_images'] = referenceImagePayload(references)

    const submitted = await requestJson(
      resolveEndpoint(channel.baseUrl, channel.endpointPath, TASK_SUBMIT_PATH),
      { method: 'POST', headers: this.headers(channel), body: JSON.stringify(body) },
      http,
    )
    const taskId = extractTaskId(submitted.body)
    if (taskId === '') {
      throw new ImageProviderError('BAD_RESPONSE', '提交成功但响应里没有任务 id', {
        detail: JSON.stringify(submitted.body ?? {}).slice(0, 400),
      })
    }

    const statusUrl = taskStatusUrl(channel.baseUrl, channel.statusPath, taskId)
    let lastStatus: TaskStatus = 'unknown'
    while (Date.now() - started < pollTimeout) {
      await sleep(pollInterval)
      const polled = await requestJson(statusUrl, { method: 'GET', headers: this.headers(channel) }, { ...http, retries: 0 })
      lastStatus = normalizeTaskStatus(polled.body)
      if (lastStatus === 'completed') {
        const urls = extractImageUrls(polled.body)
        if (urls.length === 0) {
          throw new ImageProviderError('BAD_RESPONSE', '任务已完成但没有产物 URL', {
            detail: JSON.stringify(polled.body ?? {}).slice(0, 400),
          })
        }
        const images: GeneratedImage[] = []
        for (let index = 0; index < urls.length; index += 1) {
          const url = urls[index]
          if (url === undefined) continue
          const suffix = urls.length === 1 ? '' : '-' + String(index + 1)
          const path = join(request.outputDir, request.fileStem + suffix + '.png')
          const bytes = await downloadToFile(url, path, http)
          images.push({ path, bytes })
        }
        return {
          images,
          quote: { amount: 0, currency: 'CNY', confidence: 'unknown' },
          channelId: channel.id,
          model: request.model,
          durationMs: Date.now() - started,
          raw: polled.body,
        }
      }
      if (lastStatus === 'failed') {
        throw new ImageProviderError('TASK_FAILED', '异步任务失败：' + extractTaskError(polled.body), {
          detail: JSON.stringify(polled.body ?? {}).slice(0, 400),
        })
      }
    }
    throw new ImageProviderError(
      'TIMEOUT',
      '任务 ' + taskId + ' 轮询超时（' + String(pollTimeout) + 'ms，最后状态 ' + lastStatus + '）',
      { detail: statusUrl },
    )
  }
}
