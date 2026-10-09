/**
 * 端点解析（独立模块，避免 route-probe 与各 provider 之间形成循环依赖）。
 *
 * baseUrl 与路径都可能带 /v1（用户填 https://host/v1 是常见写法），两端只保留一个，
 * 否则会拼出 /v1/v1/... —— 这是真机之外单测抓到过的实际缺陷。
 */

export const OPENAI_IMAGES_PATH = '/v1/images/generations'
export const OPENAI_MODELS_PATH = '/v1/models'
export const OPENAI_RESPONSES_PATH = '/v1/responses'

export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, '')
  const right = path.startsWith('/') ? path : '/' + path
  return left + right
}

/** 端点解析：显式 endpointPath 优先；否则用缺省路径，并避免与 baseUrl 里的 /v1 重复。 */
export function resolveEndpoint(baseUrl: string, endpointPath: string | undefined, fallback: string): string {
  const path = typeof endpointPath === 'string' && endpointPath.trim() !== '' ? endpointPath.trim() : fallback
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v1$/.test(base) && path.startsWith('/v1/')) return base + path.slice(3)
  return joinUrl(base, path)
}
