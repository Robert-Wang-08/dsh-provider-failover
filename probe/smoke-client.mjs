import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

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

console.log('client.js 设置面板冒烟:')
check('读取动态模型目录', source.includes('apiFetch(ROUTE + "/catalog")'))
check('渲染排序模型与默认模型标签', source.includes('modelRow("rankingModel", "排序模型"') && source.includes('modelRow("defaultModel", "默认模型"'))
check('provider/model 使用两级下拉', source.includes('setModelPart(key, "provider")') && source.includes('setModelPart(key, "model")'))
check('模型保存走现有 /config 接口', source.includes('saveConfig({ rankingModel: modelSelection("rankingModel"), defaultModel: modelSelection("defaultModel") })'))
check('模型保存失败显示错误', source.includes('setModelError(err.message)') && source.includes('className: "pf-err" }, modelError'))
check('默认模型服务缺失时禁用', source.includes('status.editable.defaultModelAvailable !== true'))
check('无 provider 或无模型时禁用 model 下拉', source.includes('selected.provider.length === 0') && source.includes('options.length === 0'))

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
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}
const plugin = definition.factory((specifier) => {
  if (specifier === 'react') return react
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
check('设置区仍注册到 settings.section', registered.some((item) => item.options.name === 'settings.section' && item.options.id === 'provider-failover'))

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + String(failures.length))
process.exitCode = failures.length === 0 ? 0 : 1
