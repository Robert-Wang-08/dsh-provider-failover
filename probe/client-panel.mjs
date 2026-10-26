import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * 设置页「Provider 故障转移」面板渲染回归。
 *
 * 存在的理由（沿用本仓库既有教训）：字符串级冒烟区分不出「没数据」和「渲染崩了」，
 * 而 DSH 的 slot 边界会吞掉渲染期异常 —— 之前正是这样漏掉过
 * `Cannot access 'runTestSwitch' before initialization` 造成的整块空白。
 * 这里用最小 React 运行时按 useState 调用顺序预置状态，真实执行面板渲染函数，
 * 校验多 key 卡片在有/无非法草稿两种情况下的输出。
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

let definition
const sandbox = {
  window: { __ModuleLoader__: { load(value) { definition = value } } },
  document: { head: { appendChild() {} }, createElement() { return { parentNode: null, setAttribute() {}, textContent: '' } } },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
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

/** 把渲染树摊平成文本，便于断言「界面上真的出现了这句话」。 */
function flatten(node, out) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node) === true) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object') {
    // 注册的插槽组件是函数组件：真正执行它，才能覆盖渲染期异常（TDZ、undefined 解引用）。
    if (typeof node.type === 'function') return flatten(node.type(node.props ?? {}), out)
    const props = node.props ?? {}
    if (props.title !== undefined) out.push('[title:' + String(props.title) + ']')
    // 受控输入框的可见内容在 value 上，不在 children 上。
    if (node.type === 'input' && typeof props.value === 'string' && props.value.length > 0) out.push('[value:' + props.value + ']')
    flatten(props.children, out)
  }
  return out
}

/** 面板的 form/keyDraft 是 load() 的结果；无异步时按快照推导，塞进 useState 的预置队列。 */
function draftOf(status) {
  const draft = {}
  for (const tier of status.tiers) {
    for (const entry of tier.entries) {
      const declared = status.editable.keysByEntry === undefined ? undefined : status.editable.keysByEntry[entry.id]
      draft[entry.id] = Array.isArray(declared) ? declared.slice() : entry.keys.map((item) => item.ref)
    }
  }
  return draft
}

function renderPanel(status, catalog) {
  const form = { ...status.editable }
  let seed = [status, catalog, form, draftOf(status)]
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    // 面板的 useState 调用顺序固定：前两个是 status/catalog，其余取默认值。
    useState: (initial) => {
      const value = seed.length > 0 ? seed.shift() : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
  const plugin = definition.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error('unexpected module: ' + specifier)
  })
  let panel = null
  plugin.apply({
    effect(fn) { return fn() },
    slots: {
      inject(name, callback) { return callback() },
      register(options, component) {
        if (options.name === 'settings.section') panel = component
        return () => {}
      },
    },
  })
  if (panel === null) throw new Error('settings.section 未注册')
  return flatten(react.createElement(panel, null), []).join(' | ')
}

const baseEditable = {
  enabled: true,
  minSwitchIntervalMs: 1000,
  maxSwitchesPerTurn: 6,
  startupPreferTier: 0,
  rankingMode: 'declared',
  rankingModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  defaultModel: { provider: 'ais-2dsglm', model: 'deepseek-v4.1-flash' },
  defaultModelAvailable: true,
  keyResetAt: '06:00',
}

const statusOf = (keysByEntry, keys) => ({
  ok: true,
  enabled: true,
  writable: true,
  keyResetAt: '06:00',
  nextKeyResetAt: Date.now() + 3600000,
  lastSessionId: 'session-1',
  editable: { ...baseEditable, keysByEntry },
  testTargets: [{ id: 'ais', route: 'ais-2dsglm', model: 'deepseek-v4.1-flash', tier: 1 }],
  pins: [],
  tiers: [{
    tier: 1,
    enabled: true,
    entries: [{
      id: 'ais',
      route: 'ais-2dsglm',
      model: 'deepseek-v4.1-flash',
      registered: true,
      cooling: false,
      activeRef: 'AIS_2DSGLM_API_KEY',
      keysSource: keysByEntry === undefined ? 'patch' : 'settings',
      keys,
    }],
  }],
  providers: { registered: [{ id: 'ais-2dsglm', name: 'AIS 2DSGLM' }], configurable: [], unassigned: [], missing: [] },
  switches: [],
  ignored: [],
  cooling: [],
})
// 面板里的 catalog 是 load() 摊平后的 provider 数组（不是接口原始 {providers} 形状）。
const catalog = [{ id: 'ais-2dsglm', name: 'AIS 2DSGLM', models: [{ id: 'deepseek-v4.1-flash', name: 'DS 4.1 Flash' }] }]

console.log('设置页 key 卡片渲染回归:')

let text = ''
try {
  text = renderPanel(statusOf({}, [{ ref: 'AIS_2DSGLM_API_KEY', active: true, configured: true, source: 'env', failed: false }]), catalog)
  check('面板整体渲染不抛错', text.length > 0)
} catch (error) {
  check('面板整体渲染不抛错', false, String(error && error.message))
}

check('渲染出多 key 卡片说明与命名规则', text.includes('单 provider 多 key') && text.includes('不能以数字开头'))
check('渲染出已保存 key 行与来源徽标', text.includes('AIS_2DSGLM_API_KEY') && text.includes('在用'))
check('渲染出添加按钮', text.includes('+ 添加 key 引用'))
check('无改动时不提示未保存', text.includes('有未保存的 key 改动') === false)

try {
  text = renderPanel(statusOf({ ais: ['bad-name'] }, [{ ref: 'bad-name', active: true, configured: false, failed: false }]), catalog)
  check('非法草稿渲染出保持不崩', text.length > 0)
} catch (error) {
  check('非法草稿渲染出保持不崩', false, String(error && error.message))
}
check('非法草稿在行内标红', text.includes('只能使用字母、数字、下划线'))
check('非法草稿给出待修正计数', text.includes('有 1 处待修正'))
check('未配置引用给出缺值说明', text.includes('缺的是值'))

try {
  text = renderPanel(statusOf({ ais: ['AIS_2DSGLM_API_KEY', 'AIS_2DSGLM_API_KEY_2'] }, [
    { ref: 'AIS_2DSGLM_API_KEY', active: true, configured: true, source: 'env', failed: false },
    { ref: 'AIS_2DSGLM_API_KEY_2', active: false, configured: false, failed: false },
  ]), catalog)
  check('多 key 快照渲染两行', text.includes('AIS_2DSGLM_API_KEY') && text.includes('AIS_2DSGLM_API_KEY_2'))
} catch (error) {
  check('多 key 快照渲染两行', false, String(error && error.message))
}
check('多 key 快照无行内错误', text.includes('待修正') === false)

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + String(failures.length))
process.exitCode = failures.length === 0 ? 0 : 1
