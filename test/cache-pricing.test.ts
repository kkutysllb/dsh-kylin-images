import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ResultCache, cacheKey } from '../src/store/cache.ts'
import { needsConfirmation, pricePerImage, quoteImages } from '../src/provider/pricing.ts'
import { effectiveSizeStyle, inferModel, resolveModelSpec, UNKNOWN_MODEL_SPEC } from '../src/provider/catalog.ts'
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/store/settings.ts'
import type { ChannelRecord } from '../src/provider/types.ts'
import { cleanup, tempDir, tinyPng } from './helpers.ts'

function channel(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    id: 'relay', label: '中转', kind: 'openai-images',
    baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-x', models: ['gpt-image-2'],
    enabled: true, createdAt: 'x', updatedAt: 'x', ...overrides,
  }
}

const keyInput = {
  channelId: 'relay', model: 'gpt-image-2', prompt: 'SUBJECT: a mug.',
  negative: 'watermark', size: '3:4', resolution: '2k', count: 1, seed: undefined,
}

test('缓存键：同输入恒同键；改分辨率/张数/种子/提示词都会变键', () => {
  assert.equal(cacheKey(keyInput), cacheKey({ ...keyInput }))
  assert.notEqual(cacheKey(keyInput), cacheKey({ ...keyInput, resolution: '4k' }))
  assert.notEqual(cacheKey(keyInput), cacheKey({ ...keyInput, count: 2 }))
  assert.notEqual(cacheKey(keyInput), cacheKey({ ...keyInput, seed: 7 }))
  assert.notEqual(cacheKey(keyInput), cacheKey({ ...keyInput, prompt: 'other' }))
  assert.notEqual(cacheKey(keyInput), cacheKey({ ...keyInput, channelId: 'other' }))
})

test('缓存：store -> lookup -> materialize 复制到新产物目录并累计命中', () => {
  const dir = tempDir('cache-')
  try {
    const cache = new ResultCache(dir)
    const source = join(dir, 'src.png')
    writeFileSync(source, tinyPng())
    const key = cacheKey(keyInput)
    assert.equal(cache.lookup(key), undefined)
    const entry = cache.store(key, { channelId: 'relay', model: 'gpt-image-2', size: '3:4', resolution: '2k', count: 1 }, [source])
    assert.ok(entry !== undefined)
    assert.equal(cache.lookup(key)?.files.length, 1)
    const outDir = join(dir, 'out')
    const materialized = cache.materialize(key, outDir, 'page-01')
    assert.ok(materialized !== undefined)
    assert.equal(materialized.length, 1)
    assert.ok(existsSync(join(outDir, 'page-01.png')))
    assert.equal(cache.stats().hits, 1)
    assert.ok(cache.stats().bytes > 0)
  } finally { cleanup(dir) }
})

test('缓存：索引记录存在但文件被删时视为未命中（不返回坏路径）', () => {
  const dir = tempDir('cache-miss-')
  try {
    const cache = new ResultCache(dir)
    const source = join(dir, 'src.png')
    writeFileSync(source, tinyPng())
    const key = cacheKey(keyInput)
    cache.store(key, { channelId: 'relay', model: 'gpt-image-2', size: '3:4', resolution: '2k', count: 1 }, [source])
    const entry = cache.lookup(key)!
    assert.ok(entry.files[0] !== undefined)
    // 删掉缓存文件
    unlinkSync(join(dir, 'cache', entry.files[0]!))
    assert.equal(cache.lookup(key), undefined)
  } finally { cleanup(dir) }
})

test('缓存：prune 按创建时间淘汰，clear 清空', async () => {
  const dir = tempDir('cache-prune-')
  try {
    const cache = new ResultCache(dir)
    for (let index = 0; index < 3; index += 1) {
      const source = join(dir, 'src' + String(index) + '.png')
      writeFileSync(source, tinyPng())
      const key = cacheKey({ ...keyInput, prompt: 'p' + String(index) })
      cache.store(key, { channelId: 'relay', model: 'm', size: '3:4', resolution: '2k', count: 1 }, [source])
      await new Promise((resolve) => { setTimeout(resolve, 5) })
    }
    assert.equal(cache.stats().entries, 3)
    assert.equal(cache.prune(2), 1)
    assert.equal(cache.stats().entries, 2)
    assert.equal(cache.clear(), 2)
    assert.equal(cache.stats().entries, 0)
  } finally { cleanup(dir) }
})

test('查价三层：通道覆盖 > 内置目录 > unknown', () => {
  const override = pricePerImage(channel({ pricing: { currency: 'CNY', default: 1.5 } }), 'gpt-image-2', '2k')
  assert.equal(override.source, 'channel-override')
  assert.equal(override.amount, 1.5)
  const builtin = pricePerImage(channel(), 'gpt-image-2', '2k')
  assert.equal(builtin.source, 'builtin')
  assert.ok((builtin.amount ?? 0) > 0)
  const unknown = pricePerImage(channel(), 'mystery-model-9000', '2k')
  assert.equal(unknown.source, 'unknown')
  assert.equal(unknown.amount, null)
})

test('查价：通道覆盖只写了 1k 时，2k 回落到内置目录（不误用 1k 价）', () => {
  const partial = pricePerImage(channel({ pricing: { '1k': 0.5 } }), 'gpt-image-2', '2k')
  assert.equal(partial.source, 'builtin')
})

test('报价：按张数累乘并给出可信度；未知价 amount=0 且 confidence=unknown', () => {
  const mock = quoteImages({ channel: channel({ kind: 'mock', models: ['mock-image-v1'] }), model: 'mock-image-v1', count: 3, resolution: '1k' })
  assert.equal(mock.amount, 0)
  assert.equal(mock.confidence, 'estimated')
  const exact = quoteImages({ channel: channel({ pricing: { default: 2 } }), model: 'gpt-image-2', count: 3, resolution: '2k' })
  assert.equal(exact.amount, 6)
  assert.equal(exact.confidence, 'exact')
  const unknown = quoteImages({ channel: channel(), model: 'mystery-model-9000', count: 1, resolution: '2k' })
  assert.equal(unknown.confidence, 'unknown')
  assert.equal(unknown.amount, 0)
})

test('确认判定：未知价看开关，已知价看阈值', () => {
  const settings = normalizeSettings({ budgetConfirmCny: 1, confirmUnknownPrice: true })
  const mockQuote = quoteImages({ channel: channel({ kind: 'mock' }), model: 'mock-image-v1', count: 1, resolution: '1k' })
  assert.equal(needsConfirmation(mockQuote, settings), false)
  const cheap = quoteImages({ channel: channel({ pricing: { default: 0.5 } }), model: 'gpt-image-2', count: 1, resolution: '2k' })
  assert.equal(needsConfirmation(cheap, settings), false)
  const pricey = quoteImages({ channel: channel({ pricing: { default: 0.8 } }), model: 'gpt-image-2', count: 2, resolution: '2k' })
  assert.equal(needsConfirmation(pricey, settings), true)
  const unknown = quoteImages({ channel: channel(), model: 'mystery-model-9000', count: 1, resolution: '2k' })
  assert.equal(needsConfirmation(unknown, settings), true)
  const relaxed = normalizeSettings({ ...DEFAULT_SETTINGS, confirmUnknownPrice: false, budgetConfirmCny: 100 })
  assert.equal(needsConfirmation(unknown, relaxed), false)
})

test('模型目录：按名称推断尺寸风格与能力', () => {
  assert.equal(inferModel('gpt-image-2')?.sizeStyle, 'ratio-resolution')
  assert.equal(inferModel('doubao-seedream-4-0-250828')?.sizeStyle, 'ignore')
  assert.equal(inferModel('qwen-image-max')?.supportsReferenceImage, true)
  assert.equal(inferModel('GPT-IMAGE-2')?.match[0], 'gpt-image-2')
  assert.equal(inferModel('mystery-model-9000'), undefined)
  assert.equal(resolveModelSpec('mystery-model-9000'), UNKNOWN_MODEL_SPEC)
})

test('尺寸风格优先级：通道显式 > 通道类型缺省', () => {
  assert.equal(effectiveSizeStyle('ignore', 'openai-images', 'gpt-image-2'), 'ignore')
  assert.equal(effectiveSizeStyle(undefined, 'openai-images', 'gpt-image-2'), 'pixels')
  assert.equal(effectiveSizeStyle(undefined, 'task-images', 'gpt-image-2'), 'ratio-resolution')
  assert.equal(effectiveSizeStyle(undefined, 'mock', 'unknown-model'), 'ratio-resolution')
})
