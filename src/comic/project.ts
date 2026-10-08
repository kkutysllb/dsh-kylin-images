/**
 * 知识漫画项目状态机。
 *
 * 目录约定（与设计规格 §9.1 一致，根目录可覆盖）：
 *   <home>/comics/<slug>/
 *     comic.json          状态机（本模块的唯一事实源，重启不丢）
 *     source.md           源内容
 *     analysis.md         会话模型产出的分析
 *     characters.md       角色设定（文字锁来源）
 *     storyboard.md       分镜
 *     prompts/NN-page.json 每页的 ImagePrompt v1
 *     images/NN-page.png  产物
 *     sheet.png           角色三视图（图像锁来源，可选）
 *     contact-sheet.html  组装产物
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VisualPlan } from './select.ts'

export const COMIC_DIR = 'comics'
export const COMIC_STATE_FILE = 'comic.json'

export const COMIC_STAGES = ['open', 'planned', 'rendering', 'rendered', 'assembled'] as const
export type ComicStage = (typeof COMIC_STAGES)[number]

export const PAGE_STATUSES = ['pending', 'rendered', 'failed'] as const
export type PageStatus = (typeof PAGE_STATUSES)[number]

export interface ComicCharacter { name: string; sheet: string }

export interface ComicPage {
  /** 0 = 封面。 */
  index: number
  title: string
  /** 相对项目目录的提示词文件路径。 */
  promptFile: string
  status: PageStatus
  imagePath?: string | undefined
  error?: string | undefined
  durationMs?: number | undefined
}

export interface ComicProject {
  version: 1
  id: string
  topic: string
  createdAt: string
  updatedAt: string
  stage: ComicStage
  plan: VisualPlan
  selection: { priority: number; matchedRule: string; reason: string }
  channelId: string
  model: string
  characters: ComicCharacter[]
  pages: ComicPage[]
  /** 是否用角色三视图做图像锁（需要通道支持参考图）。 */
  imageLock: boolean
  spend: { images: number; amount: number; currency: string }
}

const SLUG_STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'de', 'la', '的', '了', '与', '和'])

/**
 * 由主题生成 2-4 个关键词的 kebab-case slug。
 * 中文按「连续汉字片段」保留（至少 2 字），英文按单词。
 */
export function slugify(topic: string): string {
  const cleaned = topic.trim().toLowerCase()
  const chunks = cleaned.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/gu) ?? []
  const kept: string[] = []
  for (const chunk of chunks) {
    if (SLUG_STOP_WORDS.has(chunk)) continue
    if (/^[a-z0-9]+$/.test(chunk) && chunk.length < 2) continue
    kept.push(chunk.slice(0, 12))
    if (kept.length >= 4) break
  }
  const slug = kept.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug === '' ? 'comic' : slug.slice(0, 48)
}

export function comicRoot(home: string, override?: string): string {
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(home, COMIC_DIR)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pageFileName(index: number, kind: 'prompt' | 'image'): string {
  const padded = String(index).padStart(2, '0')
  return kind === 'prompt' ? 'prompts/' + padded + '-page.json' : 'images/' + padded + '-page.png'
}

export function promptPathFor(index: number): string {
  return pageFileName(index, 'prompt')
}

export function imagePathFor(index: number): string {
  return pageFileName(index, 'image')
}

export class ComicStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  dirOf(id: string): string {
    return join(this.root, id)
  }

  /** 冲突时追加时间戳（沿用 KSkills 技能的约定）。 */
  allocateId(topic: string, now: Date = new Date()): string {
    const base = slugify(topic)
    if (!existsSync(this.dirOf(base))) return base
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    let candidate = base + '-' + stamp
    let counter = 2
    while (existsSync(this.dirOf(candidate))) {
      candidate = base + '-' + stamp + '-' + String(counter)
      counter += 1
    }
    return candidate
  }

  create(topic: string, init: { plan: VisualPlan; selection: ComicProject['selection']; channelId: string; model: string; imageLock: boolean }): ComicProject {
    const id = this.allocateId(topic)
    const dir = this.dirOf(id)
    mkdirSync(join(dir, 'prompts'), { recursive: true, mode: 0o700 })
    mkdirSync(join(dir, 'images'), { recursive: true, mode: 0o700 })
    const now = new Date().toISOString()
    const project: ComicProject = {
      version: 1,
      id,
      topic,
      createdAt: now,
      updatedAt: now,
      stage: 'open',
      plan: init.plan,
      selection: init.selection,
      channelId: init.channelId,
      model: init.model,
      characters: [],
      pages: [],
      imageLock: init.imageLock,
      spend: { images: 0, amount: 0, currency: 'CNY' },
    }
    this.write(project)
    return project
  }

  read(id: string): ComicProject | undefined {
    const path = join(this.dirOf(id), COMIC_STATE_FILE)
    if (!existsSync(path)) return undefined
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!isRecord(raw)) return undefined
      if (typeof raw['id'] !== 'string' || !Array.isArray(raw['pages'])) return undefined
      return raw as unknown as ComicProject
    } catch {
      return undefined
    }
  }

  write(project: ComicProject): void {
    const dir = this.dirOf(project.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    project.updatedAt = new Date().toISOString()
    const target = join(dir, COMIC_STATE_FILE)
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify(project, null, 2) + String.fromCharCode(10), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, target)
  }

  list(): ComicProject[] {
    if (!existsSync(this.root)) return []
    const projects: ComicProject[] = []
    for (const entry of readdirSync(this.root)) {
      const project = this.read(entry)
      if (project !== undefined) projects.push(project)
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}
