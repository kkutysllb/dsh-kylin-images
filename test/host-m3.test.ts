import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '../src/host/registry.ts'
import { ARTIFACT_PATH, API_PREFIX, handleRequest, resolveArtifact } from '../src/host/routes.ts'
import type { PluginRuntime } from '../src/host/registry.ts'

function tempDir(): string {
  return mkdtempSync(join(process.cwd(), '.scratch', 'm3-'))
}

function get(pathname: string, query: Record<string, string> = {}) {
  return { method: 'GET', pathname, host: '127.0.0.1:1', headers: { host: '127.0.0.1:1' }, query }
}

function post(pathname: string) {
  return { method: 'POST', pathname: API_PREFIX + pathname, host: '127.0.0.1:1', headers: { host: '127.0.0.1:1' } }
}

async function withRuntime<T>(fn: (runtime: PluginRuntime, home: string) => Promise<T>): Promise<T> {
  const home = tempDir()
  const runtime = createRuntime(home)
  try {
    return await fn(runtime, home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('产物路径解析：目录内相对路径通过，穿越与绝对路径一律拒绝', () => {
  const root = '/tmp/kimg-root'
  assert.equal(resolveArtifact(root, 'comics/a/images/00.png'), join(root, 'comics/a/images/00.png'))
  assert.equal(resolveArtifact(root, './comics/a/01.png'), join(root, 'comics/a/01.png'))
  assert.equal(resolveArtifact(root, '../etc/passwd'), undefined)
  assert.equal(resolveArtifact(root, 'comics/../../etc/passwd'), undefined)
  // 绝对路径被当作「根目录内的相对路径」处理（前导 / 被剥掉），仍然出不去：
  assert.equal(resolveArtifact(root, '/etc/passwd'), join(root, 'etc/passwd'))
  // 但显式穿越不行：
  assert.equal(resolveArtifact(root, '/../etc/passwd'), undefined)
  assert.equal(resolveArtifact(root, ''), undefined)
  assert.equal(resolveArtifact(root, '   '), undefined)
  assert.equal(resolveArtifact(root, 'a/../../..'), undefined)
})

test('产物路由：存在则返回文件句柄，越界 400，缺失 404', async () => {
  await withRuntime(async (runtime, home) => {
    mkdirSync(join(home, 'comics', 'demo', 'images'), { recursive: true })
    writeFileSync(join(home, 'comics', 'demo', 'images', '00-page.png'), 'PNG')
    const ok = await handleRequest(runtime, get(ARTIFACT_PATH, { path: 'comics/demo/images/00-page.png' }), {})
    assert.equal(ok?.status, 200)
    assert.equal((ok?.payload as { __file: string }).__file, join(home, 'comics', 'demo', 'images', '00-page.png'))
    const traversal = await handleRequest(runtime, get(ARTIFACT_PATH, { path: '../../../etc/passwd' }), {})
    assert.equal(traversal?.status, 400)
    const missing = await handleRequest(runtime, get(ARTIFACT_PATH, { path: 'comics/demo/images/nope.png' }), {})
    assert.equal(missing?.status, 404)
    const empty = await handleRequest(runtime, get(ARTIFACT_PATH, {}), {})
    assert.equal(empty?.status, 400)
  })
})

test('漫画 HTTP 面：list 空态、status 缺 id、完整流程后 status 有内容', async () => {
  await withRuntime(async (runtime) => {
    const empty = await handleRequest(runtime, get(API_PREFIX + '/comic.list'), {})
    assert.equal(empty?.status, 200)
    assert.deepEqual((empty?.payload as { value: unknown[] }).value, [])

    const missingId = await handleRequest(runtime, get(API_PREFIX + '/comic.status'), {})
    assert.equal(missingId?.status, 400)

    runtime.vault.upsert({ id: 'mock', label: 'mock', kind: 'mock' })
    const opened = await handleRequest(runtime, post('/comic.action'), { action: 'open', topic: 'HTTP 漫画', keywords: ['教程'] })
    assert.equal(opened?.status, 200)
    const project = (opened?.payload as { value: { project: { id: string; plan: { artStyle: string } } } }).value.project
    assert.equal(project.plan.artStyle, 'chalk', 'P8 教程信号选中粉笔风格')

    const list = await handleRequest(runtime, get(API_PREFIX + '/comic.list'), {})
    const rows = (list?.payload as { value: Array<{ id: string; pages: number; rendered: number }> }).value
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, project.id)
    assert.equal(rows[0]?.pages, 0)

    const status = await handleRequest(runtime, get(API_PREFIX + '/comic.status', { id: project.id }), {})
    assert.equal(status?.status, 200)
    assert.equal((status?.payload as { value: { id: string } }).value.id, project.id)

    const unknown = await handleRequest(runtime, post('/comic.action'), { action: 'nope', id: project.id })
    assert.equal(unknown?.status, 400)
  })
})
