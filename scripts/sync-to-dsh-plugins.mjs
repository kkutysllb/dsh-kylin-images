#!/usr/bin/env node
/**
 * dsh-kylin-images → dsh-plugins 真源镜像同步。
 *
 * 方向：本仓（开发真源）→ ../dsh-plugins/dsh-kylin-images/（分发镜像）。
 * 镜像内容 = package.json files 白名单 + package.json + LICENSE（可安装包形态）；
 * 不镜像 src/tsconfig/tests/node_modules/.git 等。
 *
 * 用法：
 *   node scripts/sync-to-dsh-plugins.mjs          # 执行镜像（rm+cp 重建）
 *   node scripts/sync-to-dsh-plugins.mjs --check  # 对账：零差异 exit 0；有差异列详情 exit 1
 *
 * 环境变量：KCODER_PLUGINS_DIR 可覆盖 dsh-plugins 仓位置（缺省 ../dsh-plugins）。
 *
 * 发版约定：本仓改动推送前先跑本脚本同步镜像并在 dsh-plugins 仓提交推送，
 * 保证两个安装入口（独立仓 / dsh-plugins 子目录）内容一致。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DEFAULT_PLUGINS_DIR = resolve(REPO_ROOT, '..', 'dsh-plugins')
const PLUGINS_DIR = process.env.KCODER_PLUGINS_DIR
  ? resolve(process.env.KCODER_PLUGINS_DIR)
  : DEFAULT_PLUGINS_DIR
const MIRROR = join(PLUGINS_DIR, 'dsh-kylin-images')

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
// `files` 白名单 + LICENSE，另**必须**显式带上 package.json：npm 打包时自动
// 包含 manifest 所以 files 里从不写它，但镜像目录是按路径安装的——没有
// manifest 时 pnpm 会以 0.0.0 装进一个没有 dsh.bundle.patch / exports 的
// 空壳目录，插件根本加载不起来。--check 会把它当差异拦住。
const COPY_ENTRIES = [...new Set([
  'package.json',
  ...manifest.files.filter((entry) => entry !== 'README.md'),
  'LICENSE',
])]
const checkMode = process.argv.includes('--check')

if (!existsSync(PLUGINS_DIR)) {
  console.error('dsh-plugins 仓不存在: ' + PLUGINS_DIR)
  process.exit(1)
}

/** Flatten one files entry (plain file or directory) into real file paths. */
function flatten(entry) {
  const abs = join(REPO_ROOT, entry)
  if (!existsSync(abs)) throw new Error('missing files entry: ' + entry)
  if (statSync(abs).isFile()) return [entry]
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const rel = relative(REPO_ROOT, join(dir, name))
      if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name))
      else out.push(rel)
    }
  }
  walk(abs)
  return out
}

const wanted = COPY_ENTRIES.flatMap(flatten).sort()

if (checkMode) {
  const diffs = []
  for (const rel of wanted) {
    const source = readFileSync(join(REPO_ROOT, rel))
    const mirrorPath = join(MIRROR, rel)
    if (!existsSync(mirrorPath)) { diffs.push('missing in mirror: ' + rel); continue }
    if (!source.equals(readFileSync(mirrorPath))) diffs.push('content differs: ' + rel)
  }
  const walkMirror = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name)
      if (name.isDirectory()) { walkMirror(abs); continue }
      const rel = relative(MIRROR, abs)
      if (rel.startsWith('.git')) continue
      if (!wanted.includes(rel)) diffs.push('extra in mirror: ' + rel)
    }
  }
  if (existsSync(MIRROR)) walkMirror(MIRROR)
  if (diffs.length === 0) {
    console.log('sync:check 对账通过：镜像与真源零差异（' + wanted.length + ' files）')
    process.exit(0)
  }
  console.error('sync:check 发现 ' + diffs.length + ' 处差异：')
  for (const line of diffs) console.error('  ' + line)
  process.exit(1)
}

rmSync(MIRROR, { recursive: true, force: true })
mkdirSync(MIRROR, { recursive: true })
for (const rel of wanted) {
  const target = join(MIRROR, rel)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(REPO_ROOT, rel), target)
}
console.log('已镜像 ' + wanted.length + ' 个文件 → ' + relative(REPO_ROOT, MIRROR))
console.log('下一步：在 dsh-plugins 仓提交并推送（保证双安装入口一致）')
