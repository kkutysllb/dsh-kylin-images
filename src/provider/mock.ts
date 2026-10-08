/**
 * mock 通道：零 key 的全链路自检通道。
 *
 * 它必须走完与真通道完全相同的代码路径（quote -> generate -> 落盘 -> 记账），
 * 只是把网络调用换成确定性的本地占位图。这样 M1 的验收与 CI 才能零成本跑通，
 * 也让用户在配好通道前就能看到完整交互。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pixelSize } from '../prompt/sizes.ts'
import type { SizeStyle } from '../prompt/sizes.ts'
import { isAspectRatio } from '../prompt/vocab.ts'
import { placeholderPng } from './png.ts'
import type { ChannelRecord, GeneratedImage, GenerateRequest, GenerateResult, ImageProvider, ProbeResult, ProviderHealth } from './types.ts'

const PIXEL_BY_SIZE: Record<string, { width: number; height: number }> = {}

function resolveCanvas(request: GenerateRequest, sizeStyle: SizeStyle): { width: number; height: number } {
  if (sizeStyle === 'pixels' && typeof request.size === 'string') {
    const match = /^(\d+)x(\d+)$/.exec(request.size)
    if (match !== null) {
      const width = Number(match[1])
      const height = Number(match[2])
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height }
    }
  }
  const ratio = typeof request.size === 'string' && isAspectRatio(request.size) ? request.size : '1:1'
  const known = PIXEL_BY_SIZE[ratio]
  if (known !== undefined) return known
  return pixelSize(ratio)
}

export const MOCK_MODEL = 'mock-image-v1'

function hashSeed(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}

export class MockProvider implements ImageProvider {
  readonly kind = 'mock' as const

  async health(channel: ChannelRecord): Promise<ProviderHealth> {
    return {
      ok: true,
      detail: 'mock 通道：本地生成占位图，不发起任何网络请求',
      models: channel.models.length > 0 ? channel.models : [MOCK_MODEL],
      sizeStyle: channel.sizeStyle ?? 'ratio-resolution',
    }
  }

  /** mock 也要实现 probe：否则「测试通道」在不同通道类型下行为不一致。 */
  async probe(channel: ChannelRecord, options: { realRun?: boolean; http?: unknown; outputDir?: string } = {}): Promise<ProbeResult> {
    const models = channel.models.length > 0 ? channel.models : [MOCK_MODEL]
    const result: ProbeResult = {
      ok: true,
      auth: 'ok',
      models,
      endpointStyle: 'sync-images',
      sizeStyle: channel.sizeStyle ?? 'ratio-resolution',
      detail: '本地 mock：不发起网络请求、不需要鉴权，按同步图像协议模拟',
    }
    if (options.realRun === true) {
      const started = Date.now()
      const generated = await this.generate(channel, {
        channelId: channel.id,
        model: models[0] ?? MOCK_MODEL,
        prompt: 'probe: a small grey square on white background',
        count: 1,
        outputDir: options.outputDir ?? join(process.cwd(), '.scratch', 'probe'),
        fileStem: 'probe-' + String(started),
      })
      result.realRun = { tried: true, ok: true, note: '占位图已生成：' + (generated.images[0]?.path ?? '') }
    }
    return result
  }

  async generate(channel: ChannelRecord, request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now()
    const sizeStyle: SizeStyle = channel.sizeStyle ?? 'ratio-resolution'
    const canvas = resolveCanvas(request, sizeStyle)
    const count = Math.max(1, Math.min(4, Math.floor(request.count ?? 1)))
    mkdirSync(request.outputDir, { recursive: true })
    const images: GeneratedImage[] = []
    for (let index = 0; index < count; index += 1) {
      const seed = request.seed === undefined ? hashSeed(request.prompt) + index : request.seed + index
      const buffer = placeholderPng(canvas.width, canvas.height, seed)
      const suffix = count === 1 ? '' : '-' + String(index + 1)
      const path = join(request.outputDir, request.fileStem + suffix + '.png')
      writeFileSync(path, buffer)
      images.push({ path, bytes: buffer.length, width: canvas.width, height: canvas.height })
    }
    return {
      images,
      quote: { amount: 0, currency: 'CNY', confidence: 'exact' },
      channelId: channel.id,
      model: request.model === '' ? MOCK_MODEL : request.model,
      durationMs: Date.now() - started,
    }
  }
}
