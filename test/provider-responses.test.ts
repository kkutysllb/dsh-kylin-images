import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAiResponsesProvider, buildResponsesBody, extractImageCalls, imageTokensOf, RESPONSES_PATH } from '../src/provider/openai-responses.ts'
import { effectiveSizeStyle } from '../src/provider/catalog.ts'
import { ImageProviderError } from '../src/provider/errors.ts'
import type { ChannelRecord, GenerateRequest } from '../src/provider/types.ts'
import { cleanup, jsonResponse, makeFetch, tempDir, tinyPng } from './helpers.ts'

function channel(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    id: 'ty', label: 'tianyuai', kind: 'openai-responses',
    baseUrl: 'https://tianyuai.lol', apiKey: 'sk-test', models: ['gpt-image-2'],
    enabled: true, createdAt: 'x', updatedAt: 'x', ...overrides,
  }
}

function request(dir: string, overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    channelId: 'ty', model: 'gpt-image-2', prompt: 'SUBJECT: a grey square.',
    negative: 'watermark', size: '1024x1536', count: 1,
    outputDir: dir, fileStem: 'out', quality: 'low', ...overrides,
  }
}

test('Responses 通道的尺寸风格固定为 pixels（size 是工具参数）', () => {
  assert.equal(effectiveSizeStyle(undefined, 'openai-responses', 'gpt-image-2'), 'pixels')
  assert.equal(effectiveSizeStyle('ratio-resolution', 'openai-responses', 'gpt-image-2'), 'ratio-resolution')
})

test('请求体：size 与 quality 进 tools 对象，模型在顶层', () => {
  const body = buildResponsesBody(request('/tmp'), { supportsNegative: false, supportsQuality: true, quality: 'low' })
  assert.equal(body['model'], 'gpt-image-2')
  const tools = body['tools'] as Array<Record<string, unknown>>
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.['type'], 'image_generation')
  assert.equal(tools[0]?.['size'], '1024x1536')
  assert.equal(tools[0]?.['quality'], 'low')
  assert.ok(String(body['input']).includes('Strictly avoid: watermark.'))
})

test('请求体：quality=auto 不发送（让上游用默认档）', () => {
  const body = buildResponsesBody(request('/tmp'), { supportsNegative: false, supportsQuality: true, quality: 'auto' })
  const tools = body['tools'] as Array<Record<string, unknown>>
  assert.equal(tools[0]?.['quality'], undefined)
})

test('请求体：有参考图时 input 变成 parts 形态', () => {
  const dir = tempDir('resp-ref-')
  try {
    const ref = join(dir, 'ref.png')
    writeFileSync(ref, tinyPng())
    const body = buildResponsesBody(request(dir), { supportsNegative: false, supportsQuality: true, references: [ref] })
    const input = body['input'] as Array<{ role: string; content: Array<Record<string, unknown>> }>
    assert.equal(input[0]?.role, 'user')
    assert.equal(input[0]?.content[0]?.['type'], 'input_text')
    assert.equal(input[0]?.content[1]?.['type'], 'input_image')
    assert.ok(String(input[0]?.content[1]?.['image_url']).startsWith('data:image/png;base64,'))
  } finally { cleanup(dir) }
})

test('响应解析：只取 image_generation_call，忽略推理与文本项', () => {
  const calls = extractImageCalls({
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'image_generation_call', status: 'completed', result: 'AAAA', revised_prompt: 'rev' },
      { type: 'message', content: [] },
    ],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.status, 'completed')
  assert.equal(calls[0]?.result, 'AAAA')
  assert.equal(calls[0]?.revisedPrompt, 'rev')
  assert.deepEqual(extractImageCalls({ output: [] }), [])
  assert.deepEqual(extractImageCalls({}), [])
})

test('图像 token 用量读取（成本按 token 计）', () => {
  assert.equal(imageTokensOf({ usage: { completion_tokens_details: { image_tokens: 408 } } }), 408)
  assert.equal(imageTokensOf({ usage: {} }), undefined)
})

test('生成：base64 result 落盘为合法 PNG，请求打到 /v1/responses', async () => {
  const dir = tempDir('resp-gen-')
  try {
    const stub = makeFetch(() => jsonResponse({
      status: 'completed',
      output: [{ type: 'image_generation_call', status: 'completed', result: tinyPng().toString('base64'), revised_prompt: 'rev' }],
      usage: { completion_tokens_details: { image_tokens: 408 } },
    }))
    const provider = new OpenAiResponsesProvider()
    const result = await provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl } }))
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0]?.url, 'https://tianyuai.lol' + RESPONSES_PATH)
    assert.equal(stub.calls[0]?.method, 'POST')
    assert.equal((stub.calls[0]?.headers ?? {})['authorization'], 'Bearer sk-test')
    assert.equal(result.images.length, 1)
    assert.ok(existsSync(join(dir, 'out.png')))
    assert.equal(statSync(join(dir, 'out.png')).size, tinyPng().byteLength)
    assert.equal(readFileSync(join(dir, 'out.png')).subarray(0, 4).toString('hex'), '89504e47')
    assert.equal(result.actualSize, '1024x1536')
  } finally { cleanup(dir) }
})

test('生成：baseUrl 带 /v1 时不重复拼接', async () => {
  const dir = tempDir('resp-v1-')
  try {
    const stub = makeFetch(() => jsonResponse({ output: [{ type: 'image_generation_call', status: 'completed', result: tinyPng().toString('base64') }] }))
    const provider = new OpenAiResponsesProvider()
    await provider.generate(channel({ baseUrl: 'https://relay.example.com/v1' }), request(dir, { http: { fetchImpl: stub.impl } }))
    assert.equal(stub.calls[0]?.url, 'https://relay.example.com/v1/responses')
  } finally { cleanup(dir) }
})

test('生成：没有 image_generation_call 时抛 BAD_RESPONSE 并带上游原因', async () => {
  const dir = tempDir('resp-bad-')
  try {
    const stub = makeFetch(() => jsonResponse({ error: { message: 'model not supported' } }))
    const provider = new OpenAiResponsesProvider()
    await assert.rejects(
      () => provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl, retries: 0 } })),
      (error: unknown) => error instanceof ImageProviderError
        && error.code === 'BAD_RESPONSE'
        && (error.detail ?? '').includes('model not supported'),
    )
  } finally { cleanup(dir) }
})

test('生成：调用 status=failed 时抛 TASK_FAILED', async () => {
  const dir = tempDir('resp-fail-')
  try {
    const stub = makeFetch(() => jsonResponse({ output: [{ type: 'image_generation_call', status: 'failed' }] }))
    const provider = new OpenAiResponsesProvider()
    await assert.rejects(
      () => provider.generate(channel(), request(dir, { http: { fetchImpl: stub.impl, retries: 0 } })),
      (error: unknown) => error instanceof ImageProviderError && error.code === 'TASK_FAILED',
    )
  } finally { cleanup(dir) }
})

test('探测：返回 responses-images 端点风格与鉴权结论', async () => {
  const stub = makeFetch(() => jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2.5' }] }))
  const provider = new OpenAiResponsesProvider()
  const result = await provider.probe(channel(), { http: { fetchImpl: stub.impl } })
  assert.equal(result.ok, true)
  assert.equal(result.auth, 'ok')
  assert.equal(result.endpointStyle, 'responses-images')
  assert.deepEqual(result.models, ['gpt-image-2', 'gpt-image-2.5'])
})
