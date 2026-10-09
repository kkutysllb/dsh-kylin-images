/**
 * 端点自动回退的回归测试。
 *
 * 锁定的真机事实：中转站的前置代理只放行一条出图路径，
 * 另一条无论试多少次都在网关被 403 HTML 拦掉 —— 不是偶发，是必然。
 * 自动回退要保证：配错类型也能出图，且必须如实告知已回退。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ImageProviderError } from '../src/provider/errors.ts'
import { alternateKindFor, isEndpointBlocked, planFallback } from '../src/provider/fallback.ts'
import { ROUTE_PROBE_MODEL } from '../src/provider/route-probe.ts'
import { runGeneration } from '../src/host/generate.ts'
import { createRuntime } from '../src/host/registry.ts'
import { readSpend } from '../src/store/spend.ts'
import type { ChannelRecord } from '../src/provider/types.ts'
import { jsonResponse, makeFetch, tempDir, textResponse, tinyPng } from './helpers.ts'

const GATEWAY_HTML = '<html><head><title>403 Forbidden</title></head><body>403</body></html>'

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

/** 真机形态：images 路径被前置代理拦掉（HTML 403），responses 路径正常。 */
function blockedImagesStub() {
  return makeFetch((call) => {
    const body = (call.body ?? {}) as Record<string, unknown>
    if (body['model'] === ROUTE_PROBE_MODEL) {
      // 零成本路由探测：两条路径分别给出「被拦」与「可达」的证据
      return call.url.includes('/v1/images/generations')
        ? textResponse(GATEWAY_HTML, 403, { 'content-type': 'text/html' })
        : jsonResponse({ error: { code: 'model_not_found' } }, 503)
    }
    if (call.url.includes('/v1/images/generations')) {
      return textResponse(GATEWAY_HTML, 403, { 'content-type': 'text/html' })
    }
    return jsonResponse({
      output: [{ type: 'image_generation_call', status: 'completed', result: tinyPng().toString('base64') }],
    })
  })
}

test('可回退的类型对：仅两条 OpenAI 兼容出图路径互换', () => {
  assert.equal(alternateKindFor('openai-images'), 'openai-responses')
  assert.equal(alternateKindFor('openai-responses'), 'openai-images')
  // 异步任务协议不同、mock 无端点，都不参与自动互换
  assert.equal(alternateKindFor('task-images'), undefined)
  assert.equal(alternateKindFor('mock'), undefined)
})

test('只有「端点被代理拦」这类错误才触发回退', () => {
  assert.equal(isEndpointBlocked(new ImageProviderError('ENDPOINT_BLOCKED', 'x')), true)
  assert.equal(isEndpointBlocked(new ImageProviderError('UNAVAILABLE', 'x')), false)
  assert.equal(isEndpointBlocked(new ImageProviderError('API_KEY_INVALID', 'x')), false)
  assert.equal(isEndpointBlocked(new Error('boom')), false)
})

test('planFallback：被拦 + 另一条可达 -> 给出回退与告知文案', async () => {
  const stub = blockedImagesStub()
  const decision = await planFallback(
    channel(),
    new ImageProviderError('ENDPOINT_BLOCKED', '上游返回 HTTP 403', { status: 403 }),
    { http: { fetchImpl: stub.impl } },
  )
  assert.ok(decision !== undefined)
  assert.equal(decision?.kind, 'openai-responses')
  assert.equal(decision?.channel.kind, 'openai-responses')
  assert.equal(decision?.channel.id, 'relay', '回退不得新建通道，必须是同一个通道换类型')
  assert.equal(decision?.channel.apiKey, 'sk-test-key-value', '沿用同一份凭据')
  assert.ok(decision?.note.includes('openai-responses'))
  assert.ok(decision?.note.includes('建议把该通道的类型直接改成'))
})

test('planFallback：通道显式关闭回退时不做任何事', async () => {
  const stub = blockedImagesStub()
  const decision = await planFallback(
    channel({ autoFallback: false }),
    new ImageProviderError('ENDPOINT_BLOCKED', 'x', { status: 403 }),
    { http: { fetchImpl: stub.impl } },
  )
  assert.equal(decision, undefined)
  assert.equal(stub.calls.length, 0, '关闭后连探测都不该发')
})

test('planFallback：另一条也不可达时老老实实不回退', async () => {
  const stub = makeFetch(() => textResponse(GATEWAY_HTML, 403, { 'content-type': 'text/html' }))
  const decision = await planFallback(
    channel(),
    new ImageProviderError('ENDPOINT_BLOCKED', 'x', { status: 403 }),
    { http: { fetchImpl: stub.impl } },
  )
  assert.equal(decision, undefined)
})

test('planFallback：非路由类错误不回退（不该把 401 也当成端点问题）', async () => {
  const stub = blockedImagesStub()
  const decision = await planFallback(
    channel(),
    new ImageProviderError('API_KEY_INVALID', 'bad key', { status: 401 }),
    { http: { fetchImpl: stub.impl } },
  )
  assert.equal(decision, undefined)
})

test('端到端：通道类型配错也能出图，且如实告知已回退', async () => {
  const dir = tempDir()
  try {
    const runtime = createRuntime(dir)
    const stub = blockedImagesStub()
    runtime.vault.upsert({
      id: 'relay', label: '中转', kind: 'openai-images',
      baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test-key-value', models: ['gpt-image-2'],
    })
    const outcome = await runGeneration(runtime, {
      prompt: { schemaVersion: 1, intent: 'single-image', subject: 'a mug' },
      channelId: 'relay',
      outputDir: join(dir, 'out'),
      fileStem: 'fb',
      http: { fetchImpl: stub.impl, sleepImpl: async () => undefined },
    })
    assert.equal(outcome.kind, 'generated', outcome.message)
    assert.equal(outcome.images.length, 1)
    assert.ok(outcome.message.includes('openai-responses'), '文案要说清实际用的是哪条路径')
    assert.ok(outcome.message.includes('自动回退'))
    assert.ok(outcome.warnings.some((w) => w.includes('已自动改用 openai-responses')), '必须给出回退提示')
    // 记账必须照记（真的出了图）
    const spend = readSpend(dir)
    assert.equal(spend.length, 1)
    assert.equal(spend[0]?.count, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：关掉回退时按原来的方式失败，不偷偷换路径', async () => {
  const dir = tempDir()
  try {
    const runtime = createRuntime(dir)
    const stub = blockedImagesStub()
    runtime.vault.upsert({
      id: 'relay', label: '中转', kind: 'openai-images',
      baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test-key-value', models: ['gpt-image-2'],
      autoFallback: false,
    })
    const outcome = await runGeneration(runtime, {
      prompt: { schemaVersion: 1, intent: 'single-image', subject: 'a mug' },
      channelId: 'relay',
      outputDir: join(dir, 'out'),
      fileStem: 'nofb',
      http: { fetchImpl: stub.impl, sleepImpl: async () => undefined },
    })
    assert.equal(outcome.kind, 'error')
    assert.ok(outcome.message.includes('ENDPOINT_BLOCKED'))
    assert.ok(!outcome.warnings.some((w) => w.includes('已自动改用')))
    assert.equal(readSpend(dir).length, 0, '没出图就不该记账')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
