import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(ROOT, 'data', 'upstream.lock.json'), 'utf8'))

function digest(name: string): string {
  const text = readFileSync(join(ROOT, 'data', name), 'utf8')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test('lock 钉住了上游仓库与 commit', () => {
  assert.equal(lock.repository, 'freestylefly/awesome-gpt-image-2')
  assert.equal(lock.commit, '65a9c57a1968a13f2f1997c58409cac9aa146bc7')
  assert.equal(lock.license, 'MIT')
  assert.equal(lock.notice, 'THIRD_PARTY_NOTICES.md')
})

test('vendored 数据文件哈希与 lock 一致（未被静默改动）', () => {
  for (const name of ['style-library.json', 'cases.json']) {
    assert.equal(digest(name), lock.files[name].sha256, name + ' 哈希不匹配，请运行 npm run sync:upstream')
  }
})

test('lock 记录了结构计数，与数据实际规模一致', () => {
  const style = JSON.parse(readFileSync(join(ROOT, 'data', 'style-library.json'), 'utf8'))
  const cases = JSON.parse(readFileSync(join(ROOT, 'data', 'cases.json'), 'utf8'))
  assert.equal(lock.files['style-library.json'].counts.templates, style.templates.length)
  assert.equal(lock.files['style-library.json'].counts.categories, style.categories.length)
  assert.equal(lock.files['cases.json'].counts.cases, cases.cases.length)
})

test('许可与署名文件存在（MIT 合规）', () => {
  assert.ok(readFileSync(join(ROOT, 'LICENSE'), 'utf8').includes('MIT License'))
  const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  assert.ok(notices.includes('freestylefly'))
  assert.ok(notices.includes('Copyright (c) 2026 freestylefly'))
})
