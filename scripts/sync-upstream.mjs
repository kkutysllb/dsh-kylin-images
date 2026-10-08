#!/usr/bin/env node
/**
 * 上游知识数据的同步与对账（awesome-gpt-image-2, MIT）。
 *
 *   node scripts/sync-upstream.mjs          拉取上游 -> 写 data/ -> 重写 lock
 *   node scripts/sync-upstream.mjs --check  只读：比对磁盘数据与 lock（离线可跑）
 *
 * lock 记录上游 commit 与每个文件的内容哈希、字节数、结构计数；CI/prepack
 * 用 --check 断言 vendored 快照没有被静默改动。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data')
const LOCK_PATH = join(DATA_DIR, 'upstream.lock.json')
const REPOSITORY = 'freestylefly/awesome-gpt-image-2'
const REF = 'main'
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + REF + '/'

/** 每个 vendored 文件的来源路径、结构断言与版本字段。 */
const FILES = [
  {
    name: 'style-library.json',
    source: 'data/style-library.json',
    inspect(data) {
      const arrays = ['categories', 'styles', 'scenes', 'templates']
      for (const key of arrays) {
        if (!Array.isArray(data[key])) throw new Error('style-library.json 缺少数组字段 ' + key)
      }
      return {
        templates: data.templates.length,
        categories: data.categories.length,
        styles: data.styles.length,
        scenes: data.scenes.length,
      }
    },
  },
  {
    name: 'cases.json',
    source: 'data/cases.json',
    inspect(data) {
      if (!Array.isArray(data.cases)) throw new Error('cases.json 缺少 cases 数组')
      return { cases: data.cases.length, totalCases: Number(data.totalCases) || 0 }
    },
  },
]

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function describe(text, file) {
  const data = JSON.parse(text)
  return {
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    counts: file.inspect(data),
  }
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-kylin-images-sync' } })
  if (!response.ok) throw new Error('GET ' + url + ' -> HTTP ' + response.status)
  return await response.text()
}

async function resolveCommit() {
  const payload = await fetchText('https://api.github.com/repos/' + REPOSITORY + '/commits/' + REF)
  const sha = JSON.parse(payload)?.sha
  if (typeof sha !== 'string' || sha.length !== 40) throw new Error('无法解析上游 commit sha')
  return sha
}

async function pin() {
  mkdirSync(DATA_DIR, { recursive: true })
  const commit = await resolveCommit()
  const files = {}
  for (const file of FILES) {
    const text = await fetchText(RAW_BASE + file.source)
    writeFileSync(join(DATA_DIR, file.name), text, 'utf8')
    files[file.name] = { source: file.source, ...describe(text, file) }
    console.log('pinned ' + file.name + ' ' + files[file.name].sha256.slice(0, 12))
  }
  const lock = {
    repository: REPOSITORY,
    ref: REF,
    commit,
    license: 'MIT',
    notice: 'THIRD_PARTY_NOTICES.md',
    syncedAt: new Date().toISOString(),
    files,
  }
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf8')
  console.log('lock written: commit ' + commit.slice(0, 12))
}

function check() {
  const lock = readJson(LOCK_PATH)
  const problems = []
  for (const file of FILES) {
    const expected = lock.files?.[file.name]
    if (expected === undefined) {
      problems.push(file.name + ': lock 内没有该文件的记录')
      continue
    }
    let text
    try {
      text = readFileSync(join(DATA_DIR, file.name), 'utf8')
    } catch {
      problems.push(file.name + ': data/ 下缺失该文件')
      continue
    }
    const actual = describe(text, file)
    if (actual.sha256 !== expected.sha256) {
      problems.push(file.name + ': sha256 不匹配（磁盘 ' + actual.sha256.slice(0, 12) + ' vs lock ' + String(expected.sha256).slice(0, 12) + '）')
    }
    if (actual.bytes !== expected.bytes) {
      problems.push(file.name + ': 字节数不匹配（' + actual.bytes + ' vs ' + expected.bytes + '）')
    }
    for (const [key, value] of Object.entries(actual.counts)) {
      if (expected.counts?.[key] !== value) {
        problems.push(file.name + ': 计数 ' + key + ' 不匹配（' + value + ' vs ' + String(expected.counts?.[key]) + '）')
      }
    }
    console.log('checked ' + file.name + ' ' + actual.sha256.slice(0, 12) + ' ' + JSON.stringify(actual.counts))
  }
  if (problems.length > 0) {
    console.error('上游对账失败（' + problems.length + ' 项）：')
    for (const problem of problems) console.error('  - ' + problem)
    console.error('如为有意的上游升级，请运行 npm run sync:upstream 后提交 data/ 与 lock。')
    process.exitCode = 1
    return
  }
  console.log('上游对账通过：commit ' + String(lock.commit).slice(0, 12) + '，syncedAt ' + String(lock.syncedAt))
}

if (process.argv.includes('--check')) check()
else await pin()
