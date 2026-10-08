/**
 * HTTP 路由（fenced JSON API）。
 *
 * 安全边界沿用本生态既有结论：Host 回环信任（DNS-rebind 防御）、写操作 POST-only、
 * JSON body、零 shell 拼接、响应一律 {ok,value} / {ok,error}。
 */
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { extname, join as joinPath, normalize, resolve, sep } from 'node:path'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { composePrompt } from '../prompt/compose.ts'
import { loadLibrary, searchLibrary } from '../library/store.ts'
import type { Library } from '../library/store.ts'
import { suggestTemplates } from '../prompt/match.ts'
import { appendSpend, readSpend, summarizeSpend } from '../store/spend.ts'
import { runBatch, runGeneration } from './generate.ts'
import { listProjects, runComicAction } from '../comic/service.ts'
import type { ComicActionInput } from '../comic/service.ts'
import type { PluginRuntime } from './registry.ts'

export const PLUGIN_NAME = 'dsh-kylin-images'
export const API_PREFIX = '/dsh-kylin-images/api'
export const ARTIFACT_PATH = '/dsh-kylin-images/artifact'

export const ARTIFACT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 把请求里的相对路径解析成插件数据目录内的绝对路径。
 *
 * 安全边界：只允许插件自有目录内的文件（realpath 归一后仍须以根目录为前缀），
 * 拒绝绝对路径、`..` 穿越与超出根目录的符号链接目标。
 */
export function resolveArtifact(root: string, relative: string): string | undefined {
  if (typeof relative !== 'string' || relative.trim() === '') return undefined
  const cleaned = relative.replace(/^[/\\]+/, '')
  if (cleaned === '') return undefined
  const rootReal = resolve(root)
  const candidate = resolve(rootReal, normalize(cleaned))
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) return undefined
  return candidate
}
// 插件自有的健康路径：不占用宿主的 /health（避免前缀路由劫持宿主健康检查）。
export const HEALTH_PATH = '/dsh-kylin-images/health'

export interface RouteRequest { method: string; pathname: string; host: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string> | undefined }
export interface RouteResponse { status: number; payload: unknown }

export function isLoopbackHost(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers['host']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return false
  const host = value.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function errorPayload(code: string, message: string): unknown {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let cachedLibrary: Library | undefined

function library(): Library {
  if (cachedLibrary === undefined) cachedLibrary = loadLibrary()
  return cachedLibrary
}

/** 纯函数路由：不碰 req/res，便于单测直接调用。 */
export async function handleRequest(
  runtime: PluginRuntime,
  request: RouteRequest,
  body: unknown,
): Promise<RouteResponse | undefined> {
  const { pathname } = request
  if (!isLoopbackHost(request.headers)) {
    return { status: 403, payload: errorPayload('forbidden', 'only loopback hosts may access this plugin API') }
  }
  const method = request.method.toUpperCase()

  if (method === 'GET' && pathname === HEALTH_PATH) {
    return { status: 200, payload: { ok: true, value: { name: PLUGIN_NAME, home: runtime.home, channels: runtime.vault.list().length } } }
  }

  const isArtifact = pathname.startsWith(ARTIFACT_PATH)
  if (!pathname.startsWith(API_PREFIX) && !isArtifact) return undefined
  const action = isArtifact ? 'artifact' : pathname.slice(API_PREFIX.length).replace(/^\//, '')

  if (method === 'GET' && action === 'state') {
    return {
      status: 200,
      payload: {
        ok: true,
        value: {
          ...runtime.vault.publicData(),
          spend: summarizeSpend(readSpend(runtime.home)),
          cache: runtime.cache.stats(),
        },
      },
    }
  }

  if (method === 'GET' && action === 'artifact') {
    const relative = request.query?.['path'] ?? ''
    const target = resolveArtifact(runtime.home, relative)
    if (target === undefined) return { status: 400, payload: errorPayload('bad-path', 'path 必须是插件数据目录内的相对路径') }
    if (!existsSync(target) || !statSync(target).isFile()) return { status: 404, payload: errorPayload('not-found', '产物不存在') }
    return { status: 200, payload: { __file: target } }
  }

  if (method === 'GET' && action === 'comic.list') {
    const projects = listProjects(runtime)
    return {
      status: 200,
      payload: {
        ok: true,
        value: projects.map((project) => ({
          id: project.id,
          topic: project.topic,
          stage: project.stage,
          plan: project.plan,
          pages: project.pages.length,
          rendered: project.pages.filter((page) => page.status === 'rendered').length,
          failed: project.pages.filter((page) => page.status === 'failed').length,
          spend: project.spend,
          updatedAt: project.updatedAt,
        })),
      },
    }
  }

  if (method === 'GET' && action === 'comic.status') {
    const id = request.query?.['id'] ?? ''
    if (id === '') return { status: 400, payload: errorPayload('missing-id', 'comic.status 需要 ?id=<项目标识>') }
    const outcome = await runComicAction(runtime, { action: 'status', id })
    return { status: outcome.ok ? 200 : 404, payload: outcome.ok
      ? { ok: true, value: outcome.project }
      : errorPayload('not-found', outcome.message) }
  }

  if (method === 'GET' && action === 'cache.stats') {
    return { status: 200, payload: { ok: true, value: runtime.cache.stats() } }
  }

  if (method !== 'POST') {
    return { status: 405, payload: errorPayload('method-not-allowed', 'writes must use POST') }
  }

  const payload = isRecord(body) ? body : {}

  if (action === 'channels.upsert') {
    const result = runtime.vault.upsert(payload['channel'] ?? payload)
    if (!result.ok) return { status: 400, payload: errorPayload('invalid-channel', result.errors.join('; ')) }
    return { status: 200, payload: { ok: true, value: result.channel } }
  }

  if (action === 'channels.remove') {
    const id = String(payload['id'] ?? '')
    if (!runtime.vault.remove(id)) return { status: 404, payload: errorPayload('not-found', '找不到通道 ' + id) }
    return { status: 200, payload: { ok: true, value: { removed: id } } }
  }

  if (action === 'channels.test') {
    const id = String(payload['id'] ?? runtime.vault.settings().defaultChannelId)
    const channel = runtime.vault.find(id)
    if (channel === undefined) return { status: 404, payload: errorPayload('not-found', '找不到通道 ' + id) }
    const provider = runtime.providerFor(channel)
    const health = await provider.health(channel)
    return { status: 200, payload: { ok: true, value: { channelId: channel.id, ...health } } }
  }

  if (action === 'settings.update') {
    const settings = runtime.vault.updateSettings(payload['patch'] ?? payload)
    return { status: 200, payload: { ok: true, value: settings } }
  }

  if (action === 'library.search') {
    const query = isRecord(payload['query']) ? payload['query'] : payload
    const result = searchLibrary(library(), {
      query: typeof query['query'] === 'string' ? query['query'] : undefined,
      category: typeof query['category'] === 'string' ? query['category'] : undefined,
      styles: Array.isArray(query['styles']) ? query['styles'].filter((item): item is string => typeof item === 'string') : undefined,
      scenes: Array.isArray(query['scenes']) ? query['scenes'].filter((item): item is string => typeof item === 'string') : undefined,
      tags: Array.isArray(query['tags']) ? query['tags'].filter((item): item is string => typeof item === 'string') : undefined,
      limit: typeof query['limit'] === 'number' ? query['limit'] : undefined,
      cursor: typeof query['cursor'] === 'number' ? query['cursor'] : undefined,
      include: query['include'] === 'prompt' ? 'prompt' : 'summary',
    }, typeof query['locale'] === 'string' ? query['locale'] : 'zh')
    return { status: 200, payload: { ok: true, value: result } }
  }

  if (action === 'library.suggest') {
    const need = isRecord(payload['need']) ? payload['need'] : payload
    const candidates = suggestTemplates(library(), {
      query: typeof need['query'] === 'string' ? need['query'] : undefined,
      category: typeof need['category'] === 'string' ? need['category'] : undefined,
      styles: Array.isArray(need['styles']) ? need['styles'].filter((item): item is string => typeof item === 'string') : undefined,
      scenes: Array.isArray(need['scenes']) ? need['scenes'].filter((item): item is string => typeof item === 'string') : undefined,
      tags: Array.isArray(need['tags']) ? need['tags'].filter((item): item is string => typeof item === 'string') : undefined,
    }, typeof need['locale'] === 'string' ? need['locale'] : 'zh')
    return { status: 200, payload: { ok: true, value: candidates } }
  }

  if (action === 'compose') {
    const settings = runtime.vault.settings()
    const composed = composePrompt({
      prompt: payload['prompt'],
      templatePitfalls: Array.isArray(payload['templatePitfalls'])
        ? payload['templatePitfalls'].filter((item): item is string => typeof item === 'string')
        : undefined,
      globalNegative: settings.globalNegative,
      sizeStyle: typeof payload['sizeStyle'] === 'string' ? (payload['sizeStyle'] as never) : undefined,
    })
    return { status: 200, payload: { ok: true, value: composed } }
  }

  if (action === 'channels.probe') {
    const id = String(payload['id'] ?? runtime.vault.settings().defaultChannelId)
    const channel = runtime.vault.find(id)
    if (channel === undefined) return { status: 404, payload: errorPayload('not-found', '找不到通道 ' + id) }
    const provider = runtime.providerFor(channel)
    if (provider.probe === undefined) {
      const health = await provider.health(channel)
      return { status: 200, payload: { ok: true, value: { channelId: channel.id, ...health, endpointStyle: channel.kind } } }
    }
    const result = await provider.probe(channel, { realRun: payload['realRun'] === true, outputDir: join(runtime.home, 'probe') })
    return { status: 200, payload: { ok: true, value: { channelId: channel.id, ...result } } }
  }

  if (action === 'generate') {
    const outcome = await runGeneration(runtime, {
      prompt: payload['prompt'],
      channelId: typeof payload['channelId'] === 'string' ? payload['channelId'] : undefined,
      model: typeof payload['model'] === 'string' ? payload['model'] : undefined,
      outputDir: typeof payload['outputDir'] === 'string' ? payload['outputDir'] : undefined,
      count: typeof payload['count'] === 'number' ? payload['count'] : undefined,
      seed: typeof payload['seed'] === 'number' ? payload['seed'] : undefined,
      confirm: payload['confirm'] === true,
      useCache: payload['useCache'] === false ? false : undefined,
    })
    if (outcome.kind === 'error') {
      const code = outcome.message.includes('尚未配置') ? 'no-channel' : 'generation-failed'
      return { status: code === 'no-channel' ? 400 : 502, payload: errorPayload(code, outcome.message) }
    }
    if (outcome.kind === 'confirm-required') {
      return { status: 409, payload: { ok: false, error: { code: 'confirm-required', message: outcome.message }, value: outcome } }
    }
    return { status: 200, payload: { ok: true, value: outcome } }
  }

  if (action === 'batch') {
    const rawItems = Array.isArray(payload['items']) ? payload['items'] : []
    if (rawItems.length === 0) return { status: 400, payload: errorPayload('empty-batch', 'items 不能为空') }
    if (rawItems.length > 40) return { status: 400, payload: errorPayload('batch-too-large', '单次批量最多 40 项，请分批') }
    const items = rawItems.map((raw) => {
      const item = isRecord(raw) ? raw : {}
      return {
        prompt: item['prompt'],
        channelId: typeof item['channelId'] === 'string' ? item['channelId'] : undefined,
        model: typeof item['model'] === 'string' ? item['model'] : undefined,
        outputDir: typeof item['outputDir'] === 'string' ? item['outputDir'] : undefined,
        fileStem: typeof item['fileStem'] === 'string' ? item['fileStem'] : undefined,
        count: typeof item['count'] === 'number' ? item['count'] : undefined,
        seed: typeof item['seed'] === 'number' ? item['seed'] : undefined,
        confirm: payload['confirm'] === true,
      }
    })
    const concurrency = typeof payload['concurrency'] === 'number' ? payload['concurrency'] : runtime.vault.settings().concurrency
    if (payload['confirm'] !== true) {
      const probes = await runBatch(runtime, items.map((item) => ({ ...item, confirm: false, dryRun: true })), 1)
      const blocked = probes.filter((outcome) => outcome.kind === 'confirm-required')
      if (blocked.length > 0) {
        return { status: 409, payload: { ok: false, error: { code: 'confirm-required', message: '整批有 ' + String(blocked.length) + ' 项需要先确认成本' }, value: { outcomes: probes } } }
      }
    }
    const outcomes = await runBatch(runtime, items, concurrency)
    return { status: 200, payload: { ok: true, value: { outcomes } } }
  }

  if (action === 'cache.stats') {
    return { status: 200, payload: { ok: true, value: runtime.cache.stats() } }
  }

  if (action === 'comic.action') {
    const input = (isRecord(payload['input']) ? payload['input'] : payload) as unknown as ComicActionInput
    const outcome = await runComicAction(runtime, input)
    if (!outcome.ok && outcome.message.startsWith('未知动作')) {
      return { status: 400, payload: errorPayload('unknown-action', outcome.message) }
    }
    return { status: 200, payload: { ok: outcome.ok, value: outcome } }
  }

  if (action === 'cache.clear') {
    return { status: 200, payload: { ok: true, value: { cleared: runtime.cache.clear() } } }
  }

  return { status: 404, payload: errorPayload('unknown-action', '未知操作 ' + action) }
}

export interface WebServerLike {
  register(options: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  } catch {
    // 客户端已断开：无处可报
  }
}

export function createHandler(runtime: PluginRuntime) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const pathname = url.pathname
    if (pathname !== HEALTH_PATH && !pathname.startsWith(API_PREFIX) && !pathname.startsWith(ARTIFACT_PATH)) return
    const body = req.method?.toUpperCase() === 'POST' ? await readBody(req) : {}
    if (body === undefined) {
      send(res, 400, errorPayload('invalid-json', '请求体不是合法 JSON'))
      return
    }
    const query: Record<string, string> = {}
    url.searchParams.forEach((value, key) => { query[key] = value })
    const outcome = await handleRequest(runtime, {
      method: req.method ?? 'GET',
      pathname,
      host: String(req.headers.host ?? ''),
      headers: req.headers,
      query,
    }, body)
    if (outcome === undefined) return
    const payload = outcome.payload as { __file?: string } | undefined
    if (typeof payload?.__file === 'string') {
      const type = ARTIFACT_TYPES[extname(payload.__file).toLowerCase()] ?? 'application/octet-stream'
      try {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        createReadStream(payload.__file).pipe(res)
      } catch {
        send(res, 500, errorPayload('read-failed', '产物读取失败'))
      }
      return
    }
    send(res, outcome.status, outcome.payload)
  }
}

export function registerRoutes(webServer: WebServerLike, runtime: PluginRuntime): () => void {
  const handler = createHandler(runtime)
  const disposers = [
    webServer.register({ kind: 'prefix', path: HEALTH_PATH, handler }),
    webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    webServer.register({ kind: 'prefix', path: ARTIFACT_PATH, handler }),
  ]
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载期异常忽略 */ }
    }
  }
}
