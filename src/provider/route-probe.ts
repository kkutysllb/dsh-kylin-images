/**
 * 端点可达性探测（零成本，绝不出图）。
 *
 * 现实问题：很多中转站的前置代理（nginx / WAF / 计费网关）会把某条路径整个拦掉，
 * 直接返回 HTML 403/404，而同一站点的另一条路径完全正常。此时：
 *   - GET /v1/models 往往仍然可达（甚至根本不校验 token）；
 *   - 真正的生成路径却全废。
 * 只看 /v1/models 会给出「通道健康」的假绿灯 —— 这是真机上踩过的坑：
 * 「测试通道」通过，一出图就 403 HTML，而错误文案还误报成 API Key 无效。
 *
 * 判定手法：向两条候选路径各发一次必然失败的请求 —— model 固定为不存在的哨兵值，
 * 上游只能回错误 JSON。若拿回来的是 HTML，说明请求压根没到 API 层，被代理拦了。
 * 哨兵模型不可能存在，因此这条请求不可能生成图片、不可能产生费用。
 */
import { OPENAI_IMAGES_PATH, OPENAI_RESPONSES_PATH, resolveEndpoint } from './endpoint.ts'
import type { HttpOptions } from './http.ts'
import type { ChannelKind } from './types.ts'

/** 哨兵模型名：上游不可能有，故该请求只可能失败，不可能产生费用。 */
export const ROUTE_PROBE_MODEL = '__dsh_route_probe__'
export const ROUTE_PROBE_TIMEOUT_MS = 15_000

export type RouteState = 'routed' | 'auth-rejected' | 'gateway-blocked' | 'unreachable'

export interface RouteVerdict {
  path: string
  state: RouteState
  status: number
  note: string
}

export type RecommendedStyle = 'sync-images' | 'responses-images' | 'unknown'

export interface RouteReport {
  images: RouteVerdict
  responses: RouteVerdict
  /** 依据证据给出的端点风格建议（两者都通时按同步出图记）。 */
  recommended: RecommendedStyle
  /** 与所配通道类型冲突时的处置建议；无冲突为空串。 */
  advice: string
}

/** 响应体像不像网关/反代的 HTML 错误页。 */
export function looksLikeHtml(text: string): boolean {
  const head = text.trim().slice(0, 240).toLowerCase()
  return head.startsWith('<') || head.includes('<html') || head.includes('<!doctype')
}

/** 路由是否真的到达了 API 层（凭据被拒也算到达：那是鉴权问题，不是路由问题）。 */
export function isRouted(state: RouteState): boolean {
  return state === 'routed' || state === 'auth-rejected'
}

export function classifyRoute(status: number, body: unknown, contentType: string): RouteState {
  if (typeof body === 'object' && body !== null) {
    return status === 401 || status === 403 ? 'auth-rejected' : 'routed'
  }
  const text = typeof body === 'string' ? body : ''
  if (contentType.toLowerCase().includes('html') || looksLikeHtml(text)) return 'gateway-blocked'
  if (text.trim() === '') return status >= 400 ? 'gateway-blocked' : 'routed'
  return status === 401 || status === 403 ? 'auth-rejected' : 'routed'
}

export function routeStateLabel(state: RouteState): string {
  if (state === 'routed') return '路由可达（返回 JSON）'
  if (state === 'auth-rejected') return '路由可达，凭据被拒（JSON 401/403）'
  if (state === 'gateway-blocked') return '被前置代理拦截（返回 HTML，未到 API 层）'
  return '不可达（网络错误或超时）'
}

async function probeOne(url: string, path: string, headers: Record<string, string>, http: HttpOptions): Promise<RouteVerdict> {
  const doFetch = http.fetchImpl ?? fetch
  const timeoutMs = Math.min(http.timeoutMs ?? ROUTE_PROBE_TIMEOUT_MS, ROUTE_PROBE_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: ROUTE_PROBE_MODEL, prompt: 'route probe (sentinel model, never generates)' }),
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') ?? ''
    const raw = await response.text().catch(() => '')
    let parsed: unknown
    if (raw.trim() === '') parsed = undefined
    else {
      try { parsed = JSON.parse(raw) as unknown } catch { parsed = raw }
    }
    return {
      path,
      state: classifyRoute(response.status, parsed, contentType),
      status: response.status,
      note: contentType === '' ? '无 content-type' : contentType,
    }
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    return {
      path,
      state: 'unreachable',
      status: 0,
      note: aborted ? '超时 ' + String(timeoutMs) + 'ms' : (error instanceof Error ? error.message : String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

function recommend(images: RouteVerdict, responses: RouteVerdict): RecommendedStyle {
  if (isRouted(responses.state) && !isRouted(images.state)) return 'responses-images'
  if (isRouted(images.state)) return 'sync-images'
  if (isRouted(responses.state)) return 'responses-images'
  return 'unknown'
}

export function routeAdvice(kind: ChannelKind, images: RouteVerdict, responses: RouteVerdict): string {
  const imageOk = isRouted(images.state)
  const responseOk = isRouted(responses.state)
  if (!imageOk && !responseOk) {
    if (images.state === 'unreachable' || responses.state === 'unreachable') {
      return '两条端点都不可达：核对 Base URL、网络与代理设置。'
    }
    return '两条端点都被前置代理拦截（返回 HTML 而非 API JSON）：核对 Base URL 与路径前缀，或该站点对服务端请求另有来源校验。'
  }
  if (!imageOk && responseOk && kind === 'openai-images') {
    return '该站点的 ' + images.path + ' 被前置代理拦截（HTTP ' + String(images.status) + ' / HTML），但 ' + responses.path + ' 可达：请把通道类型改为 openai-responses。'
  }
  if (imageOk && !responseOk && kind === 'openai-responses') {
    return '该站点的 ' + responses.path + ' 不可达，但 ' + images.path + ' 可达：请把通道类型改为 openai-images。'
  }
  return ''
}

/**
 * 对通道的两条 OpenAI 兼容路径做零成本可达性探测。
 * 用规范化缺省路径（不受通道 endpointPath 覆盖影响），因为目的是判断站点形态。
 */
export async function probeRoutes(
  channel: { baseUrl: string; kind: ChannelKind },
  headers: Record<string, string>,
  http: HttpOptions = {},
): Promise<RouteReport> {
  const imagesUrl = resolveEndpoint(channel.baseUrl, undefined, OPENAI_IMAGES_PATH)
  const responsesUrl = resolveEndpoint(channel.baseUrl, undefined, OPENAI_RESPONSES_PATH)
  const images = await probeOne(imagesUrl, OPENAI_IMAGES_PATH, headers, http)
  const responses = await probeOne(responsesUrl, OPENAI_RESPONSES_PATH, headers, http)
  return {
    images,
    responses,
    recommended: recommend(images, responses),
    advice: routeAdvice(channel.kind, images, responses),
  }
}

export function describeRoute(report: RouteReport): string {
  const lines = [
    '端点可达性（零成本探测：哨兵模型，必然失败，不会出图）',
    '- ' + report.images.path + '：' + report.images.state + '（HTTP ' + String(report.images.status) + '，' + routeStateLabel(report.images.state) + '）',
    '- ' + report.responses.path + '：' + report.responses.state + '（HTTP ' + String(report.responses.status) + '，' + routeStateLabel(report.responses.state) + '）',
    '证据可用的端点风格：' + report.recommended,
  ]
  // 处置建议由调用方放在「结论」里（report.advice），此处不再重复。
  return lines.join(String.fromCharCode(10))
}
