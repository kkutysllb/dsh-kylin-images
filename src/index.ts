/**
 * dsh-kylin-images 宿主入口（cordis 插件）。
 *
 * 同一份产物被 dsh 与 QiLin 两个通道加载：
 *   - package.json 里 dsh.bundle.patch 与 qilin.bundle.patch 指向同一份 cordis.patch.yml；
 *   - 设置表单一处 schema 两处用：导出 Standard Schema 的 Config（DSH 0.2.x 从活动
 *     fiber 推导 + cordis 的 resolveConfig 校验），并在 settings.installSection 存在时
 *     注册（QiLin 3.x 只认这条）。
 */
import { createRuntime } from './host/registry.ts'
import { API_PREFIX, HEALTH_PATH, PLUGIN_NAME, registerRoutes } from './host/routes.ts'
import type { WebServerLike } from './host/routes.ts'
import { CONFIG_FIELD_NAMES, CONFIG_FIELDS, Config, pickConfigFields, resolvePluginConfig } from './host/config-schema.ts'
import { createTools } from './tools/index.ts'
import type { PluginRuntime } from './host/registry.ts'

export const name = PLUGIN_NAME
export const inject = ['tools', 'webServer'] as const

export const VERSION = '0.1.0'

/** 设置命名空间：与宿主的 plugins.bundle.config 座席 key 一致。 */
export const SETTINGS_NAMESPACE = PLUGIN_NAME

export { Config }
export { CONFIG_FIELD_NAMES as CONFIG_FIELDS }
export const CONFIG_FIELD_SPECS = CONFIG_FIELDS

interface ToolRegistry {
  register(definition: unknown): unknown
}

export interface CordisContext {
  tools?: ToolRegistry | undefined
  webServer?: WebServerLike | undefined
  logger?: { warn(message: string): void; info?(message: string): void } | undefined
  effect?(register: () => unknown, label?: string): unknown
  inject?(dependencies: string[], callback: (scoped: unknown) => void): void
}

/**
 * 首次激活时用宿主配置播种设置。
 *
 * 宿主 patch 的 config 是「基础层」，插件自己的 vault 是「用户层」：vault 一旦存在
 * （用户动过「视觉模型」菜单）就以 vault 为准，patch 里的默认值不再覆盖，避免把用户
 * 的选择悄悄改回去。播种结果会落盘，因此只在首次写入。
 */
function seedSettingsFromHost(runtime: PluginRuntime, config: unknown): void {
  const picked = pickConfigFields(config)
  if (Object.keys(picked).length === 0) return
  const resolved = resolvePluginConfig(config)
  runtime.vault.updateSettings({ ...resolved, ...picked })
}

/**
 * 挂载宿主设置命名空间。
 *
 * DSH 0.2.x 的设置服务从活动 fiber 自带的 Config 导出推导表单，无需注册；
 * QiLin 3.0.x 的设置服务只服务 settings.installSection 注册过的命名空间。
 * 因此这里软探测该 seam：不存在就静默跳过（DSH 路径不受影响）。
 */
function installSettingsSection(ctx: CordisContext, runtime: PluginRuntime): void {
  const dynamicInject = ctx.inject
  if (typeof dynamicInject !== 'function') return
  try {
    dynamicInject.call(ctx, ['settings'], (scoped: unknown) => {
      const settings = (scoped as {
        settings?: {
          installSection?: (
            owner: unknown,
            namespace: string,
            schema: unknown,
            entry: unknown,
            hooks: { setSource(current: () => unknown): void; onChange(): void },
          ) => void
        }
      }).settings
      if (settings?.installSection === undefined) return
      let source: (() => unknown) | undefined
      const adopt = (): void => {
        if (source === undefined) return
        let resolved: unknown
        try {
          resolved = source()
        } catch {
          return
        }
        if (typeof resolved !== 'object' || resolved === null) return
        runtime.vault.updateSettings(resolved)
      }
      settings.installSection(ctx, SETTINGS_NAMESPACE, Config, runtime.vault.settings(), {
        setSource: (current) => { source = current; adopt() },
        onChange: adopt,
      })
    })
  } catch (error) {
    ctx.logger?.warn('[' + PLUGIN_NAME + '] 设置命名空间注册跳过：' + String(error))
  }
}

export function apply(ctx: CordisContext, rawConfig?: unknown): void {
  const runtime = createRuntime()
  seedSettingsFromHost(runtime, rawConfig)

  const mount = (): (() => void) => {
    const disposers: Array<() => void> = []
    if (ctx.webServer?.register !== undefined) {
      disposers.push(registerRoutes(ctx.webServer, runtime))
    }
    for (const definition of createTools(runtime)) {
      const dispose = ctx.tools?.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
    installSettingsSection(ctx, runtime)
    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* 卸载期异常忽略 */ }
      }
    }
  }

  if (typeof ctx.effect === 'function') ctx.effect(mount, PLUGIN_NAME + ': mount')
  else mount()

  ctx.logger?.info?.(
    '[' + PLUGIN_NAME + '] 已激活：health ' + HEALTH_PATH + '，api ' + API_PREFIX + '，home ' + runtime.home,
  )
}
