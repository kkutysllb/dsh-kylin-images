/**
 * 通道保险库：唯一存放 API Key 的地方。
 *
 * 纪律（对齐 dsh-video-generator 的既有结论）：
 *   - 目录 0700 / 文件 0600，tmp + rename 原子写；
 *   - 所有出口一律 maskCredential，任何路由不得回显明文；
 *   - 入口校验：id 白名单正则、Base URL 强制 https（本地回环例外）、key 长度上限且禁换行。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNEL_KINDS } from '../provider/types.ts'
import type { ChannelKind, ChannelPricing, ChannelRecord, PublicChannel } from '../provider/types.ts'
import { isSizeStyle } from '../prompt/sizes.ts'
import { resolvePluginHome } from './home.ts'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.ts'
import type { PluginSettings } from './settings.ts'

export const VAULT_FILE = 'vault.json'
export const VAULT_VERSION = 1
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const MAX_SECRET_LENGTH = 512

export interface VaultData {
  version: number
  channels: ChannelRecord[]
  settings: PluginSettings
}

export interface PublicVault {
  version: number
  channels: PublicChannel[]
  settings: PluginSettings
}

/** 脱敏：前 3 + •••• + 后 3；短串一律全掩。 */
export function maskCredential(secret: unknown): string {
  const value = typeof secret === 'string' ? secret.trim() : ''
  if (value === '') return ''
  if (value.length <= 8) return '••••'
  return value.slice(0, 3) + '••••' + value.slice(-3)
}

export function toPublicChannel(channel: ChannelRecord): PublicChannel {
  return { ...channel, apiKey: maskCredential(channel.apiKey), hasKey: channel.apiKey !== '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLocalHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

/** 允许 https，以及指向本机回环的 http（本地网关/自建中转的常见形态）。 */
export function isAllowedBaseUrl(value: string): boolean {
  if (value === '') return true
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isLocalHostname(url.hostname)
  return false
}

export interface ChannelUpsertResult {
  ok: boolean
  errors: string[]
  channel?: PublicChannel
}

export class Vault {
  readonly dir: string
  readonly path: string
  data: VaultData

  constructor(dir: string = resolvePluginHome()) {
    this.dir = dir
    this.path = join(dir, VAULT_FILE)
    this.data = this.read()
  }

  private read(): VaultData {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (!isRecord(raw)) return { version: VAULT_VERSION, channels: [], settings: { ...DEFAULT_SETTINGS, globalNegative: [] } }
      const channels: ChannelRecord[] = []
      for (const item of Array.isArray(raw['channels']) ? raw['channels'] : []) {
        if (!isRecord(item)) continue
        const id = typeof item['id'] === 'string' ? item['id'] : ''
        if (!CHANNEL_ID_PATTERN.test(id)) continue
        channels.push({
          id,
          label: typeof item['label'] === 'string' && item['label'].trim() !== '' ? item['label'].trim() : id,
          kind: (CHANNEL_KINDS as readonly string[]).includes(String(item['kind'])) ? (item['kind'] as ChannelKind) : 'mock',
          baseUrl: typeof item['baseUrl'] === 'string' ? item['baseUrl'] : '',
          apiKey: typeof item['apiKey'] === 'string' ? item['apiKey'] : '',
          models: Array.isArray(item['models']) ? item['models'].filter((model): model is string => typeof model === 'string') : [],
          ...(typeof item['endpointPath'] === 'string' ? { endpointPath: item['endpointPath'] } : {}),
          ...(typeof item['statusPath'] === 'string' ? { statusPath: item['statusPath'] } : {}),
          ...(isRecord(item['pricing']) ? { pricing: item['pricing'] as ChannelPricing } : {}),
          ...(Number.isFinite(Number(item['timeoutMs'])) ? { timeoutMs: Number(item['timeoutMs']) } : {}),
          ...(Number.isFinite(Number(item['retries'])) ? { retries: Number(item['retries']) } : {}),
          ...(isSizeStyle(item['sizeStyle']) ? { sizeStyle: item['sizeStyle'] } : {}),
          enabled: item['enabled'] !== false,
          createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : new Date(0).toISOString(),
          updatedAt: typeof item['updatedAt'] === 'string' ? item['updatedAt'] : new Date(0).toISOString(),
        })
      }
      return { version: VAULT_VERSION, channels, settings: normalizeSettings(raw['settings']) }
    } catch {
      return { version: VAULT_VERSION, channels: [], settings: { ...DEFAULT_SETTINGS, globalNegative: [] } }
    }
  }

  /** 原子落盘：tmp + rename；目录 0700、文件 0600。 */
  save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try { chmodSync(this.dir, 0o700) } catch { /* 平台不支持时忽略 */ }
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* 同上 */ }
  }

  list(): ChannelRecord[] {
    return this.data.channels.map((channel) => ({ ...channel }))
  }

  publicList(): PublicChannel[] {
    return this.data.channels.map(toPublicChannel)
  }

  publicData(): PublicVault {
    return { version: this.data.version, channels: this.publicList(), settings: this.settings() }
  }

  find(id: string): ChannelRecord | undefined {
    const found = this.data.channels.find((channel) => channel.id === id)
    return found === undefined ? undefined : { ...found }
  }

  settings(): PluginSettings {
    return { ...this.data.settings, globalNegative: [...this.data.settings.globalNegative] }
  }

  updateSettings(patch: unknown): PluginSettings {
    const merged = normalizeSettings({ ...this.data.settings, ...(isRecord(patch) ? patch : {}) })
    this.data.settings = merged
    this.save()
    return this.settings()
  }

  upsert(input: unknown): ChannelUpsertResult {
    const errors: string[] = []
    if (!isRecord(input)) return { ok: false, errors: ['通道配置必须是对象'] }

    const rawId = typeof input['id'] === 'string' ? input['id'].trim().toLowerCase() : ''
    const id = rawId === '' ? this.slugFrom(String(input['label'] ?? input['kind'] ?? 'channel')) : rawId
    if (!CHANNEL_ID_PATTERN.test(id)) errors.push('通道 id 必须是 1-32 位小写字母/数字/连字符，且以字母或数字开头')

    const label = typeof input['label'] === 'string' ? input['label'].trim() : ''
    if (label === '') errors.push('label 必填')
    else if (label.length > 64) errors.push('label 最长 64 字符')

    const kind = String(input['kind'] ?? '')
    if (!(CHANNEL_KINDS as readonly string[]).includes(kind)) {
      errors.push('kind 必须是 ' + CHANNEL_KINDS.join(' | '))
    }

    const baseUrl = typeof input['baseUrl'] === 'string' ? input['baseUrl'].trim() : ''
    if (!isAllowedBaseUrl(baseUrl)) errors.push('Base URL 只允许 https（本机回环可用 http）')

    const apiKey = typeof input['apiKey'] === 'string' ? input['apiKey'] : ''
    if (apiKey.length > MAX_SECRET_LENGTH) errors.push('API Key 超过 ' + String(MAX_SECRET_LENGTH) + ' 字符上限')
    if (/[\r\n]/.test(apiKey)) errors.push('API Key 不能包含换行')

    const models: string[] = []
    const rawModels = input['models']
    if (rawModels !== undefined) {
      if (!Array.isArray(rawModels)) errors.push('models 必须是字符串数组')
      else {
        for (const model of rawModels) {
          if (typeof model !== 'string') { errors.push('models 含非字符串项'); break }
          const trimmed = model.trim()
          if (trimmed === '') continue
          if (trimmed.length > 128) { errors.push('模型名最长 128 字符'); break }
          if (!models.includes(trimmed)) models.push(trimmed)
        }
        if (models.length > 64) errors.push('models 最多 64 项')
      }
    }

    const endpointPath = input['endpointPath']
    if (endpointPath !== undefined && endpointPath !== '') {
      if (typeof endpointPath !== 'string' || !endpointPath.startsWith('/')) errors.push('endpointPath 必须以 / 开头')
    }

    const sizeStyle = input['sizeStyle']
    if (sizeStyle !== undefined && sizeStyle !== '' && !isSizeStyle(sizeStyle)) {
      errors.push('sizeStyle 必须是 pixels | ratio-resolution | ignore')
    }

    const statusPath = input['statusPath']
    if (statusPath !== undefined && statusPath !== '') {
      if (typeof statusPath !== 'string' || !statusPath.startsWith('/')) errors.push('statusPath 必须以 / 开头')
    }

    const pricing = input['pricing']
    let normalizedPricing: ChannelPricing | undefined
    if (pricing !== undefined && pricing !== null) {
      if (!isRecord(pricing)) errors.push('pricing 必须是对象')
      else {
        normalizedPricing = {}
        const currency = pricing['currency']
        if (currency !== undefined) {
          if (typeof currency !== 'string' || currency.length > 8) errors.push('pricing.currency 必须是短字符串')
          else normalizedPricing.currency = currency
        }
        const priceKeys = ['1k', '2k', '4k', 'default'] as const
        for (const key of priceKeys) {
          const raw = pricing[key]
          if (raw === undefined || raw === null || raw === '') continue
          const parsed = Number(raw)
          if (!Number.isFinite(parsed) || parsed < 0) errors.push('pricing.' + key + ' 必须是非负数字')
          else normalizedPricing[key] = parsed
        }
      }
    }

    const timeoutMs = input['timeoutMs']
    if (timeoutMs !== undefined && timeoutMs !== '' && timeoutMs !== null) {
      const parsed = Number(timeoutMs)
      if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 600000) errors.push('timeoutMs 必须在 1000..600000 之间')
    }

    const retries = input['retries']
    if (retries !== undefined && retries !== '' && retries !== null) {
      const parsed = Number(retries)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) errors.push('retries 必须在 0..10 之间')
    }

    if (errors.length > 0) return { ok: false, errors }

    const now = new Date().toISOString()
    const existing = this.data.channels.find((channel) => channel.id === id)
    const record: ChannelRecord = {
      id,
      label,
      kind: kind as ChannelKind,
      baseUrl,
      apiKey,
      models,
      enabled: input['enabled'] !== false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (typeof endpointPath === 'string' && endpointPath !== '') record.endpointPath = endpointPath
    if (isSizeStyle(sizeStyle)) record.sizeStyle = sizeStyle
    if (typeof statusPath === 'string' && statusPath !== '') record.statusPath = statusPath
    if (normalizedPricing !== undefined) record.pricing = normalizedPricing
    if (timeoutMs !== undefined && timeoutMs !== '' && timeoutMs !== null) record.timeoutMs = Number(timeoutMs)
    if (retries !== undefined && retries !== '' && retries !== null) record.retries = Number(retries)

    if (existing === undefined) this.data.channels.push(record)
    else this.data.channels[this.data.channels.indexOf(existing)] = record
    if (this.data.settings.defaultChannelId === '') this.data.settings.defaultChannelId = id
    this.save()
    return { ok: true, errors: [], channel: toPublicChannel(record) }
  }

  remove(id: string): boolean {
    const index = this.data.channels.findIndex((channel) => channel.id === id)
    if (index < 0) return false
    this.data.channels.splice(index, 1)
    if (this.data.settings.defaultChannelId === id) {
      this.data.settings.defaultChannelId = this.data.channels[0]?.id ?? ''
    }
    this.save()
    return true
  }

  /** 由 label 生成合法 id（冲突时追加序号）。 */
  slugFrom(label: string): string {
    const base = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
    const safe = base === '' ? 'channel' : base
    let candidate = safe
    let counter = 2
    while (this.data.channels.some((channel) => channel.id === candidate)) {
      candidate = (safe.slice(0, 26) + '-' + String(counter)).slice(0, 32)
      counter += 1
    }
    return candidate
  }
}

/** 测试与清理用：删除 vault 文件。 */
export function removeVault(dir: string): void {
  const path = join(dir, VAULT_FILE)
  if (existsSync(path)) unlinkSync(path)
}
