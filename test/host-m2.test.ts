import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '../src/host/registry.ts'
import { API_PREFIX, handleRequest } from '../src/host/routes.ts'
import { readSpend } from '../src/store/spend.ts'
import type { PluginRuntime } from '../src/host/registry.ts'

function tempDir(): string {
  return mkdtempSync(join(process.cwd(), '.scratch', 'm2-'))
}

function req(pathname: string) {
  return { method: 'POST', pathname: API_PREFIX + pathname, host: '127.0.0.1:1', headers: { host: '127.0.0.1:1' } }
}

async function withRuntime<T>(fn: (runtime: PluginRuntime) => Promise<T>): Promise<T> {
  const dir = tempDir()
  const runtime = createRuntime(dir)
  try {
    return await fn(runtime)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const mockPrompt = { schemaVersion: 1, intent: 'single-image', subject: 'a mug' }

test('M2 通道探测：mock 通道 probe 返回鉴权与端点风格', async () => {
  await withRuntime(async (runtime) => {
    await handleRequest(runtime, req('/channels.upsert'), { channel: { id: 'mock', label: 'mock', kind: 'mock' } })
    const outcome = await handleRequest(runtime, req('/channels.probe'), { id: 'mock', realRun: true })
    assert.equal(outcome?.status, 200)
    const value = (outcome?.payload as { value: { ok: boolean; auth: string; endpointStyle: string; realRun?: { ok: boolean } } }).value
    assert.equal(value.ok, true)
    assert.equal(value.auth, 'ok')
    assert.equal(value.endpointStyle, 'sync-images')
    assert.equal(value.realRun?.ok, true)
    const missing = await handleRequest(runtime, req('/channels.probe'), { id: 'nope' })
    assert.equal(missing?.status, 404)
  })
})

test('M2 批量：两个 mock 项各自落盘并各记一笔账', async () => {
  await withRuntime(async (runtime) => {
    await handleRequest(runtime, req('/channels.upsert'), { channel: { id: 'mock', label: 'mock', kind: 'mock' } })
    const outcome = await handleRequest(runtime, req('/batch'), {
      items: [{ prompt: mockPrompt }, { prompt: { ...mockPrompt, subject: 'another mug' } }],
      concurrency: 2,
    })
    assert.equal(outcome?.status, 200)
    const outcomes = (outcome?.payload as { value: { outcomes: Array<{ kind: string; images: unknown[] }> } }).value.outcomes
    assert.equal(outcomes.length, 2)
    assert.ok(outcomes.every((item) => item.kind === 'generated'))
    assert.ok(outcomes.every((item) => item.images.length === 1))
    assert.equal(readSpend(runtime.home).length, 2)
  })
})

test('M2 成本确认：未知价先拒绝，且预检阶段一分钱都没花', async () => {
  await withRuntime(async (runtime) => {
    await handleRequest(runtime, req('/channels.upsert'), {
      channel: { id: 'relay', label: '中转', kind: 'openai-images', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', models: ['mystery-model-9000'] },
    })
    const single = await handleRequest(runtime, req('/generate'), { prompt: mockPrompt })
    assert.equal(single?.status, 409)
    assert.equal((single?.payload as { error: { code: string } }).error.code, 'confirm-required')
    const batch = await handleRequest(runtime, req('/batch'), { items: [{ prompt: mockPrompt }, { prompt: mockPrompt }] })
    assert.equal(batch?.status, 409)
    assert.equal((batch?.payload as { error: { code: string } }).error.code, 'confirm-required')
    // 关键断言：预检不能产生任何真实调用与记账
    assert.equal(readSpend(runtime.home).length, 0)
  })
})

test('M2 缓存：同输入第二次命中缓存，不重复记账也不重复出图', async () => {
  await withRuntime(async (runtime) => {
    await handleRequest(runtime, req('/channels.upsert'), { channel: { id: 'mock', label: 'mock', kind: 'mock' } })
    const first = await handleRequest(runtime, req('/generate'), { prompt: mockPrompt })
    const second = await handleRequest(runtime, req('/generate'), { prompt: mockPrompt })
    assert.equal((first?.payload as { value: { kind: string } }).value.kind, 'generated')
    assert.equal((second?.payload as { value: { kind: string } }).value.kind, 'cached')
    assert.equal(readSpend(runtime.home).length, 1)
    const stats = await handleRequest(runtime, req('/cache.stats'), {})
    const value = (stats?.payload as { value: { entries: number; hits: number } }).value
    assert.equal(value.entries, 1)
    assert.equal(value.hits, 1)
    // useCache=false 必须真的重跑
    const third = await handleRequest(runtime, req('/generate'), { prompt: mockPrompt, useCache: false })
    assert.equal((third?.payload as { value: { kind: string } }).value.kind, 'generated')
    assert.equal(readSpend(runtime.home).length, 2)
    const cleared = await handleRequest(runtime, req('/cache.clear'), {})
    assert.equal((cleared?.payload as { value: { cleared: number } }).value.cleared, 1)
  })
})

test('M2 换分辨率不会命中低分辨率缓存（尺寸进了缓存键）', async () => {
  await withRuntime(async (runtime) => {
    await handleRequest(runtime, req('/channels.upsert'), { channel: { id: 'mock', label: 'mock', kind: 'mock' } })
    await handleRequest(runtime, req('/generate'), { prompt: { ...mockPrompt, technical: { aspectRatio: '1:1', resolution: '1k' } } })
    const other = await handleRequest(runtime, req('/generate'), { prompt: { ...mockPrompt, technical: { aspectRatio: '3:4', resolution: '2k' } } })
    assert.equal((other?.payload as { value: { kind: string } }).value.kind, 'generated')
    assert.equal(readSpend(runtime.home).length, 2)
  })
})

test('M2 通道新字段：statusPath / pricing / timeoutMs / retries 落盘并回读', async () => {
  await withRuntime(async (runtime) => {
    const created = await handleRequest(runtime, req('/channels.upsert'), {
      channel: {
        id: 'relay', label: '中转', kind: 'task-images',
        baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test',
        models: ['gpt-image-2'], statusPath: '/v1/jobs/{id}',
        pricing: { currency: 'CNY', '2k': 0.13, default: 0.08 },
        timeoutMs: 90000, retries: 2, sizeStyle: 'ratio-resolution',
      },
    })
    assert.equal(created?.status, 200)
    const stored = runtime.vault.find('relay')
    assert.equal(stored?.statusPath, '/v1/jobs/{id}')
    assert.equal(stored?.pricing?.['2k'], 0.13)
    assert.equal(stored?.timeoutMs, 90000)
    assert.equal(stored?.retries, 2)
    const bad = await handleRequest(runtime, req('/channels.upsert'), {
      channel: { id: 'x', label: 'x', kind: 'task-images', baseUrl: 'https://a.example.com', statusPath: 'v1/jobs' },
    })
    assert.equal(bad?.status, 400)
    const badPrice = await handleRequest(runtime, req('/channels.upsert'), {
      channel: { id: 'y', label: 'y', kind: 'task-images', baseUrl: 'https://a.example.com', pricing: { '2k': -1 } },
    })
    assert.equal(badPrice?.status, 400)
  })
})
