import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadLibrary, buildLibrary, searchLibrary } from '../src/library/store.ts'
import { suggestTemplates, needsUserChoice } from '../src/prompt/match.ts'

const library = loadLibrary()

test('vendored 数据规模断言（上游 2026-10-03 快照）', () => {
  assert.equal(library.templates.length, 22)
  assert.equal(library.categories.length, 13)
  assert.equal(library.styles.length, 19)
  assert.equal(library.scenes.length, 10)
  assert.equal(library.cases.length, 541)
  assert.ok(library.repository.includes('awesome-gpt-image-2'))
})

test('模板保留了上游的约束知识（guidance / pitfalls / exampleCases）', () => {
  const ui = library.templates.find((template) => template.id === 'ui-screenshot-system')
  assert.ok(ui !== undefined)
  assert.ok((ui.pitfalls.en ?? []).length > 0)
  assert.ok((ui.pitfalls.zh ?? []).length > 0)
  assert.ok((ui.guidance.en ?? []).length > 0)
  assert.deepEqual(ui.exampleCases, [17, 2, 4])
  assert.equal(ui.category, 'UI & Interfaces')
})

test('双语取值：zh 与 en 都取得到，且内容不同', () => {
  const zh = searchLibrary(library, { category: 'UI & Interfaces', limit: 1 }, 'zh')
  const en = searchLibrary(library, { category: 'UI & Interfaces', limit: 1 }, 'en')
  assert.equal(zh.templates[0]?.id, en.templates[0]?.id)
  assert.notEqual(zh.templates[0]?.title, en.templates[0]?.title)
})

test('分类过滤命中全部 UI 模板', () => {
  const result = searchLibrary(library, { category: 'UI & Interfaces', limit: 50 }, 'zh')
  assert.ok(result.totalTemplates >= 1)
  assert.ok(result.templates.every((hit) => hit.category === 'UI & Interfaces'))
})

test('关键词检索命中信息图引擎', () => {
  const result = searchLibrary(library, { query: 'infographic timeline', limit: 5 }, 'zh')
  const ids = result.templates.map((hit) => hit.id)
  assert.ok(ids.includes('infographic-engine'), '实际命中：' + ids.join(','))
})

test('默认只回摘要，include:prompt 才回全文（token 预算由调用方显式打开）', () => {
  const summary = searchLibrary(library, { query: 'poster', limit: 3 }, 'zh')
  assert.ok(summary.cases.every((hit) => hit.prompt === undefined))
  const full = searchLibrary(library, { query: 'poster', limit: 3, include: 'prompt' }, 'zh')
  assert.ok(full.cases.every((hit) => typeof hit.prompt === 'string' && hit.prompt !== ''))
})

test('分页游标：limit 与 nextCursor 自洽', () => {
  const first = searchLibrary(library, { query: 'poster', limit: 2 }, 'zh')
  assert.equal(first.templates.length <= 2, true)
  if (first.nextCursor !== undefined) {
    const second = searchLibrary(library, { query: 'poster', limit: 2, cursor: first.nextCursor }, 'zh')
    const firstIds = new Set(first.templates.map((hit) => hit.id))
    assert.ok(second.templates.every((hit) => !firstIds.has(hit.id)))
  }
})

test('无命中时返回空集合而非抛异常', () => {
  const result = searchLibrary(library, { query: 'qzxqzxqzxwvwv', limit: 3 }, 'zh')
  assert.deepEqual(result.templates, [])
  assert.deepEqual(result.cases, [])
  assert.equal(result.nextCursor, undefined)
})

test('buildLibrary 对坏数据容错（缺字段不炸）', () => {
  const built = buildLibrary({ templates: [{ id: 'x' }, null, 42] }, { cases: [{ id: 'abc' }, { id: 7 }] })
  assert.equal(built.templates.length, 1)
  assert.equal(built.templates[0]?.id, 'x')
  assert.equal(built.cases.length, 1)
  assert.equal(built.cases[0]?.id, 7)
})

test('suggestTemplates：命中时按分数降序返回候选并带理由', () => {
  const candidates = suggestTemplates(library, { category: 'Charts & Infographics', styles: ['Infographic'] }, 'zh', 3)
  assert.ok(candidates.length >= 1 && candidates.length <= 3)
  assert.equal(candidates[0]?.id, 'infographic-engine')
  assert.ok((candidates[0]?.matched.length ?? 0) > 0)
  // needsUserChoice 的语义：候选分差 <=2 或存在兜底时，必须先问用户
  const first = candidates[0]
  const second = candidates[1]
  const closeOrFallback = first === undefined
    || candidates.some((candidate) => candidate.matched.includes('fallback'))
    || (second !== undefined && first.score - second.score <= 2)
  assert.equal(needsUserChoice(candidates), closeOrFallback)
})

test('suggestTemplates：完全无信号时给通用兜底并标注 fallback（必须问用户）', () => {
  const candidates = suggestTemplates(library, { query: 'qzxqzxqzxwvwv' }, 'zh', 3)
  assert.ok(candidates.length > 0)
  assert.ok(candidates.every((candidate) => candidate.matched.includes('fallback')))
  assert.equal(needsUserChoice(candidates), true)
})

test('suggestTemplates：分数接近时要求用户选择', () => {
  const tied = [
    { id: 'a', title: 'A', category: 'c', score: 5, matched: ['x'], useWhen: '', pitfalls: [] },
    { id: 'b', title: 'B', category: 'c', score: 5, matched: ['x'], useWhen: '', pitfalls: [] },
  ]
  assert.equal(needsUserChoice(tied), true)
  assert.equal(needsUserChoice([tied[0]!]), false)
  assert.equal(needsUserChoice([]), false)
})
