/**
 * 端点风格自动回退。
 *
 * 场景（真机必然复现，不是偶发）：某些中转站只用前置代理放行一条出图路径。
 * 用户把通道类型配成另一条时，img_generate 会在网关就被 403 HTML 拦掉 —— 无论试多少次。
 * 修复首要是让用户能选对类型（设置页下拉 + 编辑既有通道），
 * 但「已经配错的人」不该为此重配一遍：出错时自动换到可用那条，并明确告知。
 *
 * 安全边界：
 *   - 只对同一份凭据、同一个站点的两条 OpenAI 兼容出图路径互换（openai-images <-> openai-responses）；
 *   - 首次请求在网关即被拦，没有产生费用，所以回退不会造成双重计费；
 *   - 回退前先做零成本可达性探测，探测不通就不回退（避免拿 30s 去撞墙）；
 *   - 通道可用 autoFallback=false 关闭。
 */
import { isImageProviderError } from './errors.ts'
import type { HttpOptions } from './http.ts'
import { isRouted, probeRoutes } from './route-probe.ts'
import type { ChannelKind, ChannelRecord } from './types.ts'

/** 可互相回退的类型对。task-images 协议不同，不参与自动互换。 */
const FALLBACK_PAIRS: ReadonlyArray<readonly [ChannelKind, ChannelKind]> = [
  ['openai-images', 'openai-responses'],
]

export function alternateKindFor(kind: ChannelKind): ChannelKind | undefined {
  for (const pair of FALLBACK_PAIRS) {
    if (kind === pair[0]) return pair[1]
    if (kind === pair[1]) return pair[0]
  }
  return undefined
}

/** 「端点被前置代理拦截」是唯一值得换端点重试的错误 —— 换一条路就有机会成功。 */
export function isEndpointBlocked(error: unknown): boolean {
  return isImageProviderError(error) && error.code === 'ENDPOINT_BLOCKED'
}

export function alternateChannel(channel: ChannelRecord, kind: ChannelKind): ChannelRecord {
  return { ...channel, kind }
}

function authHeaders(channel: ChannelRecord): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (channel.apiKey !== '') headers['authorization'] = 'Bearer ' + channel.apiKey
  return headers
}

/** 本次失败该换到哪个类型：返回 undefined 表示不回退。注意这是零成本探测，不出图。 */
export async function planFallback(
  channel: ChannelRecord,
  error: unknown,
  options: { http?: HttpOptions | undefined } = {},
): Promise<{ kind: ChannelKind; channel: ChannelRecord; note: string } | undefined> {
  if (channel.autoFallback === false) return undefined
  if (!isEndpointBlocked(error)) return undefined
  const alternate = alternateKindFor(channel.kind)
  if (alternate === undefined) return undefined
  const target = alternateChannel(channel, alternate)
  let report
  try {
    report = await probeRoutes(target, authHeaders(channel), { fetchImpl: options.http?.fetchImpl, retries: 0 })
  } catch {
    return undefined
  }
  const wanted = alternate === 'openai-responses' ? report.responses : report.images
  const blocked = alternate === 'openai-responses' ? report.images : report.responses
  if (!isRouted(wanted.state)) return undefined
  const status = isImageProviderError(error) && error.status !== undefined ? '（HTTP ' + String(error.status) + '）' : ''
  return {
    kind: alternate,
    channel: target,
    note: '通道类型 ' + channel.kind + ' 的 ' + blocked.path + ' 被前置代理拦截' + status
      + '，本次已自动改用 ' + alternate + ' 出图（' + wanted.path + ' 零成本探测可达）。'
      + '建议把该通道的类型直接改成 ' + alternate + '，避免每次都走一遍回退。',
  }
}
