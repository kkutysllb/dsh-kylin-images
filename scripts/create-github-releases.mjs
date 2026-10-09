#!/usr/bin/env node
/**
 * 把 release/vX.Y.Z.md 同步为 GitHub Release 页面（node scripts/create-github-releases.mjs）。
 *
 * - 扫描 release/ 下所有 vX.Y.Z.md，按 semver 升序处理；
 * - 标题取文件首个一级标题（# 之后的内容），正文即整个 markdown；
 * - 远端已有该 tag 的 Release → gh release edit（幂等可重跑）；
 *   没有 → gh release create --verify-tag（tag 必须已推送）。
 *
 * 前置：gh CLI 已登录（gh auth status）；tag 已 push。
 * 用法：node scripts/create-github-releases.mjs [tag ...]（缺省 = 全部）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const releaseDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'release')

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error('gh ' + args.join(' ') + ' → ' + String(stderr || error.message).trim()))
      else resolve(String(stdout ?? ''))
    })
  })
}

const files = readdirSync(releaseDir)
  .filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name))
  .sort((a, b) => {
    const v = (name) => name.replace(/^v/, '').replace(/\.md$/, '').split('.').map(Number)
    const [a1, a2, a3] = v(a); const [b1, b2, b3] = v(b)
    return a1 - b1 || a2 - b2 || a3 - b3
  })

const only = process.argv.slice(2)
const targets = files.filter((name) => only.length === 0 || only.includes(name.replace(/\.md$/, '')))
if (targets.length === 0) {
  console.error('没有匹配的 release 说明文件。可用：' + files.join(', '))
  process.exit(1)
}

let failures = 0
for (const name of targets) {
  const tag = name.replace(/\.md$/, '')
  const body = readFileSync(join(releaseDir, name), 'utf8')
  const title = (body.match(/^#\s+(.+)$/m) ?? [])[1] ?? tag
  try {
    let exists = true
    try {
      await gh(['release', 'view', tag, '--json', 'name', '--jq', '.name'])
    } catch {
      exists = false
    }
    if (exists) {
      await gh(['release', 'edit', tag, '--title', title, '--notes-file', join(releaseDir, name)])
      console.log('updated  ' + tag + ' — ' + title)
    } else {
      await gh(['release', 'create', tag, '--verify-tag', '--title', title, '--notes-file', join(releaseDir, name)])
      console.log('created  ' + tag + ' — ' + title)
    }
  } catch (error) {
    failures += 1
    console.error('failed   ' + tag + ' — ' + String(error instanceof Error ? error.message : error))
  }
}
process.exit(failures > 0 ? 1 : 0)
