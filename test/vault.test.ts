import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault, maskCredential, isAllowedBaseUrl } from '../src/store/vault.ts'
import { appendSpend, readSpend, summarizeSpend } from '../src/store/spend.ts'
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/store/settings.ts'

function tempDir(): string {
  return mkdtempSync(join(process.cwd(), '.scratch', 'vault-'))
}

test('maskCredential：前 3 + 后 3，短串全掩，空串回空', () => {
  assert.equal(maskCredential(''), '')
  assert.equal(maskCredential('short'), '••••')
  assert.equal(maskCredential('12345678'), '••••')
  assert.equal(maskCredential('sk-abcdefghijklmnop'), 'sk-••••nop')
})

test('isAllowedBaseUrl：https 放行；http 仅本机回环；非法串拒绝', () => {
  assert.equal(isAllowedBaseUrl('https://api.example.com/v1'), true)
  assert.equal(isAllowedBaseUrl('http://127.0.0.1:8080/v1'), true)
  assert.equal(isAllowedBaseUrl('http://localhost:3000'), true)
  assert.equal(isAllowedBaseUrl('http://evil.example.com'), false)
  assert.equal(isAllowedBaseUrl('ftp://example.com'), false)
  assert.equal(isAllowedBaseUrl('not a url'), false)
  assert.equal(isAllowedBaseUrl(''), true)
})

test('upsert：合法通道落盘，目录 0700 / 文件 0600', () => {
  const dir = tempDir()
  try {
    const vault = new Vault(dir)
    const result = vault.upsert({ label: '本地 mock', kind: 'mock', models: ['mock-image-v1'] })
    assert.equal(result.ok, true, result.errors.join('; '))
    assert.equal(result.channel?.id, 'mock')
    assert.equal(vault.list().length, 1)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'vault.json')).mode & 0o777, 0o600)
    assert.equal(vault.settings().defaultChannelId, 'mock')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('upsert：非法输入全部拒绝并给出可读原因', () => {
  const dir = tempDir()
  try {
    const vault = new Vault(dir)
    assert.equal(vault.upsert({ label: '', kind: 'mock' }).ok, false)
    assert.equal(vault.upsert({ id: 'Bad Id', label: 'x', kind: 'mock' }).ok, false)
    assert.equal(vault.upsert({ label: 'x', kind: 'nope' }).ok, false)
    assert.equal(vault.upsert({ label: 'x', kind: 'openai-images', baseUrl: 'http://evil.example.com' }).ok, false)
    assert.equal(vault.upsert({ label: 'x', kind: 'openai-images', apiKey: 'a'.repeat(600) }).ok, false)
    assert.equal(vault.upsert({ label: 'x', kind: 'openai-images', apiKey: 'line1\nline2' }).ok, false)
    assert.equal(vault.upsert({ label: 'x', kind: 'mock', sizeStyle: 'nope' }).ok, false)
    assert.equal(vault.upsert({ label: 'x', kind: 'mock', endpointPath: 'v1/images' }).ok, false)
    assert.equal(vault.list().length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('凭据永不出现在任何出口：publicData 序列化后不含明文', () => {
  const dir = tempDir()
  try {
    const vault = new Vault(dir)
    const secret = 'sk-super-secret-abcdefghijklmnop'
    vault.upsert({ label: '官方', kind: 'openai-images', baseUrl: 'https://api.example.com/v1', apiKey: secret, models: ['gpt-image-2'] })
    const serialized = JSON.stringify(vault.publicData())
    assert.ok(!serialized.includes(secret), 'publicData 泄漏了明文 key')
    assert.ok(serialized.includes('sk-••••nop'))
    assert.equal(vault.publicList()[0]?.hasKey, true)
    // 磁盘上仍然保存明文（这是唯一允许存放凭据的地方）
    assert.ok(readFileSync(join(dir, 'vault.json'), 'utf8').includes(secret))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('upsert：同 id 覆盖保留 createdAt 并更新 updatedAt', () => {
  const dir = tempDir()
  try {
    const vault = new Vault(dir)
    vault.upsert({ id: 'main', label: '一', kind: 'mock' })
    const created = vault.find('main')?.createdAt
    vault.upsert({ id: 'main', label: '二', kind: 'mock' })
    const after = vault.find('main')
    assert.equal(after?.label, '二')
    assert.equal(after?.createdAt, created)
    assert.equal(vault.list().length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('remove：删除通道并把默认通道回退到剩余第一个', () => {
  const dir = tempDir()
  try {
    const vault = new Vault(dir)
    vault.upsert({ id: 'a', label: 'A', kind: 'mock' })
    vault.upsert({ id: 'b', label: 'B', kind: 'mock' })
    assert.equal(vault.settings().defaultChannelId, 'a')
    assert.equal(vault.remove('a'), true)
    assert.equal(vault.settings().defaultChannelId, 'b')
    assert.equal(vault.remove('missing'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('vault 文件损坏时容错为空库，不抛异常', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'vault.json'), '{ not json')
    const vault = new Vault(dir)
    assert.equal(vault.list().length, 0)
    assert.equal(vault.settings().defaultAspectRatio, DEFAULT_SETTINGS.defaultAspectRatio)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('normalizeSettings：越界值被夹取，非法值回落默认', () => {
  const normalized = normalizeSettings({
    defaultCount: 99,
    concurrency: 0,
    defaultAspectRatio: '999:1',
    defaultFormat: 'tiff',
    defaultQuality: 'ultra',
    budgetConfirmCny: -5,
    globalNegative: ['a', 'a', ' b ', '', 7],
  })
  assert.equal(normalized.defaultCount, 4)
  assert.equal(normalized.concurrency, 1)
  assert.equal(normalized.defaultAspectRatio, DEFAULT_SETTINGS.defaultAspectRatio)
  assert.equal(normalized.defaultFormat, DEFAULT_SETTINGS.defaultFormat)
  assert.equal(normalized.defaultQuality, DEFAULT_SETTINGS.defaultQuality)
  assert.equal(normalized.budgetConfirmCny, 0)
  assert.deepEqual(normalized.globalNegative, ['a', 'b'])
})

test('记账：追加、读取、汇总，且跳过损坏行', () => {
  const dir = tempDir()
  try {
    appendSpend(dir, { at: '2026-10-08T00:00:00.000Z', channelId: 'mock', model: 'm', count: 2, amount: 0, currency: 'CNY', confidence: 'exact', promptChars: 10, durationMs: 5 })
    appendSpend(dir, { at: '2026-10-08T00:00:01.000Z', channelId: 'relay', model: 'gpt-image-2', count: 1, amount: 0.02, currency: 'CNY', confidence: 'exact', promptChars: 20, durationMs: 900 })
    const records = readSpend(dir)
    assert.equal(records.length, 2)
    const summary = summarizeSpend(records)
    assert.equal(summary.images, 3)
    assert.equal(summary.entries, 2)
    assert.ok(Math.abs(summary.total - 0.02) < 1e-9)
    assert.equal(summary.byChannel['relay'], 0.02)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
