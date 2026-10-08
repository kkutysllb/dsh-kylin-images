/**
 * 知识漫画服务：img_comic 的全部动作。
 *
 * 职责边界（与设计规格 §9.2 一致）：插件零 LLM 调用——分析/角色/分镜三段由会话模型产出，
 * 插件只做校验、落盘、编译、执行、组装。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenerationOutcome, GenerationInput } from '../host/generate.ts'
import { runBatch, runGeneration } from '../host/generate.ts'
import type { PluginRuntime } from '../host/registry.ts'
import type { ImagePrompt } from '../prompt/schema.ts'
import type { VisualPlan } from './select.ts'
import { selectVisualPlan } from './select.ts'
import { CONTACT_SHEET_FILE, writeContactSheet } from './assemble.ts'
import { buildPagePrompt, describePlan, parseCharacters, parseStoryboard, stylePreambleOf } from './plan.ts'
import { ComicStore, comicRoot, imagePathFor, promptPathFor } from './project.ts'
import type { ComicCharacter, ComicPage, ComicProject } from './project.ts'

export const SHEET_FILE = 'images/sheet-character.png'

export interface ComicActionInput {
  action: string
  id?: string | undefined
  topic?: string | undefined
  source?: string | undefined
  analysis?: string | undefined
  keywords?: string[] | undefined
  plan?: Partial<VisualPlan> | undefined
  channelId?: string | undefined
  model?: string | undefined
  dir?: string | undefined
  imageLock?: boolean | undefined
  characters?: unknown
  storyboard?: unknown
  pages?: number[] | undefined
  concurrency?: number | undefined
  confirm?: boolean | undefined
}

export interface ComicOutcome {
  ok: boolean
  message: string
  project?: ComicProject | undefined
  /** 本动作直接产出或引用的绝对路径。 */
  artifacts: string[]
  /** 需要用户确认时给出（成本护栏）。 */
  pendingConfirm?: number | undefined
}

function fail(message: string): ComicOutcome {
  return { ok: false, message, artifacts: [] }
}

function store(runtime: PluginRuntime, dir?: string): ComicStore {
  return new ComicStore(comicRoot(runtime.home, dir))
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function writeText(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
}

function progressOf(project: ComicProject): string {
  const rendered = project.pages.filter((page) => page.status === 'rendered').length
  const failed = project.pages.filter((page) => page.status === 'failed').length
  return String(rendered) + '/' + String(project.pages.length) + ' 页已出图' + (failed === 0 ? '' : '（失败 ' + String(failed) + '）')
}

function relativeTo(dir: string, path: string): string {
  return path.startsWith(dir) ? path.slice(dir.length).replace(/^\//, '') : path
}

function sheetPrompt(project: ComicProject): ImagePrompt {
  const lines = project.characters.map((character, index) => String(index + 1) + '. ' + character.name + ': ' + character.sheet)
  return {
    schemaVersion: 1,
    id: project.id + '/character-sheet',
    intent: 'single-image',
    subject: '角色设定三视图（正面 / 侧面 / 背面），用于后续所有页面的形象一致性参考。角色：' + project.characters.map((character) => character.name).join('、'),
    composition: { layout: 'dense', shot: 'full body, three views side by side on a plain background', hierarchy: ['统一比例', '统一服装', '统一发型与配件'] },
    style: { artStyle: project.plan.artStyle, tone: project.plan.tone, tags: ['Character'] },
    text: [{ content: project.characters.map((character) => character.name).join(' / '), kind: 'label', mustRenderExactly: true }],
    technical: { aspectRatio: '16:9', resolution: '2k', format: 'png' },
    constraints: {
      must: [stylePreambleOf(project.plan), 'No background scenery: plain neutral backdrop so the sheet can be used as a reference image.'],
      avoid: ['multiple unrelated characters', 'background scenery', 'different outfits between views'],
    },
    meta: { source: 'comic:' + project.id + '#sheet', notes: lines.join(' | ') },
  }
}

/** 行动作分发。永不抛异常（错误转成 ok:false 的可读消息）。 */
export async function runComicAction(runtime: PluginRuntime, input: ComicActionInput): Promise<ComicOutcome> {
  const action = input.action

  // ── open ─────────────────────────────────────────────────────────────
  if (action === 'open') {
    const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
    if (topic === '') return fail('open 需要 topic（主题或标题）。')
    const keywords = input.keywords !== undefined && input.keywords.length > 0 ? input.keywords : [topic]
    const selection = selectVisualPlan({ keywords, userSpecified: input.plan })
    const settings = runtime.vault.settings()
    const channelId = input.channelId ?? settings.defaultChannelId
    const channel = runtime.vault.find(channelId)
    if (channel === undefined) {
      return fail('尚未配置可用的图像通道：请先在「视觉模型」里添加通道（mock 通道可零密钥先跑通全流程）。')
    }
    const model = input.model ?? settings.defaultModel ?? channel.models[0] ?? ''
    const comicStore = store(runtime, input.dir)
    const project = comicStore.create(topic, {
      plan: selection.plan,
      selection: { priority: selection.priority, matchedRule: selection.matchedRule, reason: selection.reason },
      channelId: channel.id,
      model,
      imageLock: input.imageLock !== false,
    })
    const dir = comicStore.dirOf(project.id)
    if (typeof input.source === 'string' && input.source.trim() !== '') {
      writeText(join(dir, 'source.md'), input.source.trim() + String.fromCharCode(10))
    }
    return {
      ok: true,
      message: [
        '已开项目 ' + project.id + '（目录 ' + dir + '）',
        '自动视觉方案：' + describePlan(project.plan) + '（' + selection.matchedRule + '：' + selection.reason + '）',
        '通道 ' + project.channelId + ' · 模型 ' + (project.model === '' ? '（未指定）' : project.model),
        typeof input.source === 'string' && input.source.trim() !== '' ? '源内容已写入 source.md' : '未附源内容：若只有主题，请先补齐 source.md（可用检索整理）再由你确认。',
        '',
        '下一步（plan）：产出 characters（角色表，跨页一致的文字锁）与 storyboard（分镜），带 id 调回本工具。',
      ].join(String.fromCharCode(10)),
      project,
      artifacts: [dir],
    }
  }

  // 其余动作都需要 id
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '') return fail(action + ' 需要 id（项目标识）。用 img_comic action=status 查看已有项目。')
  const comicStore = store(runtime, input.dir)
  const project = comicStore.read(id)
  if (project === undefined) return fail('找不到项目 ' + id + '。')
  const dir = comicStore.dirOf(id)

  // ── plan ─────────────────────────────────────────────────────────────
  if (action === 'plan') {
    const problems: string[] = []
    if (input.analysis !== undefined) {
      writeText(join(dir, 'analysis.md'), String(input.analysis) + String.fromCharCode(10))
    }
    if (input.characters !== undefined) {
      const parsed = parseCharacters(input.characters)
      if (!parsed.ok) problems.push(...parsed.errors)
      else {
        project.characters = parsed.value
        writeText(join(dir, 'characters.md'), parsed.value.map((character) => '## ' + character.name + String.fromCharCode(10, 10) + character.sheet).join(String.fromCharCode(10, 10)) + String.fromCharCode(10))
      }
    }
    if (problems.length > 0) return fail('计划未落盘：' + problems.join('；'))

    if (input.storyboard !== undefined) {
      const parsed = parseStoryboard(input.storyboard)
      if (!parsed.ok) return fail('分镜未落盘：' + parsed.errors.join('；'))
      // 角色名必须是项目角色表里的名字，否则那句 sheet 注入不进去（文字锁会静默失效）
      const known = new Set(project.characters.map((character) => character.name))
      const unknown = new Set<string>()
      for (const page of parsed.value.pages) {
        for (const name of page.characters ?? []) {
          if (!known.has(name)) unknown.add(name)
        }
      }
      if (unknown.size > 0) {
        return fail('分镜引用了未登记的角色：' + [...unknown].join('、') + '。请先在 characters 里登记（名字需完全一致）。')
      }
      ensureDir(join(dir, 'prompts'))
      const pages: ComicPage[] = []
      parsed.value.pages.forEach((page, index) => {
        const prompt = buildPagePrompt({
          page,
          index,
          projectId: project.id,
          plan: project.plan,
          characters: project.characters,
        })
        const relative = promptPathFor(index)
        writeText(join(dir, relative), JSON.stringify(prompt, null, 2) + String.fromCharCode(10))
        pages.push({ index, title: page.title, promptFile: relative, status: 'pending' })
      })
      project.pages = pages
      writeText(join(dir, 'storyboard.md'), parsed.value.pages.map((page, index) => [
        '## Page ' + String(index).padStart(2, '0') + '：' + page.title,
        page.core === undefined ? '' : '- 核心信息：' + page.core,
        page.scene === undefined ? '' : '- 场景：' + page.scene,
        page.characters === undefined ? '' : '- 角色：' + page.characters.join('、'),
        '- 布局：' + (page.layout ?? project.plan.layout),
        page.focus === undefined ? '' : '- 视觉焦点：' + page.focus,
      ].filter((line) => line !== '').join(String.fromCharCode(10))).join(String.fromCharCode(10, 10)) + String.fromCharCode(10))
      project.stage = 'planned'
      comicStore.write(project)
      return {
        ok: true,
        message: [
          '已落盘 ' + String(project.pages.length) + ' 页分镜与提示词（prompts/ 目录）',
          '角色 ' + String(project.characters.length) + ' 个；风格锁：' + describePlan(project.plan),
          '下一步：img_comic action=sheet 生成角色三视图（图像锁），或直接 action=render 逐页出图。',
        ].join(String.fromCharCode(10)),
        project,
        artifacts: [join(dir, 'storyboard.md'), join(dir, 'prompts')],
      }
    }
    comicStore.write(project)
    return { ok: true, message: '已更新角色/分析，尚未收到 storyboard。', project, artifacts: [dir] }
  }

  // ── sheet（图像锁：角色三视图）─────────────────────────────────────────
  if (action === 'sheet') {
    if (project.characters.length === 0) return fail('还没有角色表：请先用 plan 动作提交 characters。')
    const outcome = await runGeneration(runtime, {
      prompt: sheetPrompt(project),
      channelId: project.channelId,
      model: project.model,
      outputDir: join(dir, 'images'),
      fileStem: 'sheet-character',
      confirm: input.confirm === true,
    })
    if (outcome.kind === 'confirm-required') return { ok: false, message: outcome.message, project, artifacts: [], pendingConfirm: outcome.quote.amount }
    if (outcome.kind === 'error') return fail(outcome.message)
    project.spend.images += outcome.images.length
    project.spend.amount = Math.round((project.spend.amount + outcome.quote.amount) * 10000) / 10000
    project.spend.currency = outcome.quote.currency
    comicStore.write(project)
    const paths = outcome.images.map((image) => image.path)
    return {
      ok: true,
      message: '角色三视图已生成：' + paths.join('、') + String.fromCharCode(10) + '后续 render 会把它作为参考图注入（图像锁）。',
      project,
      artifacts: paths,
    }
  }

  // ── render ───────────────────────────────────────────────────────────
  if (action === 'render') {
    if (project.pages.length === 0) return fail('项目还没有分镜：请先 plan。')
    const requested = input.pages !== undefined && input.pages.length > 0
      ? project.pages.filter((page) => input.pages?.includes(page.index) === true)
      : project.pages.filter((page) => page.status !== 'rendered')
    if (requested.length === 0) return { ok: true, message: '没有待渲染的页：' + progressOf(project), project, artifacts: [] }

    const sheetPath = join(dir, SHEET_FILE)
    const useImageLock = project.imageLock && existsSync(sheetPath)
    const inputs: GenerationInput[] = requested.map((page) => {
      const promptFile = join(dir, page.promptFile)
      const prompt = JSON.parse(readFileSync(promptFile, 'utf8')) as unknown
      return {
        prompt,
        channelId: project.channelId,
        model: project.model,
        outputDir: join(dir, 'images'),
        fileStem: String(page.index).padStart(2, '0') + '-page',
        confirm: input.confirm === true,
        referenceImages: useImageLock ? [sheetPath] : undefined,
      }
    })

    const concurrency = input.concurrency ?? runtime.vault.settings().concurrency
    const results = await runBatch(runtime, inputs, concurrency)
    const blocked = results.filter((outcome) => outcome.kind === 'confirm-required')
    if (blocked.length > 0 && input.confirm !== true) {
      const total = results.reduce((sum, outcome) => sum + outcome.quote.amount, 0)
      return {
        ok: false,
        message: '有 ' + String(blocked.length) + ' 页需要先确认成本（合计约 ' + String(Math.round(total * 10000) / 10000) + ' CNY）：确认后带 confirm=true 重调（已出图的页会命中缓存，不会重复付费）。',
        project,
        artifacts: [],
        pendingConfirm: total,
      }
    }

    const artifacts: string[] = []
    results.forEach((outcome: GenerationOutcome, index: number) => {
      const page = requested[index]
      if (page === undefined) return
      if (outcome.kind === 'error') {
        page.status = 'failed'
        page.error = outcome.message.slice(0, 300)
        return
      }
      if (outcome.kind === 'confirm-required') { page.status = 'pending'; return }
      page.status = 'rendered'
      page.error = undefined
      page.durationMs = outcome.durationMs
      const first = outcome.images[0]
      if (first !== undefined) page.imagePath = relativeTo(dir, first.path)
      project.spend.images += outcome.images.length
      project.spend.amount = Math.round((project.spend.amount + outcome.quote.amount) * 10000) / 10000
      for (const image of outcome.images) artifacts.push(image.path)
    })
    const pending = project.pages.filter((page) => page.status === 'pending').length
    project.stage = pending === 0 ? 'rendered' : 'rendering'
    comicStore.write(project)
    const failed = project.pages.filter((page) => page.status === 'failed')
    return {
      ok: failed.length === 0,
      message: [
        progressOf(project) + '（本次处理 ' + String(requested.length) + ' 页，图像锁 ' + (useImageLock ? '开' : '关') + '）',
        failed.length === 0 ? '' : '失败页：' + failed.map((page) => String(page.index) + ' ' + (page.error ?? '')).join('；'),
        failed.length === 0 ? '下一步：img_comic action=assemble 生成联系表。' : '失败页可用同样的 render 重跑（成功页命中缓存）。',
      ].filter((line) => line !== '').join(String.fromCharCode(10)),
      project,
      artifacts,
    }
  }

  // ── status ───────────────────────────────────────────────────────────
  if (action === 'status') {
    const lines = [
      '项目 ' + project.id + '（' + project.topic + '）',
      '阶段：' + project.stage + ' · ' + progressOf(project),
      '方案：' + describePlan(project.plan) + '（' + project.selection.matchedRule + '）',
      '通道/模型：' + project.channelId + ' / ' + (project.model === '' ? '（未指定）' : project.model),
      '角色：' + (project.characters.map((character) => character.name).join('、') || '（未登记）'),
      '累计：' + String(project.spend.images) + ' 张 / ' + String(project.spend.amount) + ' ' + project.spend.currency,
    ]
    for (const page of project.pages) {
      const mark = page.status === 'rendered' ? 'OK ' : page.status === 'failed' ? 'ERR' : '-- '
      lines.push('  [' + mark + '] ' + String(page.index).padStart(2, '0') + ' ' + page.title + (page.imagePath === undefined ? '' : ' -> ' + page.imagePath) + (page.error === undefined ? '' : ' | ' + page.error))
    }
    return { ok: true, message: lines.join(String.fromCharCode(10)), project, artifacts: [dir] }
  }

  // ── assemble ─────────────────────────────────────────────────────────
  if (action === 'assemble') {
    const path = writeContactSheet(dir, project, { imagePrefix: '' })
    project.stage = 'assembled'
    comicStore.write(project)
    return {
      ok: true,
      message: '联系表已生成：' + path + String.fromCharCode(10) + '（' + CONTACT_SHEET_FILE + '，浏览器打开后「打印为 PDF」即可得到 PDF）',
      project,
      artifacts: [path],
    }
  }

  return fail('未知动作 ' + action + '（可用：open / plan / sheet / render / status / assemble）。')
}

/** 不带 id 的列表（status 的通用形态）。 */
export function listProjects(runtime: PluginRuntime, dir?: string): ComicProject[] {
  return store(runtime, dir).list()
}

void imagePathFor
