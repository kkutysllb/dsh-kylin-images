import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ComicStore, slugify } from '../src/comic/project.ts'
import { buildPagePrompt, parseCharacters, parseStoryboard, stylePreambleOf } from '../src/comic/plan.ts'
import { renderContactSheet } from '../src/comic/assemble.ts'
import { runComicAction, listProjects } from '../src/comic/service.ts'
import { createRuntime } from '../src/host/registry.ts'
import type { ComicProject } from '../src/comic/project.ts'
import { cleanup, tempDir } from './helpers.ts'

const PLAN = { artStyle: 'ligne-claire', tone: 'neutral', layout: 'dense', aspectRatio: '3:4' } as const

test('slugify：中英文都能出 2-4 个关键词的 kebab slug', () => {
  assert.equal(slugify('Alan Turing Life'), 'alan-turing-life')
  assert.equal(slugify('图灵的密码战争'), '图灵的密码战争')
  assert.equal(slugify('The Life of Alan Turing'), 'life-alan-turing')
  assert.equal(slugify('  '), 'comic')
  assert.ok(slugify('a very long topic about distributed systems and consensus').length <= 48)
})

test('ComicStore：建目录、原子落盘、冲突追加时间戳、可列举', () => {
  const root = tempDir('comic-store-')
  try {
    const store = new ComicStore(root)
    const first = store.create('图灵', { plan: PLAN, selection: { priority: 9, matchedRule: 'P9-biography', reason: 'x' }, channelId: 'mock', model: 'm', imageLock: true })
    assert.equal(first.id, '图灵')
    assert.ok(existsSync(join(root, '图灵', 'comic.json')))
    assert.equal(statSync(join(root, '图灵', 'comic.json')).mode & 0o777, 0o600)
    const second = store.create('图灵', { plan: PLAN, selection: { priority: 9, matchedRule: 'P9-biography', reason: 'x' }, channelId: 'mock', model: 'm', imageLock: true })
    assert.notEqual(second.id, first.id)
    assert.equal(store.list().length, 2)
    assert.equal(store.read('不存在'), undefined)
  } finally { cleanup(root) }
})

test('parseStoryboard：必填校验与容错', () => {
  const ok = parseStoryboard({ pages: [{ title: '封面', core: '主题', dialogue: [{ speaker: '甲', text: '你好' }] }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.pages[0]?.dialogue?.[0]?.text, '你好')
  assert.equal(parseStoryboard({}).ok, false)
  assert.equal(parseStoryboard({ pages: [{}] }).ok, false)
  assert.equal(parseStoryboard({ pages: [] }).ok, false)
  const many = parseStoryboard({ pages: Array.from({ length: 41 }, () => ({ title: 'x' })) })
  assert.equal(many.ok, false)
  assert.ok(parseStoryboard({ pages: [{ title: 'x', dialogue: 'nope' }] }).errors.some((error) => error.includes('dialogue')))
})

test('parseCharacters：sheet 必填（文字锁的前提）', () => {
  const ok = parseCharacters([{ name: '阿岚', sheet: 'late-20s, round glasses' }])
  assert.equal(ok.ok, true)
  assert.equal(parseCharacters([{ name: '阿岚' }]).ok, false)
  assert.equal(parseCharacters(Array.from({ length: 9 }, (_v, index) => ({ name: 'c' + String(index), sheet: 'x' }))).ok, false)
})

test('buildPagePrompt：封面/内页意图、角色过滤、对白逐字、风格锁前言一致', () => {
  const characters = [{ name: '阿岚', sheet: 'late-20s Chinese woman, round glasses' }, { name: '老周', sheet: '50s man, grey beard' }]
  const cover = buildPagePrompt({ page: { title: '图灵的密码战争' }, index: 0, projectId: 'p', plan: PLAN, characters })
  assert.equal(cover.intent, 'single-image')
  assert.ok(cover.subject.includes('封面'))
  assert.equal(cover.characters, undefined)

  const page = buildPagePrompt({
    page: {
      title: '破译之夜',
      core: '图灵发现天气报文格式固定',
      scene: '布莱切利园小屋，深夜',
      characters: ['阿岚'],
      layout: 'cinematic',
      panels: ['暴雨窗外', '电报堆'],
      focus: '抬头瞬间',
      dialogue: [{ speaker: '老周', text: '你还不休息？' }],
    },
    index: 3,
    projectId: 'p',
    plan: PLAN,
    characters,
  })
  assert.equal(page.intent, 'comic-page')
  assert.equal(page.characters?.length, 1, '只注入本页出场角色')
  assert.equal(page.characters?.[0]?.name, '阿岚')
  assert.equal(page.composition?.layout, 'cinematic', '单页可覆盖布局')
  assert.equal(page.style?.artStyle, 'ligne-claire', '风格来自项目（风格锁）')
  assert.equal(page.text?.[0]?.content, '你还不休息？')
  assert.equal(page.text?.[0]?.mustRenderExactly, true)
  assert.deepEqual(page.constraints?.must, [stylePreambleOf(PLAN)])
})

test('风格锁：全篇每页的前言逐字一致', () => {
  const pages = [0, 1, 2].map((index) => buildPagePrompt({ page: { title: 'p' + String(index) }, index, projectId: 'x', plan: PLAN, characters: [] }))
  const preambles = new Set(pages.map((page) => page.constraints?.must?.[0]))
  assert.equal(preambles.size, 1)
  assert.equal([...preambles][0], stylePreambleOf(PLAN))
})

test('联系表：HTML 转义、未出图占位、打印样式', () => {
  const project: ComicProject = {
    version: 1, id: 'p', topic: '<script>alert(1)</script>', createdAt: 'x', updatedAt: 'x',
    stage: 'planned', plan: PLAN, selection: { priority: 1, matchedRule: 'P1', reason: 'r' },
    channelId: 'mock', model: 'm', characters: [{ name: '阿岚', sheet: 's' }], imageLock: true,
    spend: { images: 1, amount: 0, currency: 'CNY' },
    pages: [
      { index: 0, title: '封面 <b>', promptFile: 'prompts/00-page.json', status: 'rendered', imagePath: 'images/00-page.png' },
      { index: 1, title: '第二页', promptFile: 'prompts/01-page.json', status: 'pending' },
    ],
  }
  const html = renderContactSheet(project, { now: '2026-10-08T00:00:00.000Z' })
  assert.ok(!html.includes('<script>alert(1)</script>'), '必须转义用户内容')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('images/00-page.png'))
  assert.ok(html.includes('未生成'))
  assert.ok(html.includes('@media print'))
  assert.ok(html.includes('ligne-claire'))
})

test('img_comic 全流程（mock 通道，零成本）：open -> plan -> sheet -> render -> assemble', async () => {
  const home = tempDir('comic-home-')
  try {
    const runtime = createRuntime(home)
    runtime.vault.upsert({ id: 'mock', label: 'mock', kind: 'mock', models: ['mock-image-v1'] })

    const opened = await runComicAction(runtime, { action: 'open', topic: '图灵的密码战争', keywords: ['计算机', '编程'], source: '# 源材料' })
    assert.equal(opened.ok, true, opened.message)
    const id = opened.project?.id ?? ''
    assert.equal(opened.project?.plan.artStyle, 'ligne-claire', 'P2 计算机信号选中清线风格')
    assert.ok(existsSync(join(home, 'comics', id, 'source.md')))

    const planned = await runComicAction(runtime, {
      action: 'plan', id,
      characters: [{ name: '阿岚', sheet: 'late-20s Chinese woman, round glasses, dark hoodie' }],
      storyboard: { pages: [
        { title: '封面：图灵的密码战争', core: '破译 Enigma 的故事' },
        { title: '深夜的灵感', core: '发现天气报文格式固定', scene: '布莱切利园，深夜', characters: ['阿岚'], dialogue: [{ speaker: '阿岚', text: '时间戳怎么全一样？' }] },
      ] },
    })
    assert.equal(planned.ok, true, planned.message)
    assert.equal(planned.project?.pages.length, 2)
    const dir = join(home, 'comics', id)
    assert.ok(existsSync(join(dir, 'prompts', '01-page.json')))
    const compiled = JSON.parse(readFileSync(join(dir, 'prompts', '01-page.json'), 'utf8'))
    assert.equal(compiled.characters[0].name, '阿岚')
    assert.equal(compiled.text[0].content, '时间戳怎么全一样？')
    assert.ok(existsSync(join(dir, 'storyboard.md')))
    assert.ok(existsSync(join(dir, 'characters.md')))

    const sheet = await runComicAction(runtime, { action: 'sheet', id })
    assert.equal(sheet.ok, true, sheet.message)
    assert.ok(existsSync(join(dir, 'images', 'sheet-character.png')))

    const rendered = await runComicAction(runtime, { action: 'render', id, concurrency: 2 })
    assert.equal(rendered.ok, true, rendered.message)
    assert.equal(rendered.project?.pages.filter((page) => page.status === 'rendered').length, 2)
    assert.ok(existsSync(join(dir, 'images', '00-page.png')))
    assert.ok(existsSync(join(dir, 'images', '01-page.png')))
    assert.equal(rendered.project?.stage, 'rendered')

    const status = await runComicAction(runtime, { action: 'status', id })
    assert.ok(status.message.includes('2/2 页已出图'))
    assert.equal(listProjects(runtime).length, 1)

    const assembled = await runComicAction(runtime, { action: 'assemble', id })
    assert.equal(assembled.ok, true)
    const html = readFileSync(join(dir, 'contact-sheet.html'), 'utf8')
    assert.ok(html.includes('01-page.png'))
    assert.ok(html.includes('图灵的密码战争'))
    assert.equal(assembled.project?.stage, 'assembled')

    // 重复 render 应命中缓存：页已渲染则不再处理
    const again = await runComicAction(runtime, { action: 'render', id })
    assert.ok(again.message.includes('没有待渲染的页'))
  } finally { cleanup(home) }
})

test('img_comic：open 缺通道时给出可执行指引；plan 缺 storyboard 时只更新角色', async () => {
  const home = tempDir('comic-noc-')
  try {
    const runtime = createRuntime(home)
    const noChannel = await runComicAction(runtime, { action: 'open', topic: 'x' })
    assert.equal(noChannel.ok, false)
    assert.ok(noChannel.message.includes('视觉模型'))
    runtime.vault.upsert({ id: 'mock', label: 'mock', kind: 'mock' })
    const opened = await runComicAction(runtime, { action: 'open', topic: 'x' })
    const id = opened.project?.id ?? ''
    const partial = await runComicAction(runtime, { action: 'plan', id, characters: [{ name: 'A', sheet: 'a' }] })
    assert.equal(partial.ok, true)
    assert.ok(partial.message.includes('尚未收到 storyboard'))
    const bad = await runComicAction(runtime, { action: 'plan', id, storyboard: { pages: [{}] } })
    assert.equal(bad.ok, false)
    assert.equal(await runComicAction(runtime, { action: 'nope', id }).then((outcome) => outcome.ok), false)
  } finally { cleanup(home) }
})
