/**
 * 运行时容器：把插件需要的服务（vault / provider 注册表 / 记账目录）收在一处，
 * 便于工具面与 HTTP 路由共用，也便于测试直接构造（不依赖宿主）。
 */
import { MockProvider } from '../provider/mock.ts'
import { OpenAiImagesProvider } from '../provider/openai-images.ts'
import { OpenAiResponsesProvider } from '../provider/openai-responses.ts'
import { TaskImagesProvider } from '../provider/task-images.ts'
import { ResultCache } from '../store/cache.ts'
import { effectiveSizeStyle } from '../provider/catalog.ts'
import type { ChannelKind, ChannelRecord, GenerateRequest, ImageProvider } from '../provider/types.ts'
import { resolvePluginHome } from '../store/home.ts'
import { Vault } from '../store/vault.ts'

export interface PluginRuntime {
  home: string
  vault: Vault
  cache: ResultCache
  providers: Map<ChannelKind, ImageProvider>
  providerFor(channel: ChannelRecord): ImageProvider
  /** 通道显式 sizeStyle 优先，其次按通道类型/模型名推断。 */
  sizeStyleFor(channel: ChannelRecord, model?: string): ReturnType<typeof effectiveSizeStyle>
  /** 把请求尺寸按通道 sizeStyle 归一（provider 内部也会做，这里给工具面预检用）。 */
  decoratesRequest(channel: ChannelRecord, request: GenerateRequest): GenerateRequest
}

export function createRuntime(home: string = resolvePluginHome()): PluginRuntime {
  const vault = new Vault(home)
  const providers = new Map<ChannelKind, ImageProvider>()
  providers.set('mock', new MockProvider())
  providers.set('openai-images', new OpenAiImagesProvider())
  providers.set('openai-responses', new OpenAiResponsesProvider())
  providers.set('task-images', new TaskImagesProvider())
  const cache = new ResultCache(home)
  return {
    home,
    vault,
    cache,
    providers,
    providerFor(channel: ChannelRecord): ImageProvider {
      const provider = providers.get(channel.kind)
      if (provider === undefined) {
        throw new Error('通道类型 ' + channel.kind + ' 没有可用适配器（可选：mock / openai-images / openai-responses / task-images）')
      }
      return provider
    },
    sizeStyleFor(channel: ChannelRecord, model?: string) {
      return effectiveSizeStyle(channel.sizeStyle, channel.kind, model ?? channel.models[0])
    },
    decoratesRequest(channel: ChannelRecord, request: GenerateRequest): GenerateRequest {
      return request
    },
  }
}