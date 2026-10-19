/**
 * 会话内「故障转移通知」条的渲染回归（client.js 的 FailoverNoticeDock）。
 *
 * 为什么单独有这一支：`smoke-config.mjs` 只覆盖 Host 半的 `/notices` 取数，
 * 客户端半仅做了一次字符串包含检查。而 DSH 的 slot 边界**会吞掉渲染期异常**
 * （组件抛错 → 该 entry 被 abdicate，界面上就是「什么都没出现」，控制台之外
 * 没有线索），所以「看不见通知」既可能是没数据，也可能是组件渲染崩了。
 *
 * 本支用最小 React 运行时（useState/useEffect/createElement）真实渲染该组件：
 *   1. 无通知 → 返回 null（设计上就该隐形，而不是空白条）
 *   2. 有通知 → 渲染出标题 + 最新一条的人话描述
 *   3. 多条   → 出现「展开 N 条」，展开后列出全部
 *   4. 取数失败 → 隐形（不抛错、不留下半截条）
 *   5. 各类通知（failover / retry / manual-switch / test / startup-align）都能格式化，不抛错
 *
 * 运行：node probe/client-dock.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))

let failures = 0
function check(name, condition, detail) {
  if (condition === true) {
    console.log('  ok   ' + name)
  } else {
    failures += 1
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
  }
}

// --------------------------------------------------------------------------
// 最小 React 运行时：只实现该组件用到的 createElement + 四个 Hook。
// --------------------------------------------------------------------------

let current = null
function hookSlot(index, initial) {
  const state = current
  if (!(index in state.hooks)) state.hooks[index] = initial
  return state.hooks[index]
}
const hooks = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props === null || props === undefined ? {} : props)
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const index = current.index
    current.index += 1
    const state = current
    const value = hookSlot(index, initial)
    return [value, (next) => {
      const resolved = typeof next === 'function' ? next(state.hooks[index]) : next
      if (resolved !== state.hooks[index]) {
        state.hooks[index] = resolved
        state.dirty = true
      }
    }]
  },
  useRef(initial) {
    const index = current.index
    current.index += 1
    return hookSlot(index, { current: initial })
  },
  useMemo(factory) {
    current.index += 1
    return factory()
  },
  useCallback(fn) {
    current.index += 1
    return fn
  },
  useEffect(fn, deps) {
    const index = current.index
    current.index += 1
    const previous = current.deps[index]
    const changed = previous === undefined || deps === undefined || deps.length !== previous.length
      || deps.some((value, at) => value !== previous[at])
    if (changed !== true) return
    current.deps[index] = deps === undefined ? undefined : deps.slice()
    current.effects.push(fn)
  },
}

/** 挂载一个无状态容器组件，并按需重渲染到不再置脏。 */
function mount(Component, props) {
  const instance = { hooks: [], deps: {}, effects: [], index: 0, dirty: false, tree: undefined }
  instance.render = () => {
    current = instance
    instance.index = 0
    instance.effects = []
    instance.tree = Component(props)
  }
  instance.runEffects = () => {
    const pending = instance.effects
    instance.effects = []
    for (const fn of pending) fn()
  }
  instance.settle = async () => {
    instance.render()
    instance.runEffects()
    // 组件的取数是异步的（await fetch → setNotices）：先让出一个宏任务把微任务队列
    // 排空，再看是否置脏。同步检查 dirty 会永远读到 false，导致「有数据也渲染不出来」
    // 这种假失败。
    for (let round = 0; round < 10; round += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      if (instance.dirty !== true) break
      instance.dirty = false
      instance.render()
      instance.runEffects()
    }
    return instance.tree
  }
  return instance
}

// --------------------------------------------------------------------------
// 载入 client.js：假 window/document/fetch，捕获 slot 注册。
// --------------------------------------------------------------------------

function loadClient(fetchImpl) {
  let definition
  const documentStub = {
    head: { appendChild() {} },
    createElement() {
      return { parentNode: null, setAttribute() {}, textContent: '' }
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value } } },
    document: documentStub,
    fetch: fetchImpl,
    AbortSignal,
    setInterval: () => 0,
    clearInterval() {},
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath })
  if (definition === undefined) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  const loaded = definition.factory((specifier) => {
    if (specifier === 'react') return hooks
    throw new Error('client.js 请求了未预期的模块：' + String(specifier))
  })
  const registered = []
  const ctx = {
    effect(fn) { const dispose = fn(); return dispose },
    slots: {
      inject(key, callback) { return callback() },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  loaded.apply(ctx)
  const dock = registered.find((entry) => entry.options.name === 'conversation.input.dock')
  return { dock, registered, exportsOf: loaded }
}

const NOTICE = {
  noticeId: 'n1',
  at: Date.UTC(2026, 9, 19, 2, 11, 2),
  session: 'session-test',
  kind: 'failover',
  stage: 'selected',
  code: 'AUTH',
  trigger: 'agent/request-error',
  fromRoute: 'tokeniss',
  fromModel: 'claude-opus-5-5',
  toRoute: 'codex-relay',
  toModel: 'gpt-6.1-sol',
  tier: 1,
  reasoningEffort: 'high',
  turn: 3,
  step: 1,
  reasonId: 'insufficient-balance',
  reasonLabel: '余额不足',
  detail: '预扣费额度失败, 用户剩余额度: ¥1.04',
}

function textOf(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  const props = tree.props === undefined ? {} : tree.props
  const children = props.children === undefined ? [] : props.children
  return [props.className === undefined ? '' : String(props.className), textOf(children)].join(' ')
}

/** 以「取数返回指定通知」的假 fetch 挂载通知条。 */
async function renderDock(notices, options) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (options !== undefined && options.fail === true) {
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-test', notices, latest: notices[0] ?? null, count: notices.length }) }
  }
  const { dock } = loadClient(fetchImpl)
  const instance = mount(dock.component, { sessionId: 'session-test', session: { id: 'session-test' }, input: {} })
  const tree = await instance.settle()
  return { tree, instance, calls, dock }
}

console.log('会话内通知条（client.js FailoverNoticeDock）:')

// 1) 无通知 → 隐形
{
  const { tree, calls, dock } = await renderDock([])
  check('注册在 conversation.input.dock（session 作用域）',
    dock !== undefined && dock.options.name === 'conversation.input.dock' && dock.options.order === 30)
  check('inject 回调把 sessionId 交给组件',
    typeof dock.options.inject === 'function' && dock.options.inject('session-test').sessionId === 'session-test')
  check('取数走 /provider-failover/notices?sessionId=…',
    calls.length === 1 && calls[0] === '/provider-failover/notices?sessionId=session-test&limit=20', JSON.stringify(calls))
  check('无通知时不渲染任何东西（设计上隐形，而非空白条）', tree === null, JSON.stringify(tree))
}

// 2) 一条通知 → 标题 + 人话描述
{
  const { tree } = await renderDock([NOTICE])
  const text = textOf(tree)
  check('有通知时渲染出「故障转移通知」标题', text.includes('故障转移通知'), text.slice(0, 200))
  check('描述里带原因细分（余额不足）而非只写 AUTH', text.includes('余额不足'), text.slice(0, 300))
  check('描述里带 from → to 与档位 / effort / turn-step', text.includes('tokeniss') && text.includes('codex-relay') && text.includes('档 1') && text.includes('effort') && text.includes('turn 3'), text.slice(0, 300))
  check('描述里带脱敏后的上游原文（可自查）', text.includes('剩余额度'), text.slice(0, 300))
}

// 3) 多条 → 展开入口，点开列出全部
{
  const second = Object.assign({}, NOTICE, { noticeId: 'n2', kind: 'retry', code: 'TRANSPORT', reasonLabel: '传输中断', fromModel: '', toModel: '', tier: -1 })
  const { tree, instance } = await renderDock([second, NOTICE])
  const collapsed = textOf(tree)
  check('多条时出现「展开 2 条」', collapsed.includes('展开 2 条'), collapsed.slice(0, 200))
  const head = tree.props.children[0]
  head.props.onClick()
  const expanded = await instance.settle()
  const expandedText = textOf(expanded)
  check('点开后列出两条（含原地重试那条）', expandedText.includes('原地重试') && expandedText.includes('故障转移') && expandedText.includes('收起'), expandedText.slice(0, 300))
}

// 4) 取数失败 → 隐形且不抛错
{
  const { tree } = await renderDock([NOTICE], { fail: true })
  check('接口失败时不渲染半截条，也不抛错', tree === null, JSON.stringify(tree))
}

// 5) 各类通知都能格式化（任何一种抛错都会让整条通知消失）
{
  const kinds = [
    Object.assign({}, NOTICE, { kind: 'failover' }),
    Object.assign({}, NOTICE, { kind: 'failover', stage: 'startup-align', code: 'STARTUP_ALIGN' }),
    Object.assign({}, NOTICE, { kind: 'retry', code: 'TRANSPORT', tier: -1 }),
    Object.assign({}, NOTICE, { kind: 'manual-switch', code: 'MANUAL' }),
    Object.assign({}, NOTICE, { kind: 'manual-switch', code: 'TEST', trigger: '/failover-test' }),
    // 字段缺失的兜底（历史条目可能没有 reasonLabel / detail / tier）
    { noticeId: 'n3', at: 0, kind: 'failover', fromRoute: 'r1', toRoute: 'r2', turn: 0, step: 0 },
  ]
  let rendered = ''
  let threw = ''
  try {
    for (const notice of kinds) rendered += textOf((await renderDock([notice])).tree)
  } catch (error) {
    threw = String(error && error.message)
  }
  check('failover / startup-align / retry / manual-switch / test / 缺字段 都能渲染', threw === '' && rendered.includes('启动对齐') && rendered.includes('手动切换') && rendered.includes('测试切换') && rendered.includes('原地重试') && rendered.includes('未知原因'), threw === '' ? rendered.slice(0, 300) : threw)
}

console.log(failures === 0 ? '\nALL PASSED' : '\nFAILURES: ' + String(failures))
process.exitCode = failures === 0 ? 0 : 1
