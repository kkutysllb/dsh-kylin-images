/**
 * dsh-kylin-images 宿主入口（cordis 插件）。
 *
 * 同一份产物被 dsh 与 QiLin 两个通道加载：
 *   - package.json 里 dsh.bundle.patch 与 qilin.bundle.patch 指向同一份 cordis.patch.yml；
 *   - 设置表单一处 schema 两处用：导出 Standard Schema 的 Config（DSH 0.2.x 从活动
 *     fiber 推导 + cordis 的 resolveConfig 校验），并在 settings.installSection 存在时
 *     注册（QiLin 3.x 只认这条）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** 随包分发的 runtime skill 目录（编译后位于 <包根>/skills）。 */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

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
  // 只在 vault 尚未存在（首次激活）时播种。
  // 否则宿主 patch 里的默认值会在每次启动时把用户在「视觉模型」里做的选择覆盖掉
  // ——这是联调时抓到的真实缺陷（默认通道被重置为空）。
  if (runtime.vault.exists()) return
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

export interface SkillMetadata { meta: Record<string, string>; body: string }

/** 极简 frontmatter 解析：只取 name/description 这类单行标量，不引 YAML 解析器。 */
export function parseFrontmatter(raw: string): SkillMetadata {
  const fence = '---'
  if (!raw.startsWith(fence)) return { meta: {}, body: raw }
  const end = raw.indexOf(String.fromCharCode(10) + fence, fence.length)
  if (end < 0) return { meta: {}, body: raw }
  const head = raw.slice(fence.length, end)
  const body = raw.slice(end + fence.length + 1).replace(/^\n+/, '')
  const meta: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const value = match[2]
    if (key !== undefined && value !== undefined) meta[key] = value.trim()
  }
  return { meta, body }
}

/**
 * 注册随包的 runtime skill。
 *
 * 软探测 skills 服务：DSH/QiLin 都提供，但缺位时不应影响宿主侧的工具与路由。
 * 注册形态对齐 dsh-skills-bundle：正文剥离 frontmatter，资源目录随附。
 */
function installSkills(ctx: CordisContext): void {
  const dynamicInject = ctx.inject
  if (typeof dynamicInject !== 'function') return
  if (!existsSync(SKILLS_DIR)) return
  try {
    dynamicInject.call(ctx, ['skills'], (scoped: unknown) => {
      const skills = (scoped as { skills?: { register?: (definition: unknown) => unknown } }).skills
      if (typeof skills?.register !== 'function') return
      for (const entry of readdirSync(SKILLS_DIR)) {
        const dir = join(SKILLS_DIR, entry)
        const file = join(dir, 'SKILL.md')
        if (!existsSync(file)) continue
        const parsed = parseFrontmatter(readFileSync(file, 'utf8'))
        const skillName = parsed.meta['name']
        if (skillName === undefined) continue
        skills.register({
          name: skillName,
          description: parsed.meta['description'] ?? '',
          source: 'runtime',
          content: parsed.body,
          resourceBase: { kind: 'directory', path: dir },
        })
      }
    })
  } catch (error) {
    ctx.logger?.warn('[' + PLUGIN_NAME + '] 技能注册跳过：' + String(error))
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
    installSkills(ctx)
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
