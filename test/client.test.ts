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
  assert.deepEqual(Array.from(mod.inject), ['slots', 'locale'])
  assert.ok(!source.includes('export function apply'), '不允许裸 ESM 导出')
  assert.ok(source.includes('__ModuleLoader__.load'), '必须经 ModuleLoader 自注册')
})

test('一个插件只注册一个设置页菜单：配置与工坊合并为同一入口', () => {
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
  // 回归：曾经注册两个 settings.section，真机新引擎的设置页导航里并排出现
  // 两个图标（「视觉模型」「图像工坊」）。一个插件只能有一个设置项。
  assert.deepEqual(injected, ['settings.section', 'plugins.bundle.config'])
  assert.equal(injected.filter((seat) => seat === 'settings.section').length, 1, 'settings.section 只能注册一次')
  assert.ok(!injected.includes('sidebar.panellist'), '配置菜单属于设置页，不得占用工作区侧边栏')
  // 唯一的设置页菜单 = 「图像工坊」（内含「视觉模型」「漫画项目」两个页签）
  assert.equal(registered[0]?.['name'], 'settings.section')
  const label0 = registered[0]?.['label'] as (() => string) | undefined
  assert.equal(typeof label0, 'function', 'label 应为函数（宿主按语言实时取值）')
  assert.equal(label0?.(), '图像工坊')
  assert.ok(!source.includes('kylin-images-workbench'), '旧的第二个菜单 id 应已移除')
  // 插件详情页配置卡（与设置页共用同一份表单）
  assert.equal(registered[1]?.['name'], 'plugins.bundle.config')
  assert.equal(registered[1]?.['key'], 'dsh-kylin-images')
})

test('双语接入宿主 locale 服务：注册摊平字典并把 t 切到绑定译函', () => {
  const mod = loadClient()
  const calls: Array<{ ns: string; dicts: Record<string, Record<string, unknown>> }> = []
  let boundNs = ''
  const locale = {
    register(ns: string, dicts: Record<string, Record<string, unknown>>) {
      calls.push({ ns, dicts })
      return () => undefined
    },
    bind(ns: string) {
      boundNs = ns
      // 模拟 LocaleRuntime.bind：调用时读当前语言，未命中原样回 key
      return (key: string) => {
        const dicts = calls.find((c) => c.ns === ns)?.dicts ?? {}
        const hit = dicts.zh?.[key] ?? dicts.en?.[key]
        return hit === undefined ? key : hit
      }
    },
  }
  const injected: string[] = []
  const registered: Array<Record<string, unknown>> = []
  const ctx = {
    effect: (register: () => unknown) => register(),
    locale,
    slots: {
      inject: (seat: string, register: () => unknown) => { injected.push(seat); return register() },
      register: (options: Record<string, unknown>) => { registered.push(options); return () => undefined },
    },
  }
  mod.apply(ctx)
  // 字典注册：一个命名空间、zh/en 双语、全扁平（嵌套 kindHint 摊平成点键）
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.ns, 'kylinImages')
  const zh = calls[0]?.dicts.zh ?? {}
  assert.equal(typeof zh['intro'], 'string', '普通键原样保留')
  assert.equal(typeof zh['kindHint.mock'], 'string', '嵌套 kindHint 应摊平为 kindHint.<kind> 点键')
  assert.equal(zh['kindHint.mock'], '本地模拟：零密钥跑通全链路')
  for (const value of Object.values(zh)) assert.equal(typeof value, 'string', 'locale 字典不允许嵌套对象')
  // 合并后的页签文案也必须进字典（否则英文界面会显示裸 key）
  assert.equal(zh['tabVision'], '视觉模型')
  assert.equal(zh['tabProjects'], '漫画项目')
  assert.equal(calls[0]?.dicts.en?.['nav'], 'Image studio')
  // t 已切换为绑定译函：label thunk 走 ctx.locale.bind('kylinImages') 的返回值
  assert.equal(boundNs, 'kylinImages')
  const label0 = registered[0]?.['label'] as (() => string) | undefined
  assert.equal(label0?.(), '图像工坊')
})

test('老引擎无 locale 面时保持 navigator 兜底（缺 ctx.locale 不炸）', () => {
  const mod = loadClient()
  const registered: Array<Record<string, unknown>> = []
  const ctx = {
    effect: (register: () => unknown) => register(),
    slots: {
      inject: (_seat: string, register: () => unknown) => register(),
      register: (options: Record<string, unknown>) => { registered.push(options); return () => undefined },
    },
  }
  mod.apply(ctx)
  const label0 = registered[0]?.['label'] as (() => string) | undefined
  assert.equal(label0?.(), '图像工坊', '沙箱 navigator.language=zh-CN，兜底译函应命中中文')
})

test('图像工坊走插件产物路由，且不直接读盘', () => {
  assert.ok(source.includes('/dsh-kylin-images/artifact'))
  assert.ok(source.includes('comic.list'))
  assert.ok(source.includes('contact-sheet.html'))
})

test('客户端不再注册任何 workspace 侧边栏座席', () => {
  assert.ok(!source.includes('sidebar.panellist'), '不得注册 sidebar.panellist')
})

test('设置页导航字形：唯一菜单一个字形，且壳层字形全域隐藏（不会叠成两个图标）', () => {
  assert.ok(source.includes('data-kimg-nav-images'))
  const icon = /NAV_IMAGES_SVG = "([^"]+)"/.exec(source)?.[1] ?? ''
  assert.ok(icon.startsWith('data:image/svg+xml,'), '图像工坊字形应为内联 SVG')
  assert.ok(!icon.includes('circle cx="12" cy="12" r="3"'), '不应退回通用相机/齿轮')
  // 合并后不得再留第二个/第三个导航字形标记
  assert.ok(!/data-kimg-nav-(vision|comic)/.test(source), '合并后只保留一个导航字形标记')
  // 隐藏壳层字形：不同引擎代次可能用 > svg、span 包一层、或 img，
  // 因此按「标记行内所有 svg/img」隐藏——否则壳层字形与自定义字形同时出现。
  assert.ok(source.includes("] svg,'"), '应隐藏标记行内的 svg')
  assert.ok(source.includes('] img{display:none;}'), '壳层字形可能是 img，也要隐藏')
  assert.ok(source.includes('mask:url('), '自定义字形走 currentColor mask')
})

test('导航行标记逻辑：按本地化文案命中，语言切换后重新标记', () => {
  const buttons = [
    { textContent: '通用设置', attrs: {} },
    { textContent: '图像工坊', attrs: {} },
    { textContent: '多媒体网关', attrs: {} },
  ].map((item) => ({
    textContent: item.textContent,
    attrs: item.attrs as Record<string, string>,
    setAttribute(name: string) { (this.attrs as Record<string, string>)[name] = '' },
    removeAttribute(name: string) { delete (this.attrs as Record<string, string>)[name] },
  }))
  let observerCallback: (() => void) | undefined
  class FakeObserver {
    constructor(callback: () => void) { observerCallback = callback }
    observe() { /* no-op */ }
    disconnect() { observerCallback = undefined }
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options: { factory: (require: (name: string) => unknown) => unknown }) {
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
      body: {},
      querySelectorAll(selector: string) {
        if (selector.indexOf('nav button') >= 0) return buttons
        const match = /^\[([^\]]+)\]$/.exec(selector)
        if (match === null) return []
        return buttons.filter((button) => (button.attrs as Record<string, string>)[match[1] as string] !== undefined)
      },
    },
    MutationObserver: FakeObserver,
    console,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: {} }) }),
  }
  let captured: unknown
  const source2 = readFileSync(join(ROOT, 'client.js'), 'utf8')
  vm.runInNewContext(source2, sandbox, { filename: 'client.js' })
  const mod = captured as { apply: (ctx: unknown) => void }
  const disposers: Array<() => void> = []
  mod.apply({
    effect: (register: () => unknown) => { const dispose = register(); if (typeof dispose === 'function') disposers.push(dispose as () => void); return dispose },
  })
  assert.ok(buttons[1]?.attrs['data-kimg-nav-images'] !== undefined, '「图像工坊」行应被标记')
  assert.equal(buttons[0]?.attrs['data-kimg-nav-images'], undefined, '别人的行不得被标记')
  assert.equal(buttons[2]?.attrs['data-kimg-nav-images'], undefined, '别人的行不得被标记')
  assert.equal(typeof observerCallback, 'function', '应挂 MutationObserver 跟随语言/重开')
  for (const dispose of disposers) dispose()
  assert.equal(buttons[1]?.attrs['data-kimg-nav-images'], undefined, 'disposer 应清除标记')
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

test('通道类型选择器覆盖服务端全部 CHANNEL_KINDS（UI 与契约不得漂移）', async () => {
  const { CHANNEL_KINDS } = await import('../src/provider/types.ts')
  const match = /KIND_VALUES = \[([^\]]+)\]/.exec(source)
  assert.ok(match !== null, 'client.js 应有 KIND_VALUES 常量')
  const values = (match[1] as string)
    .split(',')
    .map((part) => part.trim().replace(/^['"]/, '').replace(/['"]$/, ''))
    .filter((value) => value !== '')
  // 曾经的缺陷：openai-responses 不在下拉里，用户只能选同步出图，
  // 而站点恰好只放行了 Responses 路径 —— 真机上一出图就是 403 HTML。
  assert.deepEqual([...values].sort(), [...CHANNEL_KINDS].sort())
  assert.ok(values.includes('openai-responses'))
  // 类型下拉必须是带说明的选项，并且由 kindOptions() 生成
  assert.ok(source.includes("select('kind', t('kind'), draft.kind, kindOptions()"))
  assert.ok(source.includes('kindHint'), '选项应带本地化说明，而不是裸 id')
  // select() 必须支持 { value, label } 形态的选项
  assert.ok(source.includes('optionValue'))
  // 下拉箭头自绘：原生箭头画在 padding 里贴边，appearance:none + mask chevron 才可控
  assert.ok(source.includes('kimg-selectwrap'), '下拉应有 wrapper 以承载自绘箭头')
  assert.ok(source.includes('appearance:none'), '应去掉原生箭头')
  assert.ok(/CHEVRON/.test(source), '箭头应使用内联 SVG mask，颜色跟随主题')
})

test('设置页面板真实渲染：类型下拉列出 openai-responses，且渲染不抛异常', async () => {
  const elements: Array<{ type: unknown; props: Record<string, unknown>; children: unknown[] }> = []
  const store: unknown[] = []
  let cursor = 0
  const effects: Array<() => void> = []
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      const resolved = (props || {}) as Record<string, unknown>
      if (typeof type === 'function') {
        // 迷你渲染器：函数组件必须真的执行——设置页里的页签面板是子组件，
        // 只记录 createElement 节点的话永远渲染不到表单/工坊。
        elements.push({ type: (type as { name?: string }).name || 'Component', props: resolved, children })
        return (type as (input: Record<string, unknown>) => unknown)(resolved)
      }
      const node = { type, props: resolved, children }
      elements.push(node)
      return node
    },
    useState: (initial: unknown) => {
      const slot = cursor
      cursor += 1
      if (store[slot] === undefined) store[slot] = initial
      return [
        store[slot],
        (next: unknown) => {
          store[slot] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(store[slot]) : next
        },
      ]
    },
    useEffect: (fn: () => void) => { effects.push(fn) },
    useCallback: (fn: unknown) => fn,
  }
  const settings = {
    defaultChannelId: '', defaultModel: '', defaultAspectRatio: '3:4', defaultResolution: '1k',
    defaultFormat: 'png', defaultCount: 1, concurrency: 2, globalNegative: [], budgetConfirmCny: 10,
    cacheEnabled: true, cacheDir: '', cacheMaxEntries: 200,
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options: { factory: (require: (name: string) => unknown) => unknown }) {
          captured = options.factory((name: string) => (name === 'react' ? react : {}))
        },
      },
    },
    navigator: { language: 'zh-CN' },
    document: { getElementById: () => null, createElement: () => ({ textContent: '', parentNode: null }), head: { appendChild: () => undefined } },
    console,
    fetch: () => Promise.resolve({
      json: () => Promise.resolve({ ok: true, value: {
        channels: [{
          id: 'channel', label: '天域', kind: 'openai-images', baseUrl: 'https://tianyuai.lol',
          apiKey: 'sk-\u2022\u2022\u2022\u2022siA', hasKey: true, models: ['gpt-image-2'],
          sizeStyle: 'ratio-resolution', enabled: true,
        }],
        settings, spend: { total: 0, currency: 'CNY', images: 0, entries: 0 },
        cache: { entries: 0, hits: 0, dir: '' }, projects: [],
      } }),
    }),
  }
  let captured: unknown
  vm.runInNewContext(readFileSync(join(ROOT, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })
  const mod = captured as { apply: (ctx: unknown) => void }
  const registered: Array<Record<string, unknown>> = []
  mod.apply({
    effect: (register: () => unknown) => register(),
    slots: {
      inject: (_seat: string, register: () => unknown) => register(),
      register: (options: Record<string, unknown>, component?: unknown) => {
        registered.push({ ...options, component })
        return () => undefined
      },
    },
  })
  const component = registered[0]?.['component'] as (() => unknown) | undefined
  assert.equal(typeof component, 'function')

  // 第一遍渲染：loading 态，只挂副作用
  cursor = 0
  effects.length = 0
  component?.()
  for (const run of effects) run()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  // 第二遍渲染：ready 态，表单全部展开
  elements.length = 0
  cursor = 0
  effects.length = 0
  assert.doesNotThrow(() => { component?.() }, '设置页面板必须能渲染（kindOptions 未定义之类会炸整页）')

  const optionValues = elements
    .filter((node) => node.type === 'option')
    .map((node) => node.props['value'])
  assert.ok(optionValues.includes('openai-responses'), '类型下拉必须能选到 openai-responses')
  const responsesOption = elements.find((node) => node.type === 'option' && node.props['value'] === 'openai-responses')
  const label = String(responsesOption?.children[0] ?? '')
  assert.ok(label.includes('openai-responses'))
  assert.ok(label.includes('image_generation'), '选项应带说明，提示这是图片模型的真实形态')
  // 表单里已有「探测时小额实跑」勾选框，所以按字段名与默认值定位，不数个数
  const autoField = elements.find((node) => node.props['key'] === 'autoFallback')
  assert.ok(autoField !== undefined, '表单应有自动回退字段')
  const autoCheckbox = elements.find(
    (node) => node.type === 'input' && node.props['type'] === 'checkbox' && node.props['checked'] === true,
  )
  assert.ok(autoCheckbox !== undefined, '自动回退勾选框默认应为选中')
  // 通道行上要有编辑入口（否则改类型只能删了重建）
  const buttonLabels = elements
    .filter((node) => node.type === 'button')
    .map((node) => String(node.children[0] ?? ''))
  assert.ok(buttonLabels.includes('编辑'), '通道行应有「编辑」按钮，实际：' + buttonLabels.join(' / '))
  assert.ok(buttonLabels.includes('测试通道'))
  // 顺带守住：不能只渲染出空白的根节点
  assert.ok(elements.length > 20, '应渲染出完整面板')
})

test('通道可编辑：编辑按钮把既有通道读进草稿，保存时带 id 原地更新', () => {
  // 不带 id 的 upsert 会另开一条通道；而 Key 永不明文回显，
  // 因此没有编辑入口时，用户「只想改个类型」就只能删了重建、重输密钥。
  assert.ok(source.includes("t('edit')"), '通道行应有编辑按钮')
  assert.ok(source.includes('id: channel.id'), '编辑应把既有通道 id 带进草稿')
  assert.ok(source.includes('{ id: draft.id, label: draft.label'), '保存必须带上草稿 id 才能原地更新')
  assert.ok(source.includes('keepKeyHint'), '应提示 Key 留空即沿用')
  assert.ok(source.includes('cancelEdit'), '应能退出编辑态')
  assert.ok(source.includes('emptyDraft'), '草稿应有统一的初始值')
})

test('自动回退开关：表单里有勾选框，保存时明确传布尔值', () => {
  assert.ok(source.includes("checkbox('autoFallback'"), '表单应有自动回退勾选框')
  assert.ok(source.includes('autoFallback: draft.autoFallback === true'), '保存必须传明确的布尔值')
  assert.ok(source.includes('autoFallback: channel.autoFallback !== false'), '编辑预填须把缺省视为开启')
  assert.ok(source.includes("t('autoFallback')"), '文案要能本地化')
})

test('测试通道的结果里带上端点可达性证据', () => {
  assert.ok(source.includes('value.route.images.path'), '测试通道应显示生成路径的路由结论')
  assert.ok(source.includes('value.route.responses.state'))
})

test('卡片走插件自家 fenced API，凭据输入为 password 且源码无密钥字面量', () => {
  assert.ok(source.includes('/dsh-kylin-images/api'))
  assert.ok(!/sk-[a-zA-Z0-9]{8,}/.test(source), 'client.js 不应出现任何形似密钥的字面量')
  assert.ok(source.includes('password'), 'API Key 输入应为 password 类型')
})

test('合并后的设置页：一个菜单里两个页签，切到「漫画项目」渲染工坊', async () => {
  type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] }
  const elements: Node[] = []
  const store: unknown[] = []
  const effects: Array<() => void> = []
  let cursor = 0
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      const resolved = (props || {}) as Record<string, unknown>
      if (typeof type === 'function') {
        // 迷你渲染器：函数组件必须真的执行——设置页里的页签面板是子组件，
        // 只记录 createElement 节点的话永远渲染不到表单/工坊。
        elements.push({ type: (type as { name?: string }).name || 'Component', props: resolved, children })
        return (type as (input: Record<string, unknown>) => unknown)(resolved)
      }
      const node = { type, props: resolved, children }
      elements.push(node)
      return node
    },
    useState: (initial: unknown) => {
      const slot = cursor
      cursor += 1
      if (store[slot] === undefined) store[slot] = initial
      return [
        store[slot],
        (next: unknown) => {
          store[slot] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(store[slot]) : next
        },
      ]
    },
    useEffect: (fn: () => void) => { effects.push(fn) },
    useCallback: (fn: unknown) => fn,
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options: { factory: (require: (name: string) => unknown) => unknown }) {
          captured = options.factory((name: string) => (name === 'react' ? react : {}))
        },
      },
    },
    navigator: { language: 'zh-CN' },
    document: { getElementById: () => null, createElement: () => ({ textContent: '', parentNode: null }), head: { appendChild: () => undefined } },
    console,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: [] }) }),
  }
  let captured: unknown
  vm.runInNewContext(readFileSync(join(ROOT, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })
  const mod = captured as { apply: (ctx: unknown) => void }
  const registered: Array<Record<string, unknown>> = []
  mod.apply({
    effect: (register: () => unknown) => register(),
    slots: {
      inject: (_seat: string, register: () => unknown) => register(),
      register: (options: Record<string, unknown>, component?: unknown) => {
        registered.push({ ...options, component })
        return () => undefined
      },
    },
  })
  const component = registered[0]?.['component'] as (() => unknown) | undefined
  assert.equal(typeof component, 'function')

  // 首屏：页签条 + 默认的「视觉模型」配置页
  cursor = 0
  elements.length = 0
  effects.length = 0
  assert.doesNotThrow(() => { component?.() })
  const tabs = elements.find((node) => node.props['role'] === 'tablist')
  assert.ok(tabs !== undefined, '合并后的设置页应有页签条')
  const tabLabels = elements.filter((node) => node.props['role'] === 'tab').map((node) => String(node.children[0] ?? ''))
  assert.deepEqual(tabLabels, ['视觉模型', '漫画项目'])
  assert.deepEqual(
    elements.filter((node) => node.props['role'] === 'tab').map((node) => node.props['data-active']),
    ['true', 'false'],
    '默认停在视觉模型页',
  )
  // 首屏是 loading 态，跑完副作用再渲染一次才拿到表单
  for (const run of effects) run()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  cursor = 0
  elements.length = 0
  effects.length = 0
  assert.doesNotThrow(() => { component?.() })
  assert.ok(
    elements.some((node) => String(node.children[0] ?? '').includes('决定「用什么画')),
    '默认页应是视觉模型配置',
  )

  // 切到「漫画项目」：同一菜单内换页，而不是第二个导航项
  const projectsTab = elements.find((node) => node.props['role'] === 'tab' && String(node.children[0] ?? '') === '漫画项目')
  ;(projectsTab?.props['onClick'] as (() => void) | undefined)?.()
  // 换页后子组件重新挂载：只保留页签自身的 state（slot 0）
  store.length = 1
  cursor = 0
  elements.length = 0
  effects.length = 0
  assert.doesNotThrow(() => { component?.() })
  for (const run of effects) run()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  cursor = 0
  elements.length = 0
  assert.doesNotThrow(() => { component?.() })
  assert.ok(
    elements.some((node) => String(node.children[0] ?? '').includes('还没有漫画项目')),
    '工坊页应渲染项目列表（空态）',
  )
})
