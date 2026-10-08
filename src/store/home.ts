/**
 * 插件私有数据目录解析。
 *
 * 跟随宿主 home：显式覆盖 > QILIN_HOME > DSH_HOME > ~。
 * 与 dsh-skills-bundle / dsh-video-generator 的既有语义一致（env 空白视同未设）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME_ENV = 'DSH_KYLIN_IMAGES_HOME'
export const PLUGIN_DIR_NAME = '.dsh-kylin-images'

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function resolvePluginHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = readEnv(env, HOME_ENV)
  if (explicit !== undefined) return explicit
  const qilin = readEnv(env, 'QILIN_HOME')
  if (qilin !== undefined) return join(qilin, PLUGIN_DIR_NAME)
  const dsh = readEnv(env, 'DSH_HOME')
  if (dsh !== undefined) return join(dsh, PLUGIN_DIR_NAME)
  return join(homedir(), PLUGIN_DIR_NAME)
}
