import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composePrompt } from '../src/prompt/compose.ts'
import { mergeNegatives, buildConstraintLines, GENERIC_NEGATIVE } from '../src/prompt/negatives.ts'

const QUOTE = String.fromCharCode(34)

function pagePrompt(extra: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    id: 'comic-turing/page-03',
    intent: 'comic-page',
    templateId: 'illustration-art-style',
    subject: 'Turing realises the weather report format never changes',
    composition: { layout: 'cinematic', shot: 'low angle close up', panels: ['storm window', 'telegraph pile'] },
    style: { artStyle: 'ligne-claire', tone: 'dramatic', tags: ['Poster'] },
    characters: [{ name: 'Turing', sheet: 'mid-30s man, round wire-rimmed glasses, grey suit jacket' }],
    text: [{ content: '你还不休息？', kind: 'speech-bubble', speaker: '琼', mustRenderExactly: true }],
    technical: { aspectRatio: '3:4', resolution: '2k', format: 'png' },
    constraints: { avoid: ['photorealistic rendering', 'anime screentones'] },
    ...extra,
  }
}

test('分段顺序固定：STYLE -> SUBJECT -> COMPOSITION -> CHARACTERS -> TEXT -> TECHNICAL -> CONSTRAINTS', () => {
  const composed = composePrompt({
    prompt: pagePrompt(),
    templatePitfalls: ['Avoid vague platform names.'],
    sizeStyle: 'ratio-resolution',
  })
  const order = composed.sections.map((section) => section.split(/[:\s(]/)[0])
  assert.deepEqual(order, ['STYLE', 'SUBJECT', 'COMPOSITION', 'CHARACTERS', 'TEXT', 'TECHNICAL', 'CONSTRAINTS'])
  assert.deepEqual(composed.warnings, [])
})

test('角色表逐字注入（跨页一致性的文字锁）', () => {
  const composed = composePrompt({ prompt: pagePrompt(), templatePitfalls: ['x'] })
  assert.ok(composed.prompt.includes('Turing: mid-30s man, round wire-rimmed glasses, grey suit jacket'))
  assert.ok(composed.prompt.includes('keep identical in every page'))
})

test('画面内文字逐字锁定并带精确渲染指令', () => {
  const composed = composePrompt({ prompt: pagePrompt(), templatePitfalls: ['x'] })
  assert.ok(composed.prompt.includes(QUOTE + '你还不休息？' + QUOTE))
  assert.ok(composed.prompt.includes('render this text exactly'))
})

test('constraints.avoid 进 negative，模板 pitfalls 进约束段（不污染 negative）', () => {
  const composed = composePrompt({
    prompt: pagePrompt(),
    templatePitfalls: ['Avoid vague platform names and generic app mockups.'],
  })
  assert.ok(composed.negative.includes('photorealistic rendering'))
  assert.ok(composed.negative.includes('anime screentones'))
  assert.ok(!composed.negative.includes('Avoid vague platform names'))
  const constraints = composed.sections[composed.sections.length - 1] ?? ''
  assert.ok(constraints.includes('Avoid vague platform names and generic app mockups.'))
})

test('通用负面词默认并入，可显式关闭', () => {
  const withGeneric = composePrompt({ prompt: pagePrompt(), templatePitfalls: ['x'] })
  assert.ok(withGeneric.negative.includes('watermark'))
  const without = composePrompt({ prompt: pagePrompt(), templatePitfalls: ['x'], includeGenericNegative: false })
  assert.ok(!without.negative.includes('watermark'))
  assert.ok(without.negative.includes('photorealistic rendering'))
})

test('全局负面词追加在后，去重大小写不敏感', () => {
  const composed = composePrompt({ prompt: pagePrompt(), templatePitfalls: ['x'], globalNegative: ['Watermark', 'text artifacts'] })
  const parts = composed.negative.split(', ')
  assert.equal(parts.filter((part) => part.toLowerCase() === 'watermark').length, 1)
  assert.ok(composed.negative.includes('text artifacts'))
})

test('尺寸按 sizeStyle 落到 size 字段', () => {
  const ratio = composePrompt({ prompt: pagePrompt(), templatePitfalls: ['x'], sizeStyle: 'ratio-resolution' })
  assert.deepEqual(ratio.size, { size: '3:4', resolution: '2k' })
  const pixels = composePrompt({ prompt: pagePrompt(), templatePitfalls: ['x'], sizeStyle: 'pixels' })
  assert.equal(pixels.size.size, '1024x1536')
})

test('默认 sizeStyle 是 ratio-resolution；缺 technical 时回落 1:1/1k', () => {
  const composed = composePrompt({ prompt: { schemaVersion: 1, intent: 'single-image', subject: 'a mug' } })
  assert.deepEqual(composed.size, { size: '1:1', resolution: '1k' })
})

test('无效输入不抛异常：降级为 warnings', () => {
  const composed = composePrompt({ prompt: { intent: 'nope' } })
  assert.ok(composed.warnings.length >= 2)
  assert.ok(composed.warnings.some((warning) => warning.includes('subject')))
  assert.equal(composed.sections[0], 'SUBJECT: .')
})

test('指定模板但未提供 pitfalls 时告警', () => {
  const composed = composePrompt({ prompt: pagePrompt() })
  assert.ok(composed.warnings.some((warning) => warning.includes('illustration-art-style')))
})

test('未标记 mustRenderExactly 的画面文字触发告警', () => {
  const composed = composePrompt({
    prompt: pagePrompt({ text: [{ content: '你好' }] }),
    templatePitfalls: ['x'],
  })
  assert.ok(composed.warnings.some((warning) => warning.includes('mustRenderExactly')))
})

test('mergeNegatives：保序、去重、丢弃空白', () => {
  const merged = mergeNegatives([['a', 'B'], undefined, ['b', '  ', 'c']])
  assert.deepEqual(merged, ['a', 'B', 'c'])
})

test('buildConstraintLines：must 在前，pitfalls 在后', () => {
  const lines = buildConstraintLines({ must: ['must-not-crop'], pitfalls: ['Avoid vague labels.'] })
  assert.deepEqual(lines, ['must-not-crop', 'Avoid vague labels.'])
})

test('GENERIC_NEGATIVE 非空且无重复', () => {
  assert.ok(GENERIC_NEGATIVE.length > 0)
  assert.equal(new Set(GENERIC_NEGATIVE).size, GENERIC_NEGATIVE.length)
})
