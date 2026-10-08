import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(ROOT, 'client.js'), 'utf8')

/** 在最小浏览器沙箱里加载 client.js，返回它自注册的模块。 */
function loadClient() {
  let captured: unknown
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options: { id: string; factory: (require: (name: string) => unknown) => unknown }) {
          const react = {
            createElement: () => null,
            useState: (initial: unknown) => [initial, () => undefined],
            useEffect: () => undefined,
            useCallback: (fn: unknown) => fn,
          }
          captured = options.factory((name: string) => (name === 'react' ? react : {}))
        },
      },
    },
    navigator: { language: 'zh-CN' },
    document: {
      getElementById: () => null,
      createElement: () => ({ textContent: '', parentNode: null }),
      head: { appendChild: () => undefined },
    },
    console,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: {} }) }),
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  return captured as { apply: (ctx: unknown) => void; inject: string[] }
}

test('client.js 自注册且暴露 apply/inject（裸 ESM 会被宿主拒绝）', () => {
  const mod = loadClient()
  assert.equal(typeof mod.apply, 'function')
  // 跨 VM realm 的数组原型不同，先归一化再比较
  assert.deepEqual(Array.from(mod.inject), ['slots'])
  assert.ok(!source.includes('export function apply'), '不允许裸 ESM 导出')
  assert.ok(source.includes('__ModuleLoader__.load'), '必须经 ModuleLoader 自注册')
})

test('apply 在两个设置座席都注册「视觉模型」卡片', () => {
  const mod = loadClient()
  const injected: string[] = []
  const registered: Array<Record<string, unknown>> = []
  const ctx = {
    effect: (register: () => unknown) => register(),
    slots: {
      inject: (seat: string, register: () => unknown) => { injected.push(seat); return register() },
      register: (options: Record<string, unknown>) => { registered.push(options); return () => undefined },
    },
  }
  mod.apply(ctx)
  assert.deepEqual(injected, ['plugins.bundle.config', 'settings.section'])
  assert.equal(registered[0]?.['name'], 'plugins.bundle.config')
  assert.equal(registered[0]?.['key'], 'dsh-kylin-images')
  assert.equal(registered[1]?.['name'], 'settings.section')
  assert.equal(registered[1]?.['label'], '视觉模型')
})

test('宿主缺插槽时不抛异常（软探测）', () => {
  const mod = loadClient()
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply({ slots: {} }))
  const throwing = {
    effect: (fn: () => unknown) => fn(),
    slots: { inject: () => { throw new Error('no such seat') } },
  }
  assert.doesNotThrow(() => mod.apply(throwing))
})

test('卡片走插件自家 fenced API，凭据输入为 password 且源码无密钥字面量', () => {
  assert.ok(source.includes('/dsh-kylin-images/api'))
  assert.ok(!/sk-[a-zA-Z0-9]{8,}/.test(source), 'client.js 不应出现任何形似密钥的字面量')
  assert.ok(source.includes('password'), 'API Key 输入应为 password 类型')
})
