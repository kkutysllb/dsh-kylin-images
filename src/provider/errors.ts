/**
 * 通道错误归一。
 *
 * 分类口径来自上游 Apimart 生产契约（分析 §5）与 dsh-video-generator 附录 B 实测：
 * 不同的中转站/官方端点在 HTTP 层信号不一致，但都能归到有限的几类，
 * 上层据此决定「可重试 / 要改配置 / 要用户确认」。
 */

export type ImageErrorCode =
  | 'API_KEY_INVALID'
  | 'BALANCE_REQUIRED'
  | 'RATE_LIMITED'
  | 'REQUEST_REJECTED'
  | 'UNAVAILABLE'
  | 'REQUEST_FAILED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BAD_RESPONSE'
  | 'TASK_FAILED'
  | 'URL_EXPIRED'

/** 可重试的错误：退避后再试有意义。 */
const RETRYABLE: readonly ImageErrorCode[] = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT', 'NETWORK']

export function isRetryable(code: ImageErrorCode): boolean {
  return RETRYABLE.includes(code)
}

export class ImageProviderError extends Error {
  readonly code: ImageErrorCode
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined
  readonly detail: string | undefined

  constructor(code: ImageErrorCode, message: string, options: {
    status?: number | undefined
    retryAfterMs?: number | undefined
    detail?: string | undefined
  } = {}) {
    super(message)
    this.name = 'ImageProviderError'
    this.code = code
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
    this.detail = options.detail
  }
}

export function isImageProviderError(value: unknown): value is ImageProviderError {
  return value instanceof ImageProviderError
}

function textOf(body: unknown): string {
  if (typeof body === 'string') return body
  if (typeof body !== 'object' || body === null) return ''
  const record = body as Record<string, unknown>
  const candidates: unknown[] = [
    record['message'],
    record['error'],
    record['detail'],
    record['code'],
  ]
  const error = record['error']
  if (typeof error === 'object' && error !== null) {
    const nested = error as Record<string, unknown>
    candidates.push(nested['message'], nested['code'], nested['type'])
  }
  return candidates
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase()
}

/** 从 HTTP 状态 + 响应体判定错误码。 */
export function classifyStatus(status: number, body: unknown): ImageErrorCode {
  const text = textOf(body)
  if (status === 401 || status === 403) {
    if (text.includes('moderation') || text.includes('safety')) return 'REQUEST_REJECTED'
    return 'API_KEY_INVALID'
  }
  if (status === 402) return 'BALANCE_REQUIRED'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 400 || status === 422) {
    if (text.includes('moderation') || text.includes('safety') || text.includes('nsfw')) return 'REQUEST_REJECTED'
    if (text.includes('balance') || text.includes('insufficient') || text.includes('quota')) return 'BALANCE_REQUIRED'
    return 'REQUEST_REJECTED'
  }
  if (status >= 500) return 'UNAVAILABLE'
  return 'REQUEST_FAILED'
}

const MAX_RETRY_AFTER_MS = 60_000
const MIN_RETRY_AFTER_MS = 1_000

function clampDelay(value: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(value)))
}

/**
 * 解析 Retry-After（秒数或 HTTP 日期），夹到 1s..60s。
 * 缺失或非法时返回给定的兜底值。
 */
export function retryAfterMs(headers: Headers | undefined, fallbackMs: number, nowMs: number = Date.now()): number {
  const raw = headers?.get('retry-after')
  if (typeof raw !== 'string' || raw.trim() === '') return fallbackMs
  const trimmed = raw.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds > 0) return clampDelay(seconds * 1000)
  const at = Date.parse(trimmed)
  if (Number.isFinite(at) && at > nowMs) return clampDelay(at - nowMs)
  return fallbackMs
}

/** 指数退避（基期 * 2^attempt），封顶 15 分钟。 */
export function backoffMs(attempt: number, baseMs: number, maxMs = 15 * 60 * 1000): number {
  const raw = baseMs * Math.pow(2, Math.max(0, attempt))
  const jitter = raw * 0.1 * Math.random()
  return Math.min(maxMs, Math.round(raw + jitter))
}

/** 面向用户的错误文案（工具面与卡片直接用这段）。 */
export function describeError(error: unknown): string {
  if (!isImageProviderError(error)) return error instanceof Error ? error.message : String(error)
  const advice: Record<ImageErrorCode, string> = {
    API_KEY_INVALID: '检查 API Key 是否正确、是否被吊销',
    BALANCE_REQUIRED: '账户余额或配额不足，请充值后重试',
    RATE_LIMITED: '触发限流，稍后重试或降低并发',
    REQUEST_REJECTED: '请求被拒（多为内容审核或参数不合法），调整提示词或尺寸后重试',
    UNAVAILABLE: '上游不可用，稍后重试',
    REQUEST_FAILED: '请求失败，检查 Base URL 与端点路径',
    TIMEOUT: '请求超时，可调大超时或检查网络',
    NETWORK: '网络不可达，检查 Base URL 与代理',
    BAD_RESPONSE: '响应结构无法识别，确认该通道的端点风格（同步 / 异步任务）',
    TASK_FAILED: '异步任务失败，查看上游返回的失败原因',
    URL_EXPIRED: '产物签名 URL 已过期，请重新生成',
  }
  const parts = ['[' + error.code + '] ' + error.message]
  if (error.status !== undefined) parts.push('HTTP ' + String(error.status))
  if (error.detail !== undefined && error.detail !== '') parts.push(error.detail.slice(0, 300))
  parts.push('建议：' + advice[error.code])
  return parts.join(' | ')
}
