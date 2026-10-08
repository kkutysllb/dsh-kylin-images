/**
 * 通道 HTTP 底座：超时、中止、退避重试、错误归一、落盘下载。
 *
 * 工程红线（继承 dsh-video-generator 的已验证结论）：
 *   - 所有 fetch 必须带 AbortController 与超时；
 *   - 429/5xx 指数退避，尊重 Retry-After；
 *   - 轮询超时视为失败，不记成功；
 *   - 签名 URL 必须立刻下载落盘（上游 URL 带 expires_at，存 URL 等于没存产物）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ImageProviderError, backoffMs, classifyStatus, isRetryable, retryAfterMs } from './errors.ts'

export interface HttpOptions {
  timeoutMs?: number | undefined
  retries?: number | undefined
  backoffBaseMs?: number | undefined
  headers?: Record<string, string> | undefined
  /** 测试注入点：替换 fetch（用于本地假上游）。 */
  fetchImpl?: typeof fetch | undefined
  /** 测试注入点：替换等待（避免测试真的睡）。 */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined
  method?: string | undefined
  /** 异步任务轮询间隔（默认 2s）。 */
  pollIntervalMs?: number | undefined
  /** 异步任务整体超时（默认 5 分钟；超时视为失败，不记成功）。 */
  pollTimeoutMs?: number | undefined
}

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_RETRIES = 3
export const DEFAULT_BACKOFF_BASE_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export interface JsonResponse {
  status: number
  body: unknown
  headers: Headers
}

/**
 * 发一次 JSON 请求并归类错误；可重试错误会按退避重试。
 * 返回 {status, body, headers}；非 2xx 一律抛 ImageProviderError。
 */
export async function requestJson(url: string, init: RequestInit, options: HttpOptions = {}): Promise<JsonResponse> {
  const doFetch = options.fetchImpl ?? fetch
  const wait = options.sleepImpl ?? sleep
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    let response: Response
    try {
      response = await doFetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      clearTimeout(timer)
      const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
      const wrapped = new ImageProviderError(
        aborted ? 'TIMEOUT' : 'NETWORK',
        aborted ? '请求超时（' + String(timeoutMs) + 'ms）' : '网络请求失败',
        { detail: error instanceof Error ? error.message : String(error) },
      )
      lastError = wrapped
      if (attempt < retries && isRetryable(wrapped.code)) {
        await wait(backoffMs(attempt, backoffBase))
        continue
      }
      throw wrapped
    }
    clearTimeout(timer)

    const raw = await response.text().catch(() => '')
    let body: unknown = undefined
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw) as unknown
      } catch {
        body = raw
      }
    }

    if (response.ok) return { status: response.status, body, headers: response.headers }

    const code = classifyStatus(response.status, body)
    const wrapped = new ImageProviderError(code, '上游返回 HTTP ' + String(response.status), {
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers, backoffMs(attempt, backoffBase)),
      detail: typeof body === 'string' ? body : JSON.stringify(body ?? {}).slice(0, 500),
    })
    lastError = wrapped
    if (attempt < retries && isRetryable(code)) {
      await wait(wrapped.retryAfterMs ?? backoffMs(attempt, backoffBase))
      continue
    }
    throw wrapped
  }
  throw lastError instanceof Error ? lastError : new ImageProviderError('REQUEST_FAILED', '请求失败')
}

/** 下载远程图片到本地（签名 URL 必须立刻落盘）。 */
export async function downloadToFile(url: string, path: string, options: HttpOptions = {}): Promise<number> {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await doFetch(url, { signal: controller.signal })
    if (!response.ok) {
      const status = response.status
      throw new ImageProviderError(
        status === 403 || status === 404 ? 'URL_EXPIRED' : classifyStatus(status, undefined),
        '下载产物失败：HTTP ' + String(status),
        { status },
      )
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0) {
      throw new ImageProviderError('BAD_RESPONSE', '下载到的产物为空')
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, buffer)
    return buffer.byteLength
  } catch (error) {
    if (error instanceof ImageProviderError) throw error
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    throw new ImageProviderError(aborted ? 'TIMEOUT' : 'NETWORK', '下载产物失败', {
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 把 base64 图片写盘，返回字节数。 */
export function writeBase64Image(data: string, path: string): number {
  const payload = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.byteLength === 0) throw new ImageProviderError('BAD_RESPONSE', '上游返回的 base64 图片为空')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buffer)
  return buffer.byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从任意层级的响应体里取嵌套字段（容错，缺任一层返回 undefined）。 */
export function pickPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/** 把可能是数组也可能是单值的字段归一成字符串数组。 */
export function asUrlList(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item !== '')
  return []
}
