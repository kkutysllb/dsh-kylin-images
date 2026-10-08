/**
 * 记账：每次生成的通道/模型/张数/耗时/成本追加到 jsonl。
 *
 * 用途一是成本护栏的可见性（设置页显示累计消耗），二是用户对账。
 * 文件超过上限时按行保留最近若干条，避免无限膨胀（媒体文件不在这里）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SPEND_FILE = 'spend.jsonl'
export const SPEND_MAX_BYTES = 512 * 1024
export const SPEND_KEEP_LINES = 500

export interface SpendRecord {
  at: string
  channelId: string
  model: string
  count: number
  amount: number
  currency: string
  confidence: string
  promptChars: number
  durationMs: number
}

export interface SpendSummary {
  entries: number
  images: number
  total: number
  currency: string
  byChannel: Record<string, number>
}

function pathOf(dir: string): string {
  return join(dir, SPEND_FILE)
}

function rotateIfNeeded(path: string): void {
  let size = 0
  try {
    size = readFileSync(path).byteLength
  } catch {
    return
  }
  if (size <= SPEND_MAX_BYTES) return
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const kept = lines.slice(-SPEND_KEEP_LINES)
  writeFileSync(path, kept.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
}

export function appendSpend(dir: string, record: SpendRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = pathOf(dir)
  if (existsSync(path)) rotateIfNeeded(path)
  appendFileSync(path, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
}

export function readSpend(dir: string, limit = 200): SpendRecord[] {
  let raw = ''
  try {
    raw = readFileSync(pathOf(dir), 'utf8')
  } catch {
    return []
  }
  const records: SpendRecord[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as SpendRecord
      if (typeof parsed === 'object' && parsed !== null) records.push(parsed)
    } catch {
      // 半行/损坏行：跳过，不影响其余记账
    }
  }
  return records.slice(-Math.max(1, limit))
}

export function summarizeSpend(records: readonly SpendRecord[]): SpendSummary {
  const byChannel: Record<string, number> = {}
  let total = 0
  let images = 0
  let currency = 'CNY'
  for (const record of records) {
    total += Number.isFinite(record.amount) ? record.amount : 0
    images += Number.isFinite(record.count) ? record.count : 0
    if (typeof record.currency === 'string' && record.currency !== '') currency = record.currency
    const key = record.channelId === '' ? 'unknown' : record.channelId
    byChannel[key] = (byChannel[key] ?? 0) + (Number.isFinite(record.amount) ? record.amount : 0)
  }
  return { entries: records.length, images, total, currency, byChannel }
}
