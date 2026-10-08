import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectVisualPlan, RULES } from '../src/comic/select.ts'

test('P0：用户指定覆盖一切自动匹配', () => {
  const result = selectVisualPlan({
    keywords: ['计算机', '编程'],
    userSpecified: { artStyle: 'ink-brush' },
  })
  assert.equal(result.priority, 0)
  assert.equal(result.matchedRule, 'P0-user')
  assert.equal(result.plan.artStyle, 'ink-brush')
  assert.equal(result.plan.tone, 'neutral')
  assert.equal(result.plan.layout, 'dense')
  assert.ok(result.reason.includes('P2-computing'))
})

test('P1：武侠 / 仙侠 / 中国历史 -> ink-brush + dramatic + splash', () => {
  const result = selectVisualPlan({ keywords: ['这是一段武侠故事'] })
  assert.equal(result.matchedRule, 'P1-wuxia-history')
  assert.deepEqual(
    { artStyle: result.plan.artStyle, tone: result.plan.tone, layout: result.plan.layout },
    { artStyle: 'ink-brush', tone: 'dramatic', layout: 'splash' },
  )
})

test('P2：计算机 / AI / 编程 -> ligne-claire + neutral + dense', () => {
  const result = selectVisualPlan({ keywords: ['Transformer 是一种人工智能算法'] })
  assert.equal(result.matchedRule, 'P2-computing')
  assert.equal(result.plan.layout, 'dense')
  assert.ok(result.matchedKeywords.length > 0)
})

test('P8：教程 / 入门 -> chalk + neutral + dense', () => {
  const result = selectVisualPlan({ keywords: ['新手教程：如何安装'] })
  assert.equal(result.matchedRule, 'P8-tutorial')
  assert.equal(result.plan.artStyle, 'chalk')
})

test('P10：科普 / 百科 -> ligne-claire + warm + webtoon', () => {
  const result = selectVisualPlan({ keywords: ['一档科普节目'] })
  assert.equal(result.matchedRule, 'P10-popular-science')
  assert.deepEqual(
    { artStyle: result.plan.artStyle, tone: result.plan.tone, layout: result.plan.layout },
    { artStyle: 'ligne-claire', tone: 'warm', layout: 'webtoon' },
  )
})

test('优先级：同时命中 P1 与 P2 信号时取更高优先级（P1）', () => {
  const result = selectVisualPlan({ keywords: ['武侠世界里的一台计算机'] })
  assert.equal(result.matchedRule, 'P1-wuxia-history')
})

test('无信号：使用中性兜底并标注 default', () => {
  const result = selectVisualPlan({ keywords: ['一些无关的词'] })
  assert.equal(result.matchedRule, 'default')
  assert.equal(result.priority, 99)
  assert.deepEqual(result.plan, { artStyle: 'ligne-claire', tone: 'neutral', layout: 'standard', aspectRatio: '3:4' })
})

test('默认宽高比恒为 3:4（竖版），用户可覆盖', () => {
  assert.equal(selectVisualPlan({ keywords: [] }).plan.aspectRatio, '3:4')
  assert.equal(selectVisualPlan({ keywords: [], userSpecified: { aspectRatio: '16:9' } }).plan.aspectRatio, '16:9')
})

test('确定性：同信号多次调用结果完全一致', () => {
  const a = selectVisualPlan({ keywords: ['教程'] })
  const b = selectVisualPlan({ keywords: ['教程'] })
  assert.deepEqual(a, b)
})

test('规则表覆盖 P1-P10 且优先级唯一递增', () => {
  assert.equal(RULES.length, 10)
  const priorities = RULES.map((rule) => rule.priority)
  assert.deepEqual(priorities, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})
