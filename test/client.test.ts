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

test('apply 只注册设置页与插件详情页，不占 workspace 侧边栏', () => {
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
  assert.deepEqual(injected, ['settings.section', 'settings.section', 'plugins.bundle.config'])
  assert.ok(!injected.includes('sidebar.panellist'), '配置菜单属于设置页，不得占用工作区侧边栏')
  // 第一个设置页菜单 = 视觉模型配置（主入口）
  assert.equal(registered[0]?.['name'], 'settings.section')
  const label0 = registered[0]?.['label'] as (() => string) | undefined
  assert.equal(typeof label0, 'function', 'label 应为函数（宿主按语言实时取值）')
  assert.equal(label0?.(), '视觉模型')
  // 第二个设置页菜单 = 图像工坊
  const label1 = registered[1]?.['label'] as (() => string) | undefined
  assert.equal(label1?.(), '图像工坊')
  // 插件详情页配置卡（与设置页共用同一份表单）
  assert.equal(registered[2]?.['name'], 'plugins.bundle.config')
  assert.equal(registered[2]?.['key'], 'dsh-kylin-images')
})

test('图像工坊走插件产物路由，且不直接读盘', () => {
  assert.ok(source.includes('/dsh-kylin-images/artifact'))
  assert.ok(source.includes('comic.list'))
  assert.ok(source.includes('contact-sheet.html'))
})

test('客户端不再注册任何 workspace 侧边栏座席', () => {
  assert.ok(!source.includes('sidebar.panellist'), '不得注册 sidebar.panellist')
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
