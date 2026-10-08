/**
 * 组装：零依赖联系表（HTML，带打印样式，可直接「打印为 PDF」）。
 *
 * 为什么不做二进制 PDF：主流 PDF 里嵌图要把 PNG 解成原始 RGB 再重新 Flate 编码，
 * 需要完整的 PNG 解码器（隔行/调色板/16 位/滤波反演），为一个可选交付物引入这一大块
 * 风险不划算；HTML 联系表在浏览器里「打印为 PDF」得到的结果等价且不会坏。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComicProject } from './project.ts'
import { describePlan } from './plan.ts'

export const CONTACT_SHEET_FILE = 'contact-sheet.html'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

export interface ContactSheetOptions {
  /** 相对项目目录的图片路径前缀（默认空，即与 HTML 同目录）。 */
  imagePrefix?: string | undefined
  /** 生成时间戳（注入便于测试）。 */
  now?: string | undefined
}

/** 渲染联系表 HTML。纯函数。 */
export function renderContactSheet(project: ComicProject, options: ContactSheetOptions = {}): string {
  const prefix = options.imagePrefix ?? ''
  const generatedAt = options.now ?? new Date().toISOString()
  const done = project.pages.filter((page) => page.status === 'rendered').length
  const cards = project.pages.map((page) => {
    // 纯函数不做文件系统探测：是否已出图由状态机（status + imagePath）决定
    const file = page.imagePath
    const image = page.status !== 'rendered' || file === undefined
      ? '<div class="missing">未生成</div>'
      : '<img loading="lazy" src="' + escapeHtml(prefix + file) + '" alt="' + escapeHtml(page.title) + '">'
    return [
      '<figure class="page">',
      image,
      '<figcaption><b>' + String(page.index).padStart(2, '0') + '</b> ' + escapeHtml(page.title) + '</figcaption>',
      '</figure>',
    ].join('')
  }).join(String.fromCharCode(10))

  return [
    '<!doctype html>',
    '<html lang="zh">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + escapeHtml(project.topic) + ' — 知识漫画</title>',
    '<style>',
    ':root{color-scheme:light dark}',
    'body{margin:0;padding:32px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#faf9f7;color:#1b1b1b}',
    'header{max-width:1100px;margin:0 auto 24px}',
    'h1{margin:0 0 6px;font-size:22px}',
    '.meta{opacity:.66;font-size:12px;line-height:1.9}',
    'main{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}',
    'figure.page{margin:0;background:#fff;border:1px solid #e6e2dc;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05)}',
    'figure.page img{display:block;width:100%;height:auto}',
    'figcaption{padding:8px 12px;font-size:12px;border-top:1px solid #efece7}',
    '.missing{padding:60px 12px;text-align:center;opacity:.4;font-size:12px}',
    'footer{max-width:1100px;margin:28px auto 0;opacity:.5;font-size:11px}',
    '@media print{body{background:#fff;padding:0}figure.page{break-inside:avoid;box-shadow:none}main{gap:12px}}',
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    '<h1>' + escapeHtml(project.topic) + '</h1>',
    '<div class="meta">',
    '风格方案：' + escapeHtml(describePlan(project.plan)),
    '（' + escapeHtml(project.selection.matchedRule) + '：' + escapeHtml(project.selection.reason) + '）<br>',
    '通道：' + escapeHtml(project.channelId) + ' · 模型：' + escapeHtml(project.model),
    ' · 角色：' + escapeHtml(project.characters.map((character) => character.name).join('、') || '（未登记）'),
    ' · 图像锁：' + (project.imageLock ? '开' : '关'),
    '<br>页数：' + String(project.pages.length) + ' · 已出图：' + String(done),
    ' · 累计：' + String(project.spend.images) + ' 张 / ' + String(project.spend.amount) + ' ' + escapeHtml(project.spend.currency),
    '</div>',
    '</header>',
    '<main>',
    cards,
    '</main>',
    '<footer>由 dsh-kylin-images 生成于 ' + escapeHtml(generatedAt) + ' · 浏览器「打印为 PDF」即可得到 PDF</footer>',
    '</body>',
    '</html>',
    '',
  ].join(String.fromCharCode(10))
}

export function writeContactSheet(dir: string, project: ComicProject, options: ContactSheetOptions = {}): string {
  const html = renderContactSheet(project, options)
  const path = join(dir, CONTACT_SHEET_FILE)
  writeFileSync(path, html, { encoding: 'utf8', mode: 0o600 })
  return path
}
