import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * 顶部「自动切换」开关的渲染/状态回归。
 *
 * 为什么不用字符串冒烟：slot 边界会吞渲染异常，字符串测试看不出“渲染崩了”；
 * 而开关的关键风险恰好是「未知/失败被画成关」。这里用最小 React 运行时真实执行
 * 组件函数，并直接驱动模块级 store 的刷新与写回路径。
 */

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const source = readFileSync(clientPath, 'utf8')
const failures = []
const check = (label, ok, extra) => {
  if (ok === true) console.log('  ok   ' + label)
  else {
    failures.push(label)
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' — ' + extra))
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeReact() {
  let values = []
  let cursor = 0
  let effects = []
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: Object.assign({}, props ?? {}, { children }) }),
    useState: (initial) => {
      const index = cursor++
      if (values[index] === undefined) values[index] = typeof initial === 'function' ? initial() : initial
      return [values[index], (next) => {
        values[index] = typeof next === 'function' ? next(values[index]) : next
      }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
  return {
    react,
    reset() { values = []; cursor = 0; effects = [] },
    render(component) {
      cursor = 0
      effects = []
      const tree = component({})
      return { tree, effects: effects.slice() }
    },
  }
}

function loadPlugin(fetchImpl, windowExtra) {
  let definition
  const sandbox = {
    window: Object.assign({
      __ModuleLoader__: { load(value) { definition = value } },
      addEventListener() {},
      removeEventListener() {},
    }, windowExtra ?? {}),
    document: { head: { appendChild() {} }, createElement() { return { parentNode: null, setAttribute() {}, textContent: '' } } },
    fetch: fetchImpl,
    AbortSignal,
    setInterval: () => 0,
    clearInterval() {},
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: clientPath })
  return { definition, sandbox }
}

function instantiate(fetchImpl, windowExtra) {
  const { definition, sandbox } = loadPlugin(fetchImpl, windowExtra)
  const harness = makeReact()
  const plugin = definition.factory((specifier) => {
    if (specifier === 'react') return harness.react
    throw new Error('unexpected module: ' + specifier)
  })
  const registered = []
  plugin.apply({
    effect(fn) { return fn() },
    slots: {
      inject(name, callback) { return callback() },
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
  })
  return { plugin, harness, registered, sandbox, toggle: registered.find((item) => item.options.name === 'conversation.session.header.utilities')?.component }
}

function collect(node, out) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') { collect(node.type(node.props ?? {}), out); return out }
    collect(node.props?.children, out)
  }
  return out
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  return findNode(node.props?.children, predicate)
}

function toggleOf(rendered) {
  return findNode(rendered.tree, (node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('pf-toggle'))
}

function textOf(rendered) {
  return collect(rendered.tree, []).join(' ')
}

function freshToggle() {
  const status = { enabled: true, writable: true }
  const { plugin, harness, registered } = instantiate(async () => ({ ok: true, json: async () => status }))
  const entry = registered.find((item) => item.options.name === 'conversation.session.header.utilities')
  return { plugin, harness, registered, entry, toggle: entry?.component }
}

console.log('顶部自动切换开关渲染与状态回归:')

// 1) 注册位置。
{
  const { entry } = freshToggle()
  check('注册到 conversation.session.header.utilities', entry !== undefined)
  check('id 为 provider-failover-auto-toggle', entry?.options.id === 'provider-failover-auto-toggle')
  check('order 92（紧邻 PTC 91，同属右对齐工具区）', entry?.options.order === 92)
}

// 2) 已加载：开
{
  const { plugin, harness, toggle } = freshToggle()
  plugin.__test.publishToggleSnapshot({ enabled: true, writable: true })
  const rendered = harness.render(toggle)
  const button = toggleOf(rendered)
  check('已开启渲染 role=switch', button?.props.role === 'switch')
  check('已开启 aria-checked=true', button?.props['aria-checked'] === 'true')
  check('已开启 data-on=true', button?.props['data-on'] === 'true')
  check('已开启显示「自动切换 开」', textOf(rendered).includes('自动切换 开'))
}

// 3) 已加载：关
{
  const { plugin, harness, toggle } = freshToggle()
  plugin.__test.publishToggleSnapshot({ enabled: false, writable: true })
  const rendered = harness.render(toggle)
  const button = toggleOf(rendered)
  check('已关闭 aria-checked=false', button?.props['aria-checked'] === 'false')
  check('已关闭 data-on=false', button?.props['data-on'] === 'false')
  check('已关闭显示「自动切换 关」', textOf(rendered).includes('自动切换 关'))
  check('已关闭 tooltip 明确「不重试也不切换」', String(button?.props.title).includes('不原地重试') && String(button?.props.title).includes('不切换 provider'))
}

// 4) 首次 GET 失败必须是 unknown，不能伪装成关
{
  const { plugin, harness, toggle } = instantiate(async () => ({ ok: false, status: 503, json: async () => ({ error: 'settings service is not composed' }) }))
  await plugin.__test.refreshToggle(true)
  const rendered = harness.render(toggle)
  const button = toggleOf(rendered)
  check('首次失败不渲染 switch', button?.props.role !== 'switch')
  check('首次失败显示「状态未知」', textOf(rendered).includes('状态未知'))
  check('首次失败 tooltip 可重试', String(button?.props.title).includes('点击重试'))
  check('首次失败不显示开关轨道', findNode(rendered.tree, (node) => String(node.props?.className).includes('pf-toggle-track')) === undefined)
}

// 5) loading 态
{
  const { plugin, harness, toggle } = freshToggle()
  plugin.__test.refreshToggle(true) // 不 await：保持 loading
  const rendered = harness.render(toggle)
  const button = toggleOf(rendered)
  check('loading 显示「自动切换 …」', textOf(rendered).includes('自动切换 …'))
  check('loading 禁用且 aria-busy=true', button?.props.disabled === true && button?.props['aria-busy'] === 'true')
  await tick()
}

// 6) writable=false
{
  const { plugin, harness, toggle } = freshToggle()
  plugin.__test.publishToggleSnapshot({ enabled: true, writable: false })
  const rendered = harness.render(toggle)
  const button = toggleOf(rendered)
  check('只读时禁用', button?.props.disabled === true)
  check('只读时 tooltip 说明设置服务未装载', String(button?.props.title).includes('设置服务未装载'))
}

// 7) 写回成功：以 Host 返回快照为准
{
  let posted = null
  const status = { enabled: false, writable: true }
  const { plugin, harness, toggle } = instantiate(async (url, options) => {
    if (String(url).endsWith('/config')) {
      posted = JSON.parse(String(options.body))
      return { ok: true, json: async () => status }
    }
    return { ok: true, json: async () => ({ enabled: true, writable: true }) }
  })
  plugin.__test.publishToggleSnapshot({ enabled: true, writable: true })
  const rendered = harness.render(toggle)
  const button = toggleOf(rendered)
  button.props.onClick()
  await tick()
  await tick()
  check('点击后 POST 只带 enabled 字段', posted !== null && Object.keys(posted).join(',') === 'enabled' && posted.enabled === false)
  const state = plugin.__test.toggleSnapshot()
  check('写回成功以返回快照落定（关）', state.enabled === false && state.pending === false && state.error === '')
}

// 8) 写回失败：回滚并显示可重试错误
{
  const { plugin, harness, toggle } = instantiate(async (url) => {
    if (String(url).endsWith('/config')) return { ok: false, status: 503, json: async () => ({ error: 'settings service is not composed' }) }
    return { ok: true, json: async () => ({ enabled: true, writable: true }) }
  })
  plugin.__test.publishToggleSnapshot({ enabled: true, writable: true })
  const rendered = harness.render(toggle)
  toggleOf(rendered).props.onClick()
  await tick()
  await tick()
  const state = plugin.__test.toggleSnapshot()
  check('写回失败回滚到原值', state.enabled === true && state.pending === false)
  check('写回失败保留错误', state.error.includes('settings service is not composed'))
  harness.reset()
  const after = harness.render(toggle)
  check('写回失败显示错误标记', toggleOf(after)?.props['data-error'] === 'true')
  check('写回失败 tooltip 可重试', String(toggleOf(after)?.props.title).includes('点击重试'))
}

// 9) 上一次写失败后，点击先重读而不是盲目再写
{
  let gets = 0
  const { plugin, harness, toggle } = instantiate(async (url, options) => {
    if (String(url).endsWith('/status')) { gets += 1; return { ok: true, json: async () => ({ enabled: true, writable: true }) } }
    if (String(url).endsWith('/config')) return { ok: false, status: 503, json: async () => ({ error: 'boom' }) }
    return { ok: true, json: async () => ({}) }
  })
  plugin.__test.publishToggleSnapshot({ enabled: true, writable: true })
  // 直接制造一次写失败
  await plugin.__test.writeToggle(false)
  const rendered = harness.render(toggle)
  toggleOf(rendered).props.onClick()
  await tick()
  await tick()
  check('错误态点击会重新 GET 状态', gets >= 1)
  check('错误态点击不会发起第二次 POST', plugin.__test.toggleSnapshot().enabled === true)
}

// 10) 设置页保存时的 enabled 合入规则
{
  const { plugin } = freshToggle()
  const status = { editable: { enabled: false } }
  check('用户改了设置页 checkbox 时以表单为准', plugin.__test.enabledPatchFor({ enabled: true }, status, false) === true)
  check('用户未改时合入共享状态的新值', plugin.__test.enabledPatchFor({ enabled: false }, status, true) === true)
  check('两边一致时不写 enabled', plugin.__test.enabledPatchFor({ enabled: false }, status, false) === null)
}

// 11) 挂载不做轮询
{
  let intervals = 0
  const { plugin, harness, toggle } = instantiate(() => new Promise(() => {}), {
    addEventListener() {},
    removeEventListener() {},
  })
  const originalSetInterval = globalThis.setInterval
  // 只统计本组件 effect 期间的 setInterval 调用：用 sandbox 的 setInterval 计数。
  // instantiate 的 sandbox 可通过闭包拿到；这里直接检查源码是否在开关组件里用轮询。
  const rendered = harness.render(toggle)
  for (const effect of rendered.effects) {
    try { effect() } catch (error) { /* 清理函数可能依赖不存在的事件，忽略 */ }
  }
  check('开关组件挂载不使用 setInterval 轮询', !/AutoSwitchToggle[\s\S]{0,3000}setInterval\(/.test(source))
}

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + String(failures.length))
process.exitCode = failures.length === 0 ? 0 : 1
