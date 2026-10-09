/**
 * 端点可达性探测的回归测试。
 *
 * 这些用例锁定的是一次真机事故：中转站把 /v1/images/generations 在 nginx 层 403 掉，
 * GET /v1/models 却完全正常，于是「测试通道」给出假绿灯，一出图就 403 HTML，
 * 错误文案还误报成「API Key 无效」。现在必须靠证据说话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUTE_PROBE_MODEL,
  classifyRoute,
  isRouted,
  looksLikeHtml,
  probeRoutes,
  routeAdvice,
  routeStateLabel,
} from '../src/provider/route-probe.ts'
import { OpenAiImagesProvider } from '../src/provider/openai-images.ts'
import { classifyStatus, describeError, ImageProviderError } from '../src/provider/errors.ts'
import type { ChannelRecord } from '../src/provider/types.ts'
import { jsonResponse, makeFetch, textResponse } from './helpers.ts'

const GATEWAY_HTML = '<html><head><title>403 Forbidden</title></head><body><center>403</center></body></html>'

function channel(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    id: 'relay',
    label: '中转',
    kind: 'openai-images',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-test-key-value',
    models: ['gpt-image-2'],
    enabled: true,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  }
}

test('路由分类：HTML 错误页 = 被代理拦，JSON 错误 = 到达 API 层', () => {
  // 前置代理拦截：拿回 HTML，请求没到 API 层
  assert.equal(classifyRoute(403, GATEWAY_HTML, 'text/html'), 'gateway-blocked')
  assert.equal(classifyRoute(404, '<!DOCTYPE html><html></html>', 'text/html'), 'gateway-blocked')
  // 空响应体的 4xx 同样不可能是 API 的正常答复
  assert.equal(classifyRoute(404, undefined, ''), 'gateway-blocked')
  // API 层的错误 JSON 说明路由是通的（503 model_not_found 就是真机实证）
  assert.equal(classifyRoute(503, { error: { code: 'model_not_found' } }, 'application/json'), 'routed')
  assert.equal(classifyRoute(400, { error: { message: 'model required' } }, 'application/json'), 'routed')
  assert.equal(classifyRoute(200, { ok: true }, 'application/json'), 'routed')
  // 凭据被拒也算路由可达：那是鉴权问题，不是路由问题
  assert.equal(classifyRoute(401, { error: { message: 'bad key' } }, 'application/json'), 'auth-rejected')
  assert.equal(isRouted('auth-rejected'), true)
  assert.equal(isRouted('gateway-blocked'), false)
})

test('looksLikeHtml：识别 HTML 错误页而不误伤 JSON', () => {
  assert.equal(looksLikeHtml(GATEWAY_HTML), true)
  assert.equal(looksLikeHtml('  <!DOCTYPE html>'), true)
  assert.equal(looksLikeHtml('{"error":"x"}'), false)
  assert.equal(looksLikeHtml(''), false)
})

test('零成本保证：探测请求只带哨兵模型，绝不可能出图', async () => {
  const stub = makeFetch(() => jsonResponse({ error: { message: 'no such model' } }, 400))
  await probeRoutes({ baseUrl: 'https://relay.example.com/v1', kind: 'openai-images' }, {}, { fetchImpl: stub.impl })
  assert.equal(stub.calls.length, 2)
  for (const call of stub.calls) {
    assert.equal(call.method, 'POST')
    const body = call.body as Record<string, unknown>
    assert.equal(body['model'], ROUTE_PROBE_MODEL)
    assert.equal(body['tools'], undefined)
    assert.ok(!('size' in body) && !('resolution' in body) && !('n' in body))
  }
  // 路径解析必须复用 resolveEndpoint 的 /v1 去重（否则会拼出 /v1/v1/...）
  assert.deepEqual(stub.calls.map((call) => call.url), [
    'https://relay.example.com/v1/images/generations',
    'https://relay.example.com/v1/responses',
  ])
})

test('真机事故复现：images 被拦而 responses 可达 -> 建议改用 openai-responses', async () => {
  const stub = makeFetch((call) =>
    call.url.includes('/v1/images/generations')
      ? textResponse(GATEWAY_HTML, 403, { 'content-type': 'text/html' })
      : jsonResponse({ error: { code: 'model_not_found' } }, 503),
  )
  const report = await probeRoutes({ baseUrl: 'https://relay.example.com/v1', kind: 'openai-images' }, {}, { fetchImpl: stub.impl })
  assert.equal(report.images.state, 'gateway-blocked')
  assert.equal(report.images.status, 403)
  assert.equal(report.responses.state, 'routed')
  assert.equal(report.recommended, 'responses-images')
  assert.ok(report.advice.includes('openai-responses'))
  assert.ok(report.advice.includes('/v1/images/generations'))
})

test('两条路径都通时不改动建议，也不产生告警', async () => {
  const stub = makeFetch(() => jsonResponse({ error: { message: 'no such model' } }, 400))
  const report = await probeRoutes({ baseUrl: 'https://relay.example.com/v1', kind: 'openai-images' }, {}, { fetchImpl: stub.impl })
  assert.equal(report.recommended, 'sync-images')
  assert.equal(report.advice, '')
  assert.equal(report.images.state, 'routed')
  assert.equal(report.responses.state, 'routed')
})

test('反向：配置成 responses 但只有同步端点可达时给出反向建议', async () => {
  const stub = makeFetch((call) =>
    call.url.includes('/v1/images/generations')
      ? jsonResponse({ error: { message: 'no such model' } }, 400)
      : textResponse(GATEWAY_HTML, 404, { 'content-type': 'text/html' }),
  )
  const report = await probeRoutes({ baseUrl: 'https://relay.example.com/v1', kind: 'openai-responses' }, {}, { fetchImpl: stub.impl })
  assert.equal(report.recommended, 'sync-images')
  assert.ok(report.advice.includes('openai-images'))
})

test('两条都不可达：归为网络问题而不是配置类型问题', async () => {
  const stub = makeFetch(() => { throw new Error('connect ECONNREFUSED') })
  const report = await probeRoutes({ baseUrl: 'https://relay.example.com/v1', kind: 'openai-images' }, {}, { fetchImpl: stub.impl })
  assert.equal(report.images.state, 'unreachable')
  assert.equal(report.responses.state, 'unreachable')
  assert.equal(report.recommended, 'unknown')
  assert.ok(report.advice.includes('Base URL'))
})

test('两条都被代理拦：提示核对路径前缀而不是改类型', () => {
  const blocked = { path: '/v1/images/generations', state: 'gateway-blocked' as const, status: 403, note: 'text/html' }
  const blocked2 = { path: '/v1/responses', state: 'gateway-blocked' as const, status: 403, note: 'text/html' }
  const advice = routeAdvice('openai-images', blocked, blocked2)
  assert.ok(advice.includes('前置代理'))
  assert.ok(!advice.includes('openai-responses'))
  assert.equal(routeStateLabel('gateway-blocked').includes('HTML'), true)
})

test('同步通道 probe：生成路径被拦时不再给假绿灯，并据证据修正端点风格', async () => {
  const stub = makeFetch((call) =>
    call.url.includes('/v1/models')
      ? jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2-4k' }] })
      : call.url.includes('/v1/images/generations')
        ? textResponse(GATEWAY_HTML, 403, { 'content-type': 'text/html' })
        : jsonResponse({ error: { code: 'model_not_found' } }, 503),
  )
  const provider = new OpenAiImagesProvider()
  const result = await provider.probe(channel(), { http: { fetchImpl: stub.impl } })
  assert.equal(result.ok, false)
  assert.equal(result.endpointStyle, 'responses-images')
  assert.equal(result.auth, 'ok')
  assert.deepEqual(result.models, ['gpt-image-2', 'gpt-image-2-4k'])
  assert.ok(result.route !== undefined)
  assert.equal(result.route?.images.state, 'gateway-blocked')
  assert.ok(result.detail.includes('openai-responses'))
})

test('同步通道 health：/v1/models 通但生成端点被拦时判为不健康', async () => {
  const stub = makeFetch((call) =>
    call.url.includes('/v1/models')
      ? jsonResponse({ data: [{ id: 'gpt-image-2' }] })
      : textResponse(GATEWAY_HTML, 403, { 'content-type': 'text/html' }),
  )
  const provider = new OpenAiImagesProvider()
  const health = await provider.health(channel(), { fetchImpl: stub.impl })
  assert.equal(health.ok, false)
  assert.ok(health.detail.includes('实际出图会失败'))
  assert.ok(health.route !== undefined)

  const healthy = makeFetch((call) =>
    call.url.includes('/v1/models')
      ? jsonResponse({ data: [{ id: 'gpt-image-2' }] })
      : jsonResponse({ error: { message: 'no such model' } }, 400),
  )
  const okHealth = await provider.health(channel(), { fetchImpl: healthy.impl })
  assert.equal(okHealth.ok, true)
  assert.ok(okHealth.detail.includes('生成端点'))
})

test('错误归一：网关 HTML 403 归为 ENDPOINT_BLOCKED，不再误导成 Key 无效', () => {
  assert.equal(classifyStatus(403, GATEWAY_HTML), 'ENDPOINT_BLOCKED')
  assert.equal(classifyStatus(404, '<html>not found</html>'), 'ENDPOINT_BLOCKED')
  // 同状态码但 API JSON 时仍按原口径
  assert.equal(classifyStatus(403, { error: { message: 'invalid api key' } }), 'API_KEY_INVALID')
  const text = describeError(new ImageProviderError('ENDPOINT_BLOCKED', '上游返回 HTTP 403', { status: 403, detail: GATEWAY_HTML }))
  assert.ok(text.includes('ENDPOINT_BLOCKED'))
  assert.ok(text.includes('前置代理'))
  assert.ok(text.includes('不是 Key 问题'))
})
