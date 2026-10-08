import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAiImagesProvider, foldNegative, resolveEndpoint } from '../src/provider/openai-images.ts'
import { TaskImagesProvider, extractImageUrls, extractTaskId, normalizeTaskStatus, taskStatusUrl } from '../src/provider/task-images.ts'
import { ImageProviderError, backoffMs, classifyStatus, retryAfterMs } from '../src/provider/errors.ts'
import { pickPath } from '../src/provider/http.ts'
import type { ChannelRecord, GenerateRequest } from '../src/provider/types.ts'
import { bytesResponse, cleanup, jsonResponse, makeFetch, makeSleep, tempDir, textResponse, tinyPng } from './helpers.ts'

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

function request(dir: string, overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    channelId: 'relay',
    model: 'gpt-image-2',
    prompt: 'SUBJECT: a mug.',
    negative: 'watermark, blur',
    size: '3:4',
    resolution: '2k',
    count: 1,
    outputDir: dir,
    fileStem: 'out',
    ...overrides,
  }
}

test('错误归一：HTTP 状态 + 响应体 -> 有限错误码', () => {
  assert.equal(classifyStatus(401, {}), 'API_KEY_INVALID')
  assert.equal(classifyStatus(403, { error: { message: 'moderation flagged' } }), 'REQUEST_REJECTED')
  assert.equal(classifyStatus(402, {}), 'BALANCE_REQUIRED')
  assert.equal(classifyStatus(429, {}), 'RATE_LIMITED')
  assert.equal(classifyStatus(400, { error: { message: 'insufficient balance' } }), 'BALANCE_REQUIRED')
  assert.equal(classifyStatus(400, {}), 'REQUEST_REJECTED')
  assert.equal(classifyStatus(503, {}), 'UNAVAILABLE')
  assert.equal(classifyStatus(418, {}), 'REQUEST_FAILED')
})

test('Retry-After：秒数与 HTTP 日期都支持，并夹到 1s..60s', () => {
  const now = Date.parse('2026-10-08T00:00:00Z')
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '5' }), 999), 5000)
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '0.5' }), 999), 1000)
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '600' }), 999), 60000)
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Wed, 08 Oct 2026 00:00:10 GMT' }), 999, now), 10000)
  assert.equal(retryAfterMs(new Headers({}), 777), 777)
})

test('退避：指数增长且封顶 15 分钟', () => {
  assert.ok(backoffMs(0, 1000) < backoffMs(1, 1000))
  assert.ok(backoffMs(20, 1000) <= 15 * 60 * 1000)
})

test('端点解析：baseUrl 已含 /v1 时不重复拼接', () => {
  assert.equal(resolveEndpoint('https://a.example.com', undefined, '/v1/images/generations'), 'https://a.example.com/v1/images/generations')
  assert.equal(resolveEndpoint('https://a.example.com/v1', undefined, '/v1/images/generations'), 'https://a.example.com/v1/images/generations')
  assert.equal(resolveEndpoint('https://a.example.com/v1/', '/custom/gen', '/v1/images/generations'), 'https://a.example.com/v1/custom/gen')
})

test('负向折进提示词：主流图像 API 没有 negative 字段', () => {
  const folded = foldNegative('SUBJECT: a mug.', 'watermark, blur')
  assert.ok(folded.startsWith('SUBJECT: a mug.'))
  assert.ok(folded.includes('Strictly avoid: watermark, blur.'))
  assert.equal(foldNegative('SUBJECT: a mug.', ''), 'SUBJECT: a mug.')
  assert.equal(foldNegative('SUBJECT: a mug.', undefined), 'SUBJECT: a mug.')
})

test('pickPath：容错穿越对象与数组', () => {
  assert.equal(pickPath({ data: [{ url: 'u' }] }, ['data', '0', 'url']), 'u')
  assert.equal(pickPath({ data: {} }, ['data', 'result', 'images']), undefined)
  assert.equal(pickPath(null, ['a']), undefined)
})

test('同步通道：b64_json 落盘，请求体带比例与分辨率，负向折进提示词', async () => {
  const dir = tempDir('sync-')
  try {
    const png = tinyPng().toString('base64')
    const stub = makeFetch(() => jsonResponse({ created: 1, data: [{ b64_json: png, size: '2k' }] }))
    const provider = new OpenAiImagesProvider()
    const result = await provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl } }))
    assert.equal(stub.calls.length, 1)
    const call = stub.calls[0]!
    assert.equal(call.method, 'POST')
    assert.equal(call.url, 'https://relay.example.com/v1/images/generations')
    assert.equal(call.headers['authorization'], 'Bearer sk-test-key-value')
    const body = call.body as Record<string, unknown>
    assert.equal(body['model'], 'gpt-image-2')
    assert.equal(body['size'], '3:4')
    assert.equal(body['resolution'], '2k')
    assert.equal(body['n'], 1)
    assert.ok(String(body['prompt']).includes('Strictly avoid: watermark, blur.'))
    assert.equal(result.images.length, 1)
    assert.ok(existsSync(join(dir, 'out.png')))
    assert.equal(readFileSync(join(dir, 'out.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  } finally { cleanup(dir) }
})

test('同步通道：url 形态立刻下载落盘（签名 URL 会过期）', async () => {
  const dir = tempDir('sync-url-')
  try {
    const stub = makeFetch((call) => {
      if (call.url.includes('/images/generations')) return jsonResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] })
      return bytesResponse(tinyPng())
    })
    const provider = new OpenAiImagesProvider()
    const result = await provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl } }))
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[1]!.url, 'https://cdn.example.com/a.png')
    assert.equal(result.images[0]!.bytes, tinyPng().byteLength)
  } finally { cleanup(dir) }
})

test('同步通道：n=2 落盘两个文件，后缀区分', async () => {
  const dir = tempDir('sync-n-')
  try {
    const png = tinyPng().toString('base64')
    const stub = makeFetch(() => jsonResponse({ data: [{ b64_json: png }, { b64_json: png }] }))
    const provider = new OpenAiImagesProvider()
    const result = await provider.generate(channel(), request(dir, { count: 2, http: { fetchImpl: stub.impl } }))
    assert.equal(result.images.length, 2)
    assert.ok(result.images[0]!.path.endsWith('out-1.png'))
    assert.ok(result.images[1]!.path.endsWith('out-2.png'))
  } finally { cleanup(dir) }
})

test('同步通道：401 归类为密钥无效且不重试', async () => {
  const dir = tempDir('sync-401-')
  try {
    const stub = makeFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401))
    const provider = new OpenAiImagesProvider()
    await assert.rejects(
      () => provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl } })),
      (error: unknown) => error instanceof ImageProviderError && error.code === 'API_KEY_INVALID',
    )
    assert.equal(stub.calls.length, 1)
  } finally { cleanup(dir) }
})

test('同步通道：429 按 Retry-After 退避后重试成功', async () => {
  const dir = tempDir('sync-429-')
  try {
    const png = tinyPng().toString('base64')
    const stub = makeFetch((_call, index) => index === 0
      ? jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '3' })
      : jsonResponse({ data: [{ b64_json: png }] }))
    const sleep = makeSleep()
    const provider = new OpenAiImagesProvider()
    const result = await provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl, sleepImpl: sleep.sleep } }))
    assert.equal(stub.calls.length, 2)
    assert.deepEqual(sleep.waits, [3000])
    assert.equal(result.images.length, 1)
  } finally { cleanup(dir) }
})

test('同步通道：响应缺 data 时给出可读的 BAD_RESPONSE（提示改用 task-images）', async () => {
  const dir = tempDir('sync-bad-')
  try {
    const stub = makeFetch(() => jsonResponse({ task_id: 'task_1234567890' }))
    const provider = new OpenAiImagesProvider()
    await assert.rejects(
      () => provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl, retries: 0 } })),
      (error: unknown) => error instanceof ImageProviderError && error.code === 'BAD_RESPONSE',
    )
  } finally { cleanup(dir) }
})

test('异步通道：提交 -> 轮询 pending/processing -> completed 并下载落盘', async () => {
  const dir = tempDir('task-')
  try {
    const stub = makeFetch((call, index) => {
      if (call.method === 'POST') return jsonResponse({ data: [{ task_id: 'task_abcdefgh' }] })
      if (call.url.includes('/tasks/')) {
        if (index === 1) return jsonResponse({ data: { status: 'in_progress' } })
        if (index === 2) return jsonResponse({ data: { status: 'processing', progress: 60 } })
        return jsonResponse({ data: { status: 'completed', result: { images: [{ url: ['https://cdn.example.com/x.png'], expires_at: 1893456000 }] } } })
      }
      return bytesResponse(tinyPng())
    })
    const sleep = makeSleep()
    const provider = new TaskImagesProvider()
    const result = await provider.generate(channel({ kind: 'task-images' }), request(dir, {
      http: { fetchImpl: stub.impl, sleepImpl: sleep.sleep, pollIntervalMs: 1000 },
    }))
    assert.equal(stub.calls[0]!.method, 'POST')
    assert.equal(stub.calls[1]!.url, 'https://relay.example.com/v1/tasks/task_abcdefgh')
    assert.equal(sleep.waits.length, 3)
    assert.equal(result.images.length, 1)
    assert.ok(existsSync(join(dir, 'out.png')))
    assert.equal(statSync(join(dir, 'out.png')).size, tinyPng().byteLength)
  } finally { cleanup(dir) }
})

test('异步通道：任务失败抛 TASK_FAILED 并带上上游原因', async () => {
  const dir = tempDir('task-fail-')
  try {
    const stub = makeFetch((call) => call.method === 'POST'
      ? jsonResponse({ data: { task_id: 'task_zzzzzzzz' } })
      : jsonResponse({ data: { status: 'failed', error: { message: 'content rejected by moderation' } } }))
    const provider = new TaskImagesProvider()
    await assert.rejects(
      () => provider.generate(channel({ kind: 'task-images' }), request(dir, { http: { fetchImpl: stub.impl, sleepImpl: makeSleep().sleep } })),
      (error: unknown) => error instanceof ImageProviderError
        && error.code === 'TASK_FAILED'
        && error.message.includes('moderation'),
    )
  } finally { cleanup(dir) }
})

test('异步通道：轮询超时视为失败（不记成功）', async () => {
  const dir = tempDir('task-timeout-')
  try {
    const stub = makeFetch((call) => call.method === 'POST'
      ? jsonResponse({ data: { task_id: 'task_slow0000' } })
      : jsonResponse({ data: { status: 'processing' } }))
    const provider = new TaskImagesProvider()
    await assert.rejects(
      () => provider.generate(channel({ kind: 'task-images' }), request(dir, {
        http: { fetchImpl: stub.impl, sleepImpl: makeSleep().sleep, pollIntervalMs: 1, pollTimeoutMs: 0 },
      })),
      (error: unknown) => error instanceof ImageProviderError && error.code === 'TIMEOUT',
    )
  } finally { cleanup(dir) }
})

test('异步通道：提交无 task id 时 BAD_RESPONSE', async () => {
  const dir = tempDir('task-noid-')
  try {
    const stub = makeFetch(() => textResponse('ok', 200))
    const provider = new TaskImagesProvider()
    await assert.rejects(
      () => provider.generate(channel({ kind: 'task-images' }), request(dir, { http: { fetchImpl: stub.impl, retries: 0 } })),
      (error: unknown) => error instanceof ImageProviderError && error.code === 'BAD_RESPONSE',
    )
  } finally { cleanup(dir) }
})

test('异步协议工具函数：task id / 状态归一 / 产物提取 / 查询地址', () => {
  assert.equal(extractTaskId({ data: [{ task_id: 'task_x1' }] }), 'task_x1')
  assert.equal(extractTaskId({ data: { id: 'abc' } }), 'abc')
  assert.equal(extractTaskId({ nope: 1 }), '')
  assert.equal(normalizeTaskStatus({ data: { status: 'in_progress' } }), 'processing')
  assert.equal(normalizeTaskStatus({ data: { status: 'SUCCEEDED' } }), 'completed')
  assert.equal(normalizeTaskStatus({ data: { status: 'weird' } }), 'unknown')
  assert.deepEqual(extractImageUrls({ data: { result: { images: [{ url: ['a', 'b'] }] } } }), ['a', 'b'])
  assert.deepEqual(extractImageUrls({ data: { result: { images: [{ url: 'c' }] } } }), ['c'])
  assert.equal(taskStatusUrl('https://a.example.com', undefined, 'task 1'), 'https://a.example.com/v1/tasks/task%201')
  assert.equal(taskStatusUrl('https://a.example.com', '/v1/jobs/{id}', 'x'), 'https://a.example.com/v1/jobs/x')
})

test('同步通道 probe：枚举模型并判定鉴权', async () => {
  const stub = makeFetch(() => jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'seedream-4' }] }))
  const provider = new OpenAiImagesProvider()
  const result = await provider.probe(channel(), { http: { fetchImpl: stub.impl } })
  assert.equal(result.ok, true)
  assert.equal(result.auth, 'ok')
  assert.deepEqual(result.models, ['gpt-image-2', 'seedream-4'])
  assert.equal(result.endpointStyle, 'sync-images')
})

test('同步通道 probe：401 判为鉴权无效', async () => {
  const stub = makeFetch(() => jsonResponse({ error: 'bad key' }, 401))
  const provider = new OpenAiImagesProvider()
  const result = await provider.probe(channel(), { http: { fetchImpl: stub.impl } })
  assert.equal(result.ok, false)
  assert.equal(result.auth, 'invalid')
})
