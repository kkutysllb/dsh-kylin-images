/**
 * 运行时容器：把插件需要的服务（vault / provider 注册表 / 记账目录）收在一处，
 * 便于工具面与 HTTP 路由共用，也便于测试直接构造（不依赖宿主）。
 */
import { MockProvider } from '../provider/mock.ts'
import type { ChannelKind, ChannelRecord, ImageProvider } from '../provider/types.ts'
import { resolvePluginHome } from '../store/home.ts'
import { Vault } from '../store/vault.ts'

export interface PluginRuntime {
  home: string
  vault: Vault
  providers: Map<ChannelKind, ImageProvider>
  providerFor(channel: ChannelRecord): ImageProvider
}

export function createRuntime(home: string = resolvePluginHome()): PluginRuntime {
  const vault = new Vault(home)
  const providers = new Map<ChannelKind, ImageProvider>()
  providers.set('mock', new MockProvider())
  return {
    home,
    vault,
    providers,
    providerFor(channel: ChannelRecord): ImageProvider {
      const provider = providers.get(channel.kind)
      if (provider === undefined) {
        throw new Error('通道类型 ' + channel.kind + ' 的适配器尚未实现（M2 交付；当前可用 mock）')
      }
      return provider
    },
  }
}
