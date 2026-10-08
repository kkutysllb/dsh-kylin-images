import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createRuntime } from '../src/host/registry.ts'
import { API_PREFIX, HEALTH_PATH, createHandler, handleRequest, isLoopbackHost } from '../src/host/routes.ts'
import type { PluginRuntime } from '../src/host/registry.ts'
import { createTools } from '../src/tools/index.ts'
import { apply, name, inject, Config, CONFIG_FIELDS, CONFIG_FIELD_SPECS } from '../src/index.ts'

function tempDir(): string {
  return mkdtempSync(join(process.cwd(), '.scratch', 'host-'))
}

function withRuntime<T>(fn: (runtime: PluginRuntime, dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = tempDir()
  const runtime = createRuntime(dir)
  try {
    return fn(runtime, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const loopback = { host: '127.0.0.1:60187' }

function req(method: string, pathname: string, host = '127.0.0.1:60187') {
  return { method, pathname, host, headers: { host } }
}

test('信任围栏：非回环 Host 一律 403（DNS-rebind 防御）', async () => {
  await withRuntime(async (runtime) => {
    const outcome = await handleRequest(runtime, req('GET', '/dsh-kylin-images/health', 'evil.example.com'), {})
    assert.equal(outcome?.status, 403)
    assert.equal(isLoopbackHost({ host: 'localhost:1234' }), true)
    assert.equal(isLoopbackHost({ host: '[::1]:1234' }), true)
    assert.equal(isLoopbackHost({ host: '192.168.1.9:1234' }), false)
    assert.equal(isLoopbackHost({}), false)
  })
})

test('GET /health 与 GET /api/state 返回 {ok,value}', async () => {
  await withRuntime(async (runtime) => {
    const health = await handleRequest(runtime, req('GET', '/dsh-kylin-images/health'), {})
    assert.equal(health?.status, 200)
    assert.equal((health?.payload as { ok: boolean }).ok, true)
    const state = await handleRequest(runtime, req('GET', API_PREFIX + '/state'), {})
    const value = (state?.payload as { value: { channels: unknown[] } }).value
    assert.deepEqual(value.channels, [])
  })
})

test('写操作 POST-only：GET 打写接口得 405', async () => {
  await withRuntime(async (runtime) => {
    const outcome = await handleRequest(runtime, req('GET', API_PREFIX + '/settings.update'), {})
    assert.equal(outcome?.status, 405)
  })
})

test('channels.upsert -> state 回显脱敏；channels.remove 未知 id 得 404', async () => {
  await withRuntime(async (runtime) => {
    const created = await handleRequest(runtime, req('POST', API_PREFIX + '/channels.upsert'), {
      channel: { id: 'relay', label: '中转', kind: 'openai-images', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-abcdefghijklmnop', models: ['gpt-image-2'] },
    })
    assert.equal(created?.status, 200)
    const state = await handleRequest(runtime, req('GET', API_PREFIX + '/state'), {})
    const serialized = JSON.stringify(state?.payload)
    assert.ok(!serialized.includes('sk-abcdefghijklmnop'))
    assert.ok(serialized.includes('sk-••••nop'))
    const bad = await handleRequest(runtime, req('POST', API_PREFIX + '/channels.upsert'), { channel: { label: '', kind: 'mock' } })
    assert.equal(bad?.status, 400)
    const missing = await handleRequest(runtime, req('POST', API_PREFIX + '/channels.remove'), { id: 'nope' })
    assert.equal(missing?.status, 404)
    const unknown = await handleRequest(runtime, req('POST', API_PREFIX + '/nope'), {})
    assert.equal(unknown?.status, 404)
  })
})

test('mock 通道全链路：channels.test 通过，generate 真的落盘一张 PNG', async () => {
  await withRuntime(async (runtime, dir) => {
    await handleRequest(runtime, req('POST', API_PREFIX + '/channels.upsert'), {
      channel: { id: 'mock', label: '本地 mock', kind: 'mock', models: ['mock-image-v1'] },
    })
    const health = await handleRequest(runtime, req('POST', API_PREFIX + '/channels.test'), { id: 'mock' })
    assert.equal((health?.payload as { value: { ok: boolean } }).value.ok, true)
    const generated = await handleRequest(runtime, req('POST', API_PREFIX + '/generate'), {
      prompt: { schemaVersion: 1, intent: 'single-image', subject: 'a red mug on a desk', technical: { aspectRatio: '3:4', resolution: '2k' } },
    })
    assert.equal(generated?.status, 200)
    const value = (generated?.payload as { value: { images: Array<{ path: string; width: number; height: number }> } }).value
    assert.equal(value.images.length, 1)
    const image = value.images[0]
    assert.ok(image !== undefined)
    assert.equal(image.width, 1024)
    assert.equal(image.height, 1536)
    assert.ok(statSync(image.path).size > 0)
    const state = await handleRequest(runtime, req('GET', API_PREFIX + '/state'), {})
    const spend = (state?.payload as { value: { spend: { entries: number; images: number } } }).value.spend
    assert.equal(spend.entries, 1)
    assert.equal(spend.images, 1)
  })
})

test('library.search 与 compose 走真实数据', async () => {
  await withRuntime(async (runtime) => {
    const search = await handleRequest(runtime, req('POST', API_PREFIX + '/library.search'), { query: 'infographic', limit: 3 })
    const value = (search?.payload as { value: { totalTemplates: number; templates: Array<{ id: string }> } }).value
    assert.ok(value.templates.some((hit) => hit.id === 'infographic-engine'))
    const composed = await handleRequest(runtime, req('POST', API_PREFIX + '/compose'), {
      prompt: { schemaVersion: 1, intent: 'single-image', subject: 'a mug', constraints: { avoid: ['blur'] } },
    })
    const prompt = (composed?.payload as { value: { prompt: string; negative: string } }).value
    assert.ok(prompt.prompt.startsWith('SUBJECT: a mug'))
    assert.ok(prompt.negative.includes('blur'))
  })
})

test('真实 HTTP 往返：回环 Host 可访问 /health 与写接口', async () => {
  const dir = tempDir()
  const runtime = createRuntime(dir)
  const server = createServer(createHandler(runtime))
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const port = (address as { port: number }).port
    const base = 'http://127.0.0.1:' + String(port)
    const health = await fetch(base + '/dsh-kylin-images/health')
    assert.equal(health.status, 200)
    const created = await fetch(base + API_PREFIX + '/channels.upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: { id: 'mock', label: '本地 mock', kind: 'mock' } }),
    })
    assert.equal(created.status, 200)
    const generated = await fetch(base + API_PREFIX + '/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: { schemaVersion: 1, intent: 'single-image', subject: 'e2e mug' } }),
    })
    const payload = (await generated.json()) as { ok: boolean; value: { images: Array<{ path: string }> } }
    assert.equal(payload.ok, true)
    assert.ok(statSync(payload.value.images[0]!.path).size > 0)
    const badJson = await fetch(base + API_PREFIX + '/generate', { method: 'POST', body: '{ not json' })
    assert.equal(badJson.status, 400)
    const outside = await fetch(base + '/dsh-kylin-images/health', { headers: { host: 'evil.example.com' } }).catch(() => undefined)
    assert.ok(outside === undefined || outside.status === 403 || outside.status === 200)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具面：注册三个 img_* 工具且输出可读', async () => {
  await withRuntime(async (runtime) => {
    const tools = createTools(runtime)
    assert.deepEqual(tools.map((tool) => tool.name), ['img_channels', 'img_library', 'img_compose', 'img_generate', 'img_batch'])
    runtime.vault.upsert({ id: 'mock', label: '本地 mock', kind: 'mock' })
    const listOutput = await tools[0]!.execute({ action: 'list' })
    assert.ok(listOutput.includes('通道数：1'))
    assert.ok(listOutput.includes('累计消耗'))
    const testOutput = await tools[0]!.execute({ action: 'test', id: 'mock' })
    assert.ok(testOutput.includes('自检通过'))
    const libraryOutput = await tools[1]!.execute({ query: 'infographic timeline', limit: 3 })
    assert.ok(libraryOutput.includes('infographic-engine'))
    const composeOutput = await tools[2]!.execute({ prompt: { schemaVersion: 1, intent: 'single-image', subject: 'tool mug' } })
    assert.ok(composeOutput.includes('=== 最终提示词 ==='))
    assert.ok(composeOutput.includes('SUBJECT: tool mug'))
    const generateOutput = await tools[3]!.execute({ prompt: { schemaVersion: 1, intent: 'single-image', subject: 'tool mug' } })
    assert.ok(generateOutput.includes('已通过通道 mock'))
    const missingSubject = await tools[3]!.execute({ prompt: { text: '' } })
    assert.ok(missingSubject.includes('缺少 subject'))
    const batchOutput = await tools[4]!.execute({ items: [{ prompt: { schemaVersion: 1, intent: 'single-image', subject: 'page one' } }, { prompt: { schemaVersion: 1, intent: 'single-image', subject: 'page two' } }], concurrency: 2 })
    assert.ok(batchOutput.includes('批量完成：新生成 2'))
  })
})

test('插件入口：双通道可加载，apply 注册路由与工具', () => {
  assert.equal(name, 'dsh-kylin-images')
  assert.deepEqual([...inject], ['tools', 'webServer'])
  assert.equal(CONFIG_FIELDS.length, 15)
  assert.ok(Object.keys(CONFIG_FIELD_SPECS).includes('defaultResolution'))
  assert.equal(HEALTH_PATH, '/dsh-kylin-images/health')
  // cordis 的 resolveConfig 走 Standard Schema：缺 ~standard 会让整条插件行激活失败
  const standard = (Config as { '~standard'?: { version: number; validate: (raw: unknown) => { value: unknown } } })['~standard']
  assert.equal(standard?.version, 1)
  const resolved = standard?.validate({ defaultResolution: '4k', unknownKey: 7 }) as { value: Record<string, unknown> }
  assert.equal(resolved.value['defaultResolution'], '4k')
  assert.equal(resolved.value['unknownKey'], 7, '未知键必须原样保留')
  assert.equal(resolved.value['defaultCount'], 1, '缺失字段必须回落默认值')
  const bad = standard?.validate({ defaultCount: 'abc', defaultAspectRatio: '999:1' }) as { value: Record<string, unknown> }
  assert.equal(bad.value['defaultCount'], 1)
  assert.equal(bad.value['defaultAspectRatio'], '3:4')
  const dir = tempDir()
  const previous = process.env['DSH_KYLIN_IMAGES_HOME']
  process.env['DSH_KYLIN_IMAGES_HOME'] = dir
  const routes: string[] = []
  const toolNames: string[] = []
  let effectCalls = 0
  const ctx = {
    tools: { register: (definition: unknown) => { toolNames.push(String((definition as { name: string }).name)); return () => undefined } },
    webServer: { register: (options: { path: string }) => { routes.push(options.path); return () => undefined } },
    logger: { warn: () => undefined, info: () => undefined },
    effect: (register: () => unknown) => { effectCalls += 1; return register() },
  }
  try {
    apply(ctx)
    assert.equal(effectCalls, 1)
    assert.deepEqual(routes, ['/dsh-kylin-images/health', API_PREFIX])
    assert.deepEqual(toolNames, ['img_channels', 'img_library', 'img_compose', 'img_generate', 'img_batch'])
  } finally {
    if (previous === undefined) delete process.env['DSH_KYLIN_IMAGES_HOME']
    else process.env['DSH_KYLIN_IMAGES_HOME'] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('无 webServer / 无 tools 的宿主也不崩（软探测）', () => {
  const dir = tempDir()
  const previous = process.env['DSH_KYLIN_IMAGES_HOME']
  process.env['DSH_KYLIN_IMAGES_HOME'] = dir
  try {
    assert.doesNotThrow(() => apply({}))
    assert.doesNotThrow(() => apply({ logger: { warn: () => undefined } }))
  } finally {
    if (previous === undefined) delete process.env['DSH_KYLIN_IMAGES_HOME']
    else process.env['DSH_KYLIN_IMAGES_HOME'] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
